import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type AccountProfile,
  type AgentEvent,
  type AgentLaunch,
  type AgentSessionHandle,
  type Capabilities,
  CrewError,
  type FailureClass,
  nowIso,
  type ProfileHealth,
  type ProviderAdapter,
  type SessionOutcome,
  trimTrailingSlashes,
  UNKNOWN_USAGE,
  type UsageReport,
} from '@crewyard/core';
import {
  type AdapterOptions,
  arr,
  classifyFailureText,
  classifyHttpStatus,
  createChannel,
  createRedactor,
  health,
  num,
  obj,
  parseJsonLine,
  type SessionResult,
  settingBool,
  settingString,
  str,
  unsupported,
} from '@crewyard/provider-generic';

export const OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

export function ollamaEndpoint(profile: AccountProfile): string {
  return trimTrailingSlashes(settingString(profile, 'endpoint') ?? OLLAMA_DEFAULT_ENDPOINT);
}

export function ollamaIsLoopback(profile: AccountProfile): boolean {
  try {
    const host = new URL(ollamaEndpoint(profile)).hostname;
    return host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return false;
  }
}

export function ollamaCodingEnabled(profile: AccountProfile): boolean {
  return settingBool(profile, 'allowCodingExecution') === true;
}

export interface OllamaChatRequest {
  model: string;
  messages: { role: 'system' | 'user'; content: string }[];
  stream: true;
  format?: Record<string, unknown>;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export function buildOllamaRequest(launch: AgentLaunch): OllamaChatRequest {
  if (launch.mode === 'execute' && !ollamaCodingEnabled(launch.profile)) {
    throw unsupported(
      'ollama',
      'coding execution',
      'Ollama profiles serve planning and review; set settings.allowCodingExecution=true to opt in explicitly.',
    );
  }
  const model = launch.model ?? settingString(launch.profile, 'defaultModel') ?? launch.profile.permittedModels[0];
  if (!model) {
    throw new CrewError('INVALID_INPUT', `Ollama profile ${launch.profile.name} has no model`, {
      suggestion: 'Pass a model or set permitted models / settings.defaultModel on the profile.',
    });
  }
  const options = obj(launch.profile.settings.options);
  const keepAlive = settingString(launch.profile, 'keepAlive');
  return {
    model,
    messages: [
      ...(launch.systemInstructions ? [{ role: 'system' as const, content: launch.systemInstructions }] : []),
      { role: 'user', content: launch.prompt },
    ],
    stream: true,
    ...(launch.outputSchema ? { format: launch.outputSchema } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(keepAlive ? { keep_alive: keepAlive } : {}),
  };
}

export function ollamaUsage(final: Record<string, unknown>, model: string): UsageReport {
  const input = num(final.prompt_eval_count);
  const output = num(final.eval_count);
  if (input === null && output === null) return { ...UNKNOWN_USAGE, model };
  return {
    model,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: null,
    costUsd: null,
    usageSource: 'measured',
    costSource: 'unknown',
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return obj(await response.json());
}

class StopError extends Error {
  constructor(
    readonly outcome: SessionOutcome,
    message: string,
    readonly classification: FailureClass,
  ) {
    super(message);
  }
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id = 'ollama' as const;
  private readonly running = new Map<string, (reason: StopError) => void>();

  constructor(private readonly options: AdapterOptions = {}) {}

  async capabilities(profile: AccountProfile): Promise<Capabilities> {
    let version: string | null = null;
    let detail: string | null = null;
    try {
      version = str((await fetchJson(`${ollamaEndpoint(profile)}/api/version`, 3_000)).version);
    } catch (error) {
      detail = `Ollama endpoint ${ollamaEndpoint(profile)} unreachable: ${(error as Error).message}`;
    }
    const coding = ollamaCodingEnabled(profile);
    return {
      providerId: 'ollama',
      version,
      available: detail === null,
      structuredEvents: true,
      usageReporting: 'measured',
      resume: false,
      cancel: true,
      modelSelection: true,
      profileIsolation: 'none',
      codingAgent: coding,
      planningReview: true,
      notes: [
        'Uses /api/chat; token counts come from prompt_eval_count and eval_count.',
        coding
          ? 'Coding execution is enabled but Ollama has no tool runtime: execute sessions return text only.'
          : 'Coding execution is disabled (settings.allowCodingExecution).',
        ...(detail ? [detail] : []),
      ],
    };
  }

  async validateProfile(profile: AccountProfile): Promise<ProfileHealth> {
    const endpoint = ollamaEndpoint(profile);
    try {
      await fetchJson(`${endpoint}/api/version`, this.options.probeTimeoutMs ?? 5_000);
      const tags = await fetchJson(`${endpoint}/api/tags`, this.options.probeTimeoutMs ?? 5_000);
      const installed = new Set(arr(tags.models).map((m) => str(obj(m).name) ?? ''));
      const missing = profile.permittedModels.filter((m) => !installed.has(m) && !installed.has(`${m}:latest`));
      if (missing.length > 0) return health('degraded', `models not pulled: ${missing.join(', ')}`);
      return health('healthy', `Ollama reachable at ${endpoint} (${installed.size} models)`);
    } catch (error) {
      return health('unavailable', `Ollama endpoint ${endpoint} unreachable: ${(error as Error).message}`);
    }
  }

  async launch(input: AgentLaunch): Promise<AgentSessionHandle> {
    const request = buildOllamaRequest(input);
    if (this.running.has(input.sessionId)) throw new CrewError('CONFLICT', `Session ${input.sessionId} is running`);
    const scrub = createRedactor([]);
    mkdirSync(dirname(input.logPath), { recursive: true, mode: 0o700 });
    const fd = openSync(input.logPath, 'a', 0o600);
    const log = (text: string) => writeSync(fd, `${scrub(text)}\n`);
    const channel = createChannel<AgentEvent>();
    const emit = (event: AgentEvent) => channel.push(event);
    const controller = new AbortController();
    let stopReason: StopError | null = null;
    const stop = (reason: StopError) => {
      if (stopReason) return;
      stopReason = reason;
      controller.abort(reason);
    };
    this.running.set(input.sessionId, stop);
    const timer = setTimeout(
      () => stop(new StopError('timed_out', `Session exceeded its ${input.timeoutMs} ms timeout`, 'unknown')),
      input.timeoutMs,
    );
    emit({ type: 'started', at: nowIso(), pid: null, providerSessionId: null });
    log(`[crew] POST ${ollamaEndpoint(input.profile)}/api/chat model=${request.model} mode=${input.mode}`);

    const done = (async (): Promise<SessionResult> => {
      let text = '';
      let usage: UsageReport = { ...UNKNOWN_USAGE, model: request.model };
      let outcome: SessionOutcome = 'succeeded';
      let bytes = 0;
      try {
        const response = await fetch(`${ollamaEndpoint(input.profile)}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const body = (await response.text()).slice(0, 1_000);
          const message = str(parseJsonLine(body)?.error) ?? (body || `HTTP ${response.status}`);
          throw new StopError('failed', message, classifyHttpStatus(response.status) ?? classifyFailureText(message));
        }
        const decoder = new TextDecoder();
        const consume = (raw: string) => {
          const line = parseJsonLine(raw);
          if (!line) return;
          const error = str(line.error);
          if (error) throw new StopError('failed', error, classifyFailureText(error));
          text += str(obj(line.message).content) ?? '';
          if (line.done === true) usage = ollamaUsage(line, request.model);
        };
        let pending = '';
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > input.maxOutputBytes) {
            throw new StopError('failed', `Output exceeded the ${input.maxOutputBytes} byte limit`, 'policy_violation');
          }
          pending += decoder.decode(chunk, { stream: true });
          let index = pending.indexOf('\n');
          while (index >= 0) {
            consume(pending.slice(0, index));
            pending = pending.slice(index + 1);
            index = pending.indexOf('\n');
          }
        }
        consume(pending + decoder.decode());
      } catch (error) {
        const reason =
          stopReason ??
          (error instanceof StopError
            ? error
            : new StopError('failed', (error as Error).message, classifyFailureText(String(error))));
        outcome = reason.outcome;
        if (outcome !== 'cancelled') {
          emit({ type: 'error', at: nowIso(), message: scrub(reason.message), classification: reason.classification });
        }
        log(`[crew] ${outcome}: ${reason.message}`);
      } finally {
        clearTimeout(timer);
        this.running.delete(input.sessionId);
      }
      const result = text.length > 0 ? scrub(text) : null;
      if (result) {
        log(result);
        emit({ type: 'message', at: nowIso(), role: 'assistant', text: result });
      }
      if (usage.usageSource !== 'unknown') emit({ type: 'usage', at: nowIso(), usage });
      emit({
        type: 'completed',
        at: nowIso(),
        outcome,
        exitCode: null,
        ...(result && outcome === 'succeeded' ? { result } : {}),
      });
      log(`[crew] completed outcome=${outcome}`);
      closeSync(fd);
      channel.close();
      return { outcome, exitCode: null, usage, result: outcome === 'succeeded' ? result : null };
    })();

    return { sessionId: input.sessionId, pid: null, events: channel, done };
  }

  async cancel(sessionId: string): Promise<void> {
    this.running.get(sessionId)?.(new StopError('cancelled', 'Cancelled by operator', 'unknown'));
  }
}

export function createOllamaAdapter(options: AdapterOptions = {}): ProviderAdapter {
  return new OllamaAdapter(options);
}
