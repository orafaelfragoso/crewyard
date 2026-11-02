# Ollama adapter

Package: `@crewyard/provider-ollama`. Verified against Ollama `0.40.6`.

Ollama serves model-backed planning and review over its local HTTP API. It has no tool runtime, so coding execution is
refused with `UNSUPPORTED_CAPABILITY` unless the profile sets `allowCodingExecution: true`; even then an `execute`
session only returns text.

## Settings

| Setting | Meaning |
|---|---|
| `endpoint` | Default `http://127.0.0.1:11434`. A non-loopback endpoint is treated as a remote destination for data routing. |
| `defaultModel` | Used when no model is routed; otherwise the first permitted model. |
| `options` | Passed as the request `options` (temperature, context size, …). |
| `keepAlive` | Passed as `keep_alive`. |
| `allowCodingExecution` | Explicit opt-in for `execute` mode. |

## Request

`POST /api/chat` with `stream: true`, an optional `system` message from the agent's instructions, the prompt as the
user message, and `format: <JSON schema>` when `launch.outputSchema` is set (structured outputs). Cancellation and
timeouts abort the HTTP request.

## Health and usage

- `capabilities` reads `/api/version`; `validateProfile` also reads `/api/tags` and reports `degraded` when permitted
  models are not pulled, `unavailable` when the endpoint is unreachable.
- Usage is `measured` from the final chunk's `prompt_eval_count` (input) and `eval_count` (output). Ollama reports no
  cost, so cost is `unknown` unless `observability.rates` configures one.

Docs: [Ollama API](https://docs.ollama.com/api/chat), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
