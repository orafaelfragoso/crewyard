# Claude Code adapter

Package: `@crewyard/provider-claude`. Verified against Claude Code `2.1.316`; requires `2.1.259`+ for
`--permission-prompts`.

## Invocation

```text
claude --print --output-format stream-json --verbose --permission-prompts none --permission-mode <mode> \
  [--model <m>] [--append-system-prompt <instructions>] [--json-schema <schema>] [--bare] [--allowedTools a,b] \
  --mcp-config '{"mcpServers":{"crewyard":{...}}}' --plugin-dir <data>/runtime/agent-skills
```

- The prompt is written to stdin.
- `execute` uses `settings.permissionMode` (`acceptEdits` default, `auto` or `dontAsk`); `bypassPermissions` is refused.
  `plan`/`review` use `plan`.
- `--permission-prompts none` makes unattended runs deny anything that would prompt instead of hanging.
- `settings.bare: true` adds `--bare` (recommended for API-key profiles; it never reads OAuth or the keychain).
- **Crewyard MCP server.** `--mcp-config` registers `crew mcp` as `crewyard` for this run only, with `CREW_DATA_DIR` and
  `CREW_CONFIG_DIR` set; the session variables reach it through the Claude process environment, never argv. This works
  for any account, including one with its own `CLAUDE_CONFIG_DIR`, and in `--bare` mode.
- **Skills.** `--plugin-dir` loads the `crew-*` Skills as the `crewyard` plugin (`crewyard:crew-execution`, …).
- **Allowed tools.** Crewyard always adds `mcp__crewyard` (its own tools) and, for `execute`, `Bash(git status:*)`,
  `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git add:*)` and `Bash(git commit:*)`, so an unattended engineer can commit.
  Anything else, such as running tests, still needs `settings.allowedTools` or a broader `permissionMode`.

## Isolation and authentication

| Item | Mechanism |
|---|---|
| Profile isolation | `CLAUDE_CONFIG_DIR=<config root>` (settings, sessions, credentials on Linux; see the credential docs for macOS Keychain behaviour). |
| CLI login | `CLAUDE_CONFIG_DIR=<root> claude auth login`; health via `claude auth status --json` (`loggedIn`). |
| API key | `ANTHROPIC_API_KEY` in the child environment (always used in `-p` mode when present). |

Docs: [headless mode](https://code.claude.com/docs/en/headless),
[environment variables](https://code.claude.com/docs/en/env-vars),
[Agent SDK message types](https://code.claude.com/docs/en/agent-sdk/typescript).

## Event mapping (`stream-json`)

| Claude message | Crewyard event |
|---|---|
| `system/init` | `started` with `providerSessionId = session_id`; model recorded |
| `system/api_retry` | `log` (attempt, error category, status) |
| `assistant` text / `tool_use` blocks | `message` / `tool started` |
| `user` `tool_result` blocks | `tool completed` or `failed` (`is_error`) |
| `result` | usage from `modelUsage` (else `usage`), cost from `costUSD`/`total_cost_usd`, result text or `structured_output` |
| `result` with `is_error` or `subtype ≠ success` | `error`, classified by `api_error_status`, then the last assistant `error` category, then text |

`total_cost_usd` is a client-side estimate; it is stored as `reported` and documented as such.
