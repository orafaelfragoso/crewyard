# Generic process adapter

Package: `@agent-rail/provider-generic`. Runs any executable as a managed agent. It never assumes usage telemetry.

## Profile settings

| Setting | Meaning |
|---|---|
| `command` (required) | Executable name on `PATH` or a path. |
| `args` | Arguments. `{model}`, `{mode}` and `{session_id}` are substituted; an argument containing `{model}` is dropped when no model is selected. |
| `protocol` | `jsonl` (default) or `text`. |
| `input` | How the prompt is delivered on stdin: `text` (default), `json` (`{prompt, systemInstructions, mode, model, outputSchema?}`) or `none`. |
| `envAllowlist` | Extra variables passed through from Rail's environment on top of the core allowlist. |
| `env` | Static, non-secret variables. Secret-looking keys or values are rejected. |
| `apiKeyEnv` | Required for `api-key` profiles: the variable that receives the key from the OS secret store. |
| `versionArgs` | Arguments for a version probe (for example `["--version"]`). |
| `codingAgent` | `false` limits the profile to `plan`/`review`. |

The child also receives `RAIL_SESSION_ID`, `RAIL_MODE`, `RAIL_MODEL` (when selected), `RAIL_SESSION_TOKEN`,
`RAIL_AGENT_ID`, `RAIL_TASK_ID` and `RAIL_PROJECT_ID`. The working directory is the session worktree.

## JSONL protocol v1

With `protocol: jsonl`, each stdout line that is a JSON object with a `type` is an event. Any other line becomes a
`log` event. Unknown types are logged.

| `type` | Fields | Meaning |
|---|---|---|
| `session` | `id` | Provider-side session id. |
| `message` | `role` (`assistant` default, `user`, `system`), `text` | Conversation text. The last assistant message is the result unless a `result` line exists. |
| `tool` | `name`, `status` (`started`, `completed`, `failed`), `detail?` | Tool activity. |
| `usage` | `input_tokens`, `output_tokens`, `cached_tokens?`, `cost_usd?`, `model?` | **Cumulative totals so far**; the last line wins. Omit the line when unknown. |
| `error` | `message`, `class?` (a `FailureClass`), `fatal?` (default `true`) | A fatal error fails the session even with exit code 0. |
| `result` | `text` or `data` | Final result (`data` is JSON-encoded). |
| `log` | `text` | Free-form log line. |

Example:

```jsonl
{"type":"session","id":"run-42"}
{"type":"tool","name":"edit","status":"started","detail":"src/a.ts"}
{"type":"tool","name":"edit","status":"completed","detail":"src/a.ts"}
{"type":"message","role":"assistant","text":"Fixed the off-by-one."}
{"type":"usage","input_tokens":1200,"output_tokens":340}
{"type":"result","text":"done"}
```

Exit code 0 and no fatal `error` means success. Without `usage` lines the session's usage is stored as `unknown`.

## Execution bounds

Timeout, output byte limit, process-group cancellation and log redaction are enforced by Rail, not by the process.
`fixtures/providers/fake-agent.ts` is a reference implementation used by the test suite.
