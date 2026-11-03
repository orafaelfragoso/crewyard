import {
  backoffWithJitter,
  CrewError,
  sleep as defaultSleep,
  type ErrorCode,
  toIso,
  trimTrailingSlashes,
} from '@crewyard/core';
import { asArray, asNumber, asRecord, asString, type JsonRecord } from './json.ts';
import {
  mergeChecks,
  toAsyncMergeResult,
  toBranchRequirements,
  toCheckRun,
  toCommitStatus,
  toGraphState,
  toMergeQueueEntry,
  toPullRequest,
  toPullRequestFile,
  toReview,
  toWorkflowRun,
} from './normalize.ts';
import type { TokenProvider } from './token.ts';
import type {
  AsyncMergeAction,
  AsyncMergeResult,
  BranchInfo,
  BranchRequirements,
  CheckResult,
  CompareStatus,
  CreatePullRequestInput,
  GitHubPullRequest,
  MergeMethod,
  MergeQueueEntry,
  MergeResult,
  PullRequestFile,
  PullRequestGraphState,
  PullRequestReview,
  RepositoryCoordinates,
  UpdatePullRequestInput,
  WorkflowRun,
} from './types.ts';

export const DEFAULT_API_VERSION = '2026-03-10';

export interface ConditionalEntry {
  etag: string;
  body: unknown;
}

export interface ConditionalCache {
  get(key: string): ConditionalEntry | null;
  set(key: string, entry: ConditionalEntry): void;
}

export interface GitHubClientOptions {
  repository: RepositoryCoordinates;
  token: TokenProvider;
  baseUrl?: string;
  graphqlUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  maxPages?: number;
  cache?: ConditionalCache;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  body?: unknown;
  conditional?: boolean;
  idempotent?: boolean;
  statusErrors?: Partial<Record<number, ErrorCode>>;
  allowStatuses?: number[];
}

interface HttpResponse {
  status: number;
  data: unknown;
  headers: Headers;
  notModified: boolean;
}

const OFFLINE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ConnectionRefused',
  'FailedToOpenSocket',
  'UnableToConnect',
  'DNSException',
]);

const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export function apiBaseUrlForHost(host: string): string {
  return host === 'github.com' || host === 'api.github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}

export function graphqlUrlFor(baseUrl: string): string {
  const trimmed = trimTrailingSlashes(baseUrl);
  return trimmed.endsWith('/api/v3') ? `${trimmed.slice(0, -'/api/v3'.length)}/api/graphql` : `${trimmed}/graphql`;
}

function errorCodeOf(error: unknown): string {
  const record = asRecord(error);
  const cause = asRecord(record.cause);
  return asString(record.code) ?? asString(cause.code) ?? '';
}

function isTimeout(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

function isOfflineError(error: unknown): boolean {
  return OFFLINE_CODES.has(errorCodeOf(error));
}

const PR_STATE_FIELDS = `id reviewDecision mergeable mergeStateStatus isInMergeQueue isMergeQueueEnabled
  mergeQueueEntry { id position state enqueuedAt headCommit { oid } baseCommit { oid } pullRequest { number } }`;

const ENTRY_FIELDS = 'id position state enqueuedAt headCommit { oid } baseCommit { oid } pullRequest { number }';

export class GitHubClient {
  readonly repository: RepositoryCoordinates;
  readonly baseUrl: string;
  readonly graphqlUrl: string;
  private readonly options: GitHubClientOptions;
  private readonly doFetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private rateLimitedUntil: number | null = null;
  private verified = false;

  constructor(options: GitHubClientOptions) {
    this.options = options;
    this.repository = options.repository;
    this.baseUrl = trimTrailingSlashes(options.baseUrl ?? apiBaseUrlForHost(options.repository.host));
    this.graphqlUrl = options.graphqlUrl ?? graphqlUrlFor(this.baseUrl);
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  get rateLimitResetAt(): string | null {
    return this.rateLimitedUntil === null ? null : toIso(new Date(this.rateLimitedUntil));
  }

  private repoPath(suffix = ''): string {
    const { owner, name } = this.repository;
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
  }

  private async headers(withBody: boolean): Promise<Record<string, string>> {
    const token = await this.options.token();
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'crewyard',
      'x-github-api-version': this.options.apiVersion ?? DEFAULT_API_VERSION,
      ...(withBody ? { 'content-type': 'application/json' } : {}),
    };
  }

  private rateLimitError(response: Response, message: string): CrewError | null {
    if (response.status !== 403 && response.status !== 429) return null;
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = asNumber(Number(response.headers.get('x-ratelimit-reset') ?? Number.NaN));
    const retryAfter = asNumber(Number(response.headers.get('retry-after') ?? Number.NaN));
    let resetAt: number | null = null;
    let kind: 'primary' | 'secondary' = 'secondary';
    if (remaining === '0' && reset !== null) {
      resetAt = reset * 1000;
      kind = 'primary';
    } else if (retryAfter !== null) {
      resetAt = this.now().getTime() + retryAfter * 1000;
    } else if (response.status === 429 || /rate limit/i.test(message)) {
      resetAt = this.now().getTime() + 60_000;
    }
    if (resetAt === null) return null;
    this.rateLimitedUntil = resetAt;
    const iso = toIso(new Date(resetAt));
    return new CrewError('RATE_LIMITED', `GitHub ${kind} rate limit reached; retry after ${iso}`, {
      details: { kind, resetAt: iso, status: response.status },
      suggestion: 'Wait for the rate limit window to reset; Crewyard retries automatically.',
    });
  }

  private statusError(response: Response, data: unknown, method: Method, path: string, options: RequestOptions) {
    const message = asString(asRecord(data).message) ?? response.statusText;
    const limited = this.rateLimitError(response, message);
    if (limited) return limited;
    const details = {
      status: response.status,
      method,
      path,
      requestId: response.headers.get('x-github-request-id'),
    };
    const override = options.statusErrors?.[response.status];
    if (override) return new CrewError(override, `GitHub ${method} ${path}: ${message}`, { details });
    if (response.status === 401) {
      return new CrewError('UNAUTHENTICATED', 'GitHub rejected the credential', {
        details,
        retryable: false,
        suggestion: 'Run `gh auth login` for the repository identity (GH_CONFIG_DIR).',
      });
    }
    if (response.status === 403) {
      return new CrewError('NOT_AUTHORIZED', `GitHub denied ${method} ${path}: ${message}`, {
        details,
        suggestion: 'Check the token scopes documented in docs/github.md.',
      });
    }
    if (response.status === 404) return new CrewError('NOT_FOUND', `GitHub ${path} not found`, { details });
    if (response.status === 409) return new CrewError('CONFLICT', `GitHub ${method} ${path}: ${message}`, { details });
    if (response.status === 422) {
      return new CrewError('INVALID_INPUT', `GitHub rejected ${method} ${path}: ${message}`, { details });
    }
    if (response.status >= 300 && response.status < 400) {
      return new CrewError('POLICY_DENIED', `GitHub redirected ${path}; the repository was renamed or transferred`, {
        details: { ...details, location: response.headers.get('location') },
        retryable: false,
        suggestion: 'Update the git remote and re-register the project; Crewyard never follows repository redirects.',
      });
    }
    return new CrewError('EXTERNAL_FAILURE', `GitHub ${method} ${path} failed with ${response.status}: ${message}`, {
      details,
      retryable: RETRYABLE_STATUS.has(response.status),
    });
  }

  private async send(method: Method, url: string, path: string, options: RequestOptions): Promise<HttpResponse> {
    const idempotent = options.idempotent ?? method === 'GET';
    const maxRetries = idempotent ? (this.options.maxRetries ?? 3) : 0;
    const cacheKey = `${method} ${url}`;
    const cached = options.conditional && this.options.cache ? this.options.cache.get(cacheKey) : null;
    for (let attempt = 0; ; attempt++) {
      if (this.rateLimitedUntil !== null) {
        if (this.rateLimitedUntil > this.now().getTime()) {
          throw new CrewError('RATE_LIMITED', `GitHub rate limit active until ${this.rateLimitResetAt}`, {
            details: { resetAt: this.rateLimitResetAt },
          });
        }
        this.rateLimitedUntil = null;
      }
      const headers = await this.headers(options.body !== undefined);
      if (cached) headers['if-none-match'] = cached.etag;
      let response: Response;
      try {
        response = await this.doFetch(url, {
          method,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch (error) {
        if (isOfflineError(error)) {
          throw new CrewError('OFFLINE', `GitHub is unreachable (${errorCodeOf(error)})`, {
            cause: error,
            details: { method, path, sent: false },
            suggestion: 'Crewyard keeps the last-seen state and replays queued intents after reconciling when online.',
          });
        }
        if (!idempotent) {
          throw new CrewError(
            'AMBIGUOUS_REMOTE_OUTCOME',
            `GitHub ${method} ${path} did not complete; outcome unknown`,
            {
              cause: error,
              details: { method, path, timeout: isTimeout(error) },
              suggestion: 'Crewyard reconciles remote state before retrying this operation.',
            },
          );
        }
        if (attempt < maxRetries) {
          await this.sleep(backoffWithJitter(attempt, this.options.retryBaseMs ?? 250));
          continue;
        }
        throw new CrewError('OFFLINE', `GitHub did not respond to ${method} ${path}`, {
          cause: error,
          details: { method, path, timeout: isTimeout(error) },
        });
      }
      if (response.status === 304 && cached) {
        await response.body?.cancel();
        return { status: 304, data: cached.body, headers: response.headers, notModified: true };
      }
      const text = await response.text();
      let data: unknown = null;
      if (text !== '') {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text.slice(0, 200) };
        }
      }
      if ((response.status >= 200 && response.status < 300) || options.allowStatuses?.includes(response.status)) {
        const etag = response.headers.get('etag');
        if (options.conditional && this.options.cache && etag && response.status === 200) {
          this.options.cache.set(cacheKey, { etag, body: data });
        }
        return { status: response.status, data, headers: response.headers, notModified: false };
      }
      const error = this.statusError(response, data, method, path, options);
      if (idempotent && error.code === 'EXTERNAL_FAILURE' && error.retryable && attempt < maxRetries) {
        await this.sleep(backoffWithJitter(attempt, this.options.retryBaseMs ?? 250));
        continue;
      }
      if (!idempotent && RETRYABLE_STATUS.has(response.status)) {
        throw new CrewError('AMBIGUOUS_REMOTE_OUTCOME', `GitHub ${method} ${path} returned ${response.status}`, {
          cause: error,
          details: { method, path, status: response.status },
        });
      }
      throw error;
    }
  }

  private request(method: Method, path: string, options: RequestOptions = {}): Promise<HttpResponse> {
    return this.send(method, `${this.baseUrl}${path}`, path, options);
  }

  private async paginate(path: string, itemsKey?: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const maxPages = this.options.maxPages ?? 30;
    let url: string | null = `${this.baseUrl}${path}`;
    for (let page = 0; url && page < maxPages; page++) {
      const response: HttpResponse = await this.send('GET', url, path, { conditional: true });
      items.push(...(itemsKey ? asArray(asRecord(response.data)[itemsKey]) : asArray(response.data)));
      url = this.nextPage(response.headers.get('link'));
    }
    return items;
  }

  private nextPage(link: string | null): string | null {
    if (!link) return null;
    const match = /<([^>]+)>;\s*rel="next"/.exec(link);
    if (!match) return null;
    const next = new URL(match[1]!);
    const base = new URL(this.baseUrl);
    if (
      next.origin !== base.origin ||
      !next.pathname.startsWith(`${base.pathname.replace(/\/$/, '')}${this.repoPath()}`)
    ) {
      return null;
    }
    return next.toString();
  }

  async graphql(operationName: string, query: string, variables: JsonRecord, mutation = false): Promise<JsonRecord> {
    const response = await this.send('POST', this.graphqlUrl, `graphql:${operationName}`, {
      body: { query, variables, operationName },
      idempotent: !mutation,
    });
    const body = asRecord(response.data);
    const errors = asArray(body.errors);
    if (errors.length > 0) {
      const first = asRecord(errors[0]);
      const type = asString(first.type) ?? '';
      const message = asString(first.message) ?? 'GraphQL error';
      const code: ErrorCode =
        type === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : type === 'FORBIDDEN'
            ? 'NOT_AUTHORIZED'
            : type === 'RATE_LIMITED'
              ? 'RATE_LIMITED'
              : 'EXTERNAL_FAILURE';
      throw new CrewError(code, `GitHub GraphQL ${operationName}: ${message}`, {
        details: { type, operationName },
        retryable: code === 'RATE_LIMITED',
      });
    }
    return asRecord(body.data);
  }

  async verifyRepository(): Promise<{ fullName: string; defaultBranch: string }> {
    const response = await this.request('GET', this.repoPath(), { conditional: true });
    const data = asRecord(response.data);
    const fullName = asString(data.full_name) ?? '';
    const expected = `${this.repository.owner}/${this.repository.name}`;
    if (fullName.toLowerCase() !== expected.toLowerCase()) {
      throw new CrewError('POLICY_DENIED', `GitHub returned ${fullName} for ${expected}; refusing to continue`, {
        retryable: false,
        details: { expected, observed: fullName },
        suggestion: 'The repository was renamed or transferred. Update the git remote and re-register the project.',
      });
    }
    this.verified = true;
    return { fullName, defaultBranch: asString(data.default_branch) ?? 'main' };
  }

  private async ensureVerified(): Promise<void> {
    if (!this.verified) await this.verifyRepository();
  }

  async listPullRequests(state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubPullRequest[]> {
    await this.ensureVerified();
    const items = await this.paginate(this.repoPath(`/pulls?state=${state}&sort=created&direction=asc&per_page=100`));
    return items.map(toPullRequest);
  }

  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    await this.ensureVerified();
    return toPullRequest((await this.request('GET', this.repoPath(`/pulls/${number}`), { conditional: true })).data);
  }

  async findPullRequestsForHead(headRef: string): Promise<GitHubPullRequest[]> {
    await this.ensureVerified();
    const head = encodeURIComponent(`${this.repository.owner}:${headRef}`);
    const items = await this.paginate(this.repoPath(`/pulls?state=all&head=${head}&per_page=100`));
    return items.map(toPullRequest).filter((pr) => pr.headRef === headRef);
  }

  async listPullRequestFiles(number: number): Promise<PullRequestFile[]> {
    await this.ensureVerified();
    return (await this.paginate(this.repoPath(`/pulls/${number}/files?per_page=100`))).map(toPullRequestFile);
  }

  async listReviews(number: number): Promise<PullRequestReview[]> {
    await this.ensureVerified();
    return (await this.paginate(this.repoPath(`/pulls/${number}/reviews?per_page=100`))).map(toReview);
  }

  async listChecks(sha: string): Promise<CheckResult[]> {
    await this.ensureVerified();
    const runs = (await this.paginate(this.repoPath(`/commits/${sha}/check-runs?per_page=100`), 'check_runs')).map(
      toCheckRun,
    );
    const combined = await this.request('GET', this.repoPath(`/commits/${sha}/status?per_page=100`), {
      conditional: true,
    });
    const statuses = asArray(asRecord(combined.data).statuses).map((s) => toCommitStatus(s, sha));
    return mergeChecks(runs, statuses);
  }

  async listWorkflowRuns(sha: string): Promise<WorkflowRun[]> {
    await this.ensureVerified();
    const response = await this.request('GET', this.repoPath(`/actions/runs?head_sha=${sha}&per_page=50`), {
      conditional: true,
    });
    return asArray(asRecord(response.data).workflow_runs).map(toWorkflowRun);
  }

  async getBranch(branch: string): Promise<BranchInfo> {
    await this.ensureVerified();
    const response = await this.request('GET', this.repoPath(`/branches/${encodeURIComponent(branch)}`), {
      conditional: true,
    });
    const data = asRecord(response.data);
    return {
      name: asString(data.name) ?? branch,
      sha: asString(asRecord(data.commit).sha) ?? '',
      protected: data.protected === true,
    };
  }

  async getBranchRequirements(branch: string): Promise<BranchRequirements> {
    await this.ensureVerified();
    const encoded = encodeURIComponent(branch);
    const rules = await this.paginate(this.repoPath(`/rules/branches/${encoded}?per_page=100`));
    let protection: unknown = null;
    let visible = true;
    try {
      protection = (await this.request('GET', this.repoPath(`/branches/${encoded}/protection`), { conditional: true }))
        .data;
    } catch (error) {
      if (!(error instanceof CrewError) || (error.code !== 'NOT_FOUND' && error.code !== 'NOT_AUTHORIZED')) throw error;
      visible = error.code === 'NOT_FOUND';
    }
    return toBranchRequirements(branch, rules, protection, visible);
  }

  async compareCommits(
    base: string,
    head: string,
  ): Promise<{ status: CompareStatus; aheadBy: number; behindBy: number }> {
    await this.ensureVerified();
    const response = await this.request('GET', this.repoPath(`/compare/${base}...${head}`), { conditional: true });
    const data = asRecord(response.data);
    const status = asString(data.status);
    return {
      status: status === 'ahead' || status === 'behind' || status === 'identical' ? status : 'diverged',
      aheadBy: asNumber(data.ahead_by) ?? 0,
      behindBy: asNumber(data.behind_by) ?? 0,
    };
  }

  async getPullRequestState(number: number): Promise<PullRequestGraphState> {
    await this.ensureVerified();
    const data = await this.graphql(
      'PullRequestState',
      `query PullRequestState($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_STATE_FIELDS} } }
      }`,
      { owner: this.repository.owner, name: this.repository.name, number },
    );
    const pr = asRecord(asRecord(data.repository).pullRequest);
    if (!asString(pr.id)) throw new CrewError('NOT_FOUND', `Pull request #${number} not found via GraphQL`);
    return toGraphState(pr);
  }

  async listMergeQueue(branch: string): Promise<MergeQueueEntry[]> {
    await this.ensureVerified();
    const data = await this.graphql(
      'MergeQueueEntries',
      `query MergeQueueEntries($owner: String!, $name: String!, $branch: String!) {
        repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id entries(first: 100) { nodes { ${ENTRY_FIELDS} } } } }
      }`,
      { owner: this.repository.owner, name: this.repository.name, branch },
    );
    const nodes = asArray(asRecord(asRecord(asRecord(asRecord(data.repository).mergeQueue).entries)).nodes);
    return nodes.map(toMergeQueueEntry).filter((e): e is MergeQueueEntry => e !== null);
  }

  async enqueuePullRequest(nodeId: string, expectedHeadSha: string): Promise<MergeQueueEntry> {
    await this.ensureVerified();
    const data = await this.graphql(
      'EnqueuePullRequest',
      `mutation EnqueuePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID) {
        enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { ${ENTRY_FIELDS} } }
      }`,
      { pullRequestId: nodeId, expectedHeadOid: expectedHeadSha },
      true,
    );
    const entry = toMergeQueueEntry(asRecord(data.enqueuePullRequest).mergeQueueEntry);
    if (!entry) throw new CrewError('EXTERNAL_FAILURE', 'enqueuePullRequest returned no merge queue entry');
    return entry;
  }

  async dequeuePullRequest(nodeId: string): Promise<void> {
    await this.ensureVerified();
    await this.graphql(
      'DequeuePullRequest',
      `mutation DequeuePullRequest($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }`,
      { id: nodeId },
      true,
    );
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    await this.ensureVerified();
    const response = await this.request('POST', this.repoPath('/pulls'), {
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body ?? '',
        draft: input.draft ?? false,
      },
    });
    return toPullRequest(response.data);
  }

  async updatePullRequest(number: number, input: UpdatePullRequestInput): Promise<GitHubPullRequest> {
    await this.ensureVerified();
    const response = await this.request('PATCH', this.repoPath(`/pulls/${number}`), { body: input, idempotent: true });
    return toPullRequest(response.data);
  }

  async mergePullRequest(
    number: number,
    input: { sha: string; mergeMethod: MergeMethod; commitTitle?: string },
  ): Promise<MergeResult> {
    await this.ensureVerified();
    const response = await this.request('PUT', this.repoPath(`/pulls/${number}/merge`), {
      body: {
        sha: input.sha,
        merge_method: input.mergeMethod,
        ...(input.commitTitle ? { commit_title: input.commitTitle } : {}),
      },
      statusErrors: { 405: 'POLICY_DENIED', 409: 'HEAD_MISMATCH' },
    });
    const data = asRecord(response.data);
    return { merged: data.merged === true, sha: asString(data.sha), message: asString(data.message) ?? '' };
  }

  async mergePullRequestAsync(
    number: number,
    input: { sha: string; mergeMethod?: MergeMethod; action: AsyncMergeAction },
  ): Promise<AsyncMergeResult> {
    await this.ensureVerified();
    const response = await this.request('PUT', this.repoPath(`/pulls/${number}/merge-async`), {
      body: {
        sha: input.sha,
        merge_action: input.action,
        ...(input.mergeMethod ? { merge_method: input.mergeMethod } : {}),
      },
      statusErrors: { 400: 'POLICY_DENIED', 409: 'CONFLICT' },
    });
    return toAsyncMergeResult(response.data);
  }

  async getAsyncMergeResult(number: number, uuid: string): Promise<AsyncMergeResult> {
    await this.ensureVerified();
    const response = await this.request(
      'GET',
      this.repoPath(`/pulls/${number}/merge-async/${encodeURIComponent(uuid)}`),
    );
    return toAsyncMergeResult(response.data);
  }
}
