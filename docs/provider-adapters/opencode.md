# OpenCode adapter

Package: `@crewyard/provider-opencode`. Verified against `opencode v2.2.5`.

## Invocation

```text
opencode run --standalone --format json [--model provider/model] [--agent plan|<settings.agent>] [--auto] -- <prompt>
```

- `--standalone` runs a private server inside the child process tree. Without it OpenCode talks to the shared background
  service, which ignores the profile's isolated directories and outlives cancellation.
- `plan`/`review` use the built-in `plan` agent; `execute` adds `--auto` unless `settings.autoApprove` is `false`.
- System instructions are prepended to the prompt. Output schemas are not supported (`UNSUPPORTED_CAPABILITY`).
- **Crewyard MCP server.** `OPENCODE_CONFIG_CONTENT` in the child environment adds a local `crewyard` server (`crew mcp`)
  for this run only. OpenCode merges inline config over the user and project config, and the server inherits the session
  variables from the OpenCode process. (`opencode mcp list` in 2.2.5 does not show inline or project servers.)
- **Skills.** For accounts with their own directories, the `crew-*` Skills are copied to the profile's
  `config/opencode/skills` before launch. Accounts using your default configuration get them from `crew install`.

## Isolation and authentication

| Item | Mechanism |
|---|---|
| Profile isolation | `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` under the config root. OpenCode resolves its config, credential store and database from these (`opencode debug paths`). |
| CLI login | `XDG_*=<root>/… opencode auth login --standalone`; health via `opencode auth list --standalone --format json` (any provider with connections = healthy). |
| API key | `settings.apiKeyEnv` names the variable OpenCode's provider reads (for example `ANTHROPIC_API_KEY`). |

Agent shell commands inherit the isolated `XDG_CONFIG_HOME`, so tools that read `~/.config` (for example git's XDG
config) see the profile directory instead; `~/.gitconfig` is unaffected.

Docs: [CLI](https://opencode.ai/docs/cli/) (`OPENCODE_CONFIG*` variables, `run --format json`),
[troubleshooting](https://opencode.ai/docs/troubleshooting/) (storage location, custom XDG paths).

## Event mapping (`--format json`)

| OpenCode event | Crewyard event |
|---|---|
| first `step_start` | `started` with `providerSessionId = sessionID` |
| `text` | `message` (last one is the result) |
| `tool_use` | `tool` (`state.status` `completed` / `error`) |
| `step_finish` | `usage`: tokens summed per step (`input + cache.read + cache.write`, `output`), `cost` summed |
| `error` | `error`; v2 shape `error.{type,message}` and legacy `error.{name,data.message}` |

Fixtures in `fixtures/providers/opencode/` were captured from real `opencode run` executions against a local Ollama model.
