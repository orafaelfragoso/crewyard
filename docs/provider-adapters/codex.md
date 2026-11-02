# Codex CLI adapter

Package: `@agent-rail/provider-codex`. Verified against `codex-cli 0.166.0`.

## Invocation

```text
codex exec --json --cd <cwd> --sandbox <workspace-write|read-only> [--model <m>] [--output-schema <log-dir>/output-schema.json] [--skip-git-repo-check] -
```

- The prompt (with agent system instructions prepended in a `<system-instructions>` block) is written to stdin (`-`).
- `execute` uses `workspace-write`; `plan`/`review` use `read-only`. `settings.sandbox` may narrow execute to
  `read-only`; `danger-full-access` is refused.
- `launch.outputSchema` is written next to the session log and passed with `--output-schema`.
- `settings.binary` overrides the executable, `settings.skipGitRepoCheck` adds `--skip-git-repo-check`.

## Isolation and authentication

| Item | Mechanism |
|---|---|
| Profile isolation | `CODEX_HOME=<config root>` (config, auth, sessions, logs). The directory is created before launch because Codex requires it to exist. |
| CLI login | `CODEX_HOME=<root> codex login`; health via `codex login status` (exit 0 = logged in). |
| API key | `CODEX_API_KEY` for the single `codex exec` invocation; never written to config. |

Docs: [environment variables](https://developers.openai.com/codex/environment-variables),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Event mapping (`--json`)

| Codex event | Agent Rail event |
|---|---|
| `thread.started` | `started` with `providerSessionId = thread_id` |
| `item.started` / `item.completed` `command_execution` | `tool` `command` (failed when `exit_code ≠ 0`) |
| `item.*` `file_change`, `mcp_tool_call`, `web_search` | `tool` `file_change`, `mcp:<server>.<tool>`, `web_search` |
| `item.completed` `agent_message` | `message` (last one is the result) |
| `item.completed` `error` | `log` (non-fatal warning) |
| `turn.completed.usage` | `usage` (input incl. `cached_input_tokens`, output) |
| `turn.failed`, `error` | `error` (cleared if a later turn completes) |

Recorded fixtures: `fixtures/providers/codex/*.jsonl` (the success fixture was captured from a real local run against
Ollama with an isolated `CODEX_HOME`).
