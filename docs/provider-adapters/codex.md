# Codex CLI adapter

Package: `@crewyard/provider-codex`. Verified against `codex-cli 0.166.0`.

## Invocation

```text
codex exec --json --cd <cwd> --sandbox <workspace-write|read-only> [--add-dir <git dir> ...] [--model <m>] [--output-schema <log-dir>/output-schema.json] [--skip-git-repo-check] \
  -c mcp_servers.crewyard.command=... -c mcp_servers.crewyard.args=[...] -c mcp_servers.crewyard.env={...} -c mcp_servers.crewyard.env_vars=[...] -
```

- The prompt (with agent system instructions prepended in a `<system-instructions>` block) is written to stdin (`-`).
- `execute` uses `workspace-write`; `plan`/`review` use `read-only`. `settings.sandbox` may narrow execute to
  `read-only`; `danger-full-access` is refused.
- `launch.outputSchema` is written next to the session log and passed with `--output-schema`.
- `settings.binary` overrides the executable, `settings.skipGitRepoCheck` adds `--skip-git-repo-check`.
- **Commits in worktrees.** Codex keeps `.git` read-only inside its sandbox, and a task worktree's Git data lives in the
  main repository's `.git`. In `workspace-write`, Crewyard adds exactly the worktree's own Git directory plus the shared
  `objects`, `refs` and `logs` with `--add-dir`, so the agent can commit on its branch without write access to your checkout.
- **Crewyard MCP server.** The `-c mcp_servers.crewyard.*` overrides register `crew mcp` for this run only. `env` sets
  `CREW_DATA_DIR` and `CREW_CONFIG_DIR`; `env_vars` forwards the session variables (`CREW_SESSION_TOKEN`, `CREW_TASK_ID`, …)
  by name, so the token never appears in argv. This works for any account, including one with its own `CODEX_HOME`.
- **Skills.** For accounts with their own `CODEX_HOME`, the `crew-*` Skills are copied to `$CODEX_HOME/skills` before
  launch (other skills there are left alone). Accounts using your default configuration get them from `crew install`.

## Isolation and authentication

| Item | Mechanism |
|---|---|
| Profile isolation | `CODEX_HOME=<config root>` (config, auth, sessions, logs). The directory is created before launch because Codex requires it to exist. |
| CLI login | `CODEX_HOME=<root> codex login`; health via `codex login status` (exit 0 = logged in). |
| API key | `CODEX_API_KEY` for the single `codex exec` invocation; never written to config. |

Docs: [environment variables](https://developers.openai.com/codex/environment-variables),
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## Event mapping (`--json`)

| Codex event | Crewyard event |
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
