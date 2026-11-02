# MCP configuration per host

Agent Rail's MCP server is `rail mcp`: a stdio server that writes protocol messages to stdout and diagnostics to stderr. Each host spawns its own instance; several instances can run at once.

`rail install --target codex,claude,opencode` registers it and installs the [Skills](skills.md). This page lists what it writes, so you can review it or register Rail by hand.

Formats were verified on 2026-11-02 against the official documentation linked below and these host versions: Codex CLI 0.166.0, Claude Code 2.1.316, OpenCode 2.2.5.

## How `rail install` edits host files

- **Preview first.** `--dry-run` prints every pending change as a unified diff (or the exact command) and writes nothing.
- **Backups.** Before changing anything, Rail copies every file it will touch to `<data>/backups/host-installers/<timestamp>/` and writes a `manifest.json` recording what it owns.
- **Atomic writes.** Files are written to a temporary file and renamed into place. Symlinked config files are written through to their target.
- **Unrelated settings are preserved byte-for-byte.**
  - TOML and Markdown: Rail appends one block between `# >>> agent-rail >>>` / `# <<< agent-rail <<<` (TOML) or `<!-- >>> agent-rail >>> -->` / `<!-- <<< agent-rail <<< -->` (Markdown).
  - JSON/JSONC: Rail inserts a single `agent-rail` key into the MCP map as text, keeping comments, ordering and formatting. It then re-parses the result and checks that nothing else changed.
- **No guessing.** Rail prints the exact snippet or command and edits nothing when:
  - the file cannot be parsed;
  - it already contains an `agent-rail` entry that Rail did not create;
  - its markers are unbalanced;
  - the installed host's major version is newer than the one verified here.
- **Uninstall** (`rail uninstall --target ...`) removes only Rail-owned blocks, keys and files:
  - If a file is unchanged since Rail edited it, the backed-up original is restored exactly.
  - Files Rail created are deleted.
  - Content shared with a host that is still registered (such as `AGENTS.md` or `.agents/skills`) is kept.

The MCP command is the installed `rail` binary's absolute path plus `mcp`. When `rail` is not on `PATH`, the fallback is `bunx agent-rail mcp`.

Scopes: `--scope user` (default) writes to your home directory; `--scope project` writes to the repository so the team can share it. Bootstrap instructions in `AGENTS.md`/`CLAUDE.md` are only added with explicit authorization (`--instructions`), and only as a marked block appended to the file.

## Codex

Docs: [MCP](https://learn.chatgpt.com/docs/extend/mcp), [config basics](https://learn.chatgpt.com/docs/config-file/config-basic), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [skills](https://learn.chatgpt.com/docs/build-skills), [AGENTS.md](https://developers.openai.com/codex/guides/agents-md).

| | User scope | Project scope |
|---|---|---|
| MCP config | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) | `.codex/config.toml` (loaded only for trusted projects) |
| Skills | `~/.agents/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| Instructions | — | `AGENTS.md` |

What Rail writes:

```toml
# >>> agent-rail >>>
# Managed by Agent Rail. Remove with `rail uninstall --target codex`.
[mcp_servers.agent-rail]
command = "/home/you/.local/bin/rail"
args = ["mcp"]
# <<< agent-rail <<<
```

Manual registration: `codex mcp add agent-rail -- /home/you/.local/bin/rail mcp` (user config), or paste the block above. Optional keys such as `startup_timeout_sec` and `tool_timeout_sec` are documented in the config reference.

## Claude Code

Docs: [MCP](https://code.claude.com/docs/en/mcp), [skills](https://code.claude.com/docs/en/skills), [memory (CLAUDE.md)](https://code.claude.com/docs/en/memory), [environment variables](https://code.claude.com/docs/en/env-vars).

| | User scope | Project scope |
|---|---|---|
| MCP config | `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`), written only through `claude mcp` | `.mcp.json` |
| Skills | `~/.claude/skills/<name>/SKILL.md` (or `$CLAUDE_CONFIG_DIR/skills`) | `.claude/skills/<name>/SKILL.md` |
| Instructions | — | `CLAUDE.md` (or `.claude/CLAUDE.md`); `AGENTS.md` when the repository has no `CLAUDE.md` |

For user scope, Rail runs `claude mcp add-json --scope user agent-rail '<json>'` and `claude mcp remove --scope user agent-rail`; it backs up `~/.claude.json` but never edits it directly. That file also holds Claude Code's account state and is rewritten by running sessions.

Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`. So if the repository has an `AGENTS.md` and no `CLAUDE.md`, Rail adds its block to `AGENTS.md` rather than creating a `CLAUDE.md` that would hide it.

Project `.mcp.json` entry:

```json
{
  "mcpServers": {
    "agent-rail": { "type": "stdio", "command": "/home/you/.local/bin/rail", "args": ["mcp"] }
  }
}
```

Manual registration: `claude mcp add --scope user agent-rail -- /home/you/.local/bin/rail mcp` (use `--scope project` to write `.mcp.json`). Claude Code asks you to approve project `.mcp.json` servers the first time.

## OpenCode

Docs: [config](https://opencode.ai/docs/config/), [MCP servers](https://opencode.ai/docs/mcp-servers/), [skills](https://opencode.ai/docs/skills/), [rules](https://opencode.ai/docs/rules/).

| | User scope | Project scope |
|---|---|---|
| MCP config | `~/.config/opencode/opencode.jsonc` if present, else `opencode.json` (`$XDG_CONFIG_HOME` respected) | `opencode.jsonc` if present, else `opencode.json` at the repository root |
| Skills | `~/.agents/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` |
| Instructions | — | `AGENTS.md` |

OpenCode reads skills from `.opencode/skills`, `.claude/skills` and `.agents/skills`, so Rail shares the `.agents/skills` copy with Codex. If you install for both Claude Code and another host, OpenCode sees the same skill names in `.agents/skills` and `.claude/skills`; OpenCode asks for unique names, so set `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` if it reports duplicates.

Entry Rail inserts under `mcp` (comments and trailing commas in JSONC files are preserved):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-rail": { "type": "local", "command": ["/home/you/.local/bin/rail", "mcp"], "enabled": true }
  }
}
```

Manual registration: `opencode mcp add --global agent-rail -- /home/you/.local/bin/rail mcp` (omit `--global` for the project config), or edit the file as above.

## Other MCP hosts

Any host that launches stdio MCP servers can use Rail. Register the command `rail` with argument `mcp`, or `bunx` with arguments `agent-rail mcp`. Install the Skills by copying `skills/<name>/` into the host's skills directory if it supports Agent Skills.

## Verify

1. Restart the host.
2. Ask it to list MCP tools. The `rail_*` tools from the [MCP reference](reference/mcp.md) should appear.
3. Run `rail doctor` inside the repository; `hosts.*` reports registration per host.
