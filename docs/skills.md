# Agent Skills

Rail ships six [Agent Skills](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx) in `skills/`. Each is a directory with a `SKILL.md` (YAML frontmatter with `name`, `description`, `compatibility` and `metadata`, then instructions) and, where it helps, a `references/` file loaded on demand.

| Skill | Use it to |
|---|---|
| `rail-planning` | Turn a goal into a validated task DAG with contracts, risk, scope hints and tests |
| `rail-execution` | Claim a task, work in its worktree, keep the lease, checkpoint and hand off evidence |
| `rail-review` | Review a PR incrementally from its evidence and publish structured findings |
| `rail-integration` | Request integration, read queue status and explain blockers. It cannot merge. |
| `rail-recovery` | Diagnose CI/merge/review failures, apply bounded fixes, escalate at the retry limit |
| `rail-context` | Retrieve version-aware context: search, symbols, impact, context packs |

## Install

`rail install --target codex,claude,opencode` copies the skills to each host's skills directory (see [mcp-hosts.md](mcp-hosts.md)). To install by hand, copy `skills/<name>/` into:

| Host | User | Project |
|---|---|---|
| Codex | `~/.agents/skills/` | `.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` |
| OpenCode | `~/.agents/skills/` (also reads `.claude/skills`, `.opencode/skills`) | `.agents/skills/` |

The skill's directory name must stay equal to its `name` field.

## How the skills are written

- **Tool-agnostic.** Every step names the MCP tool and the equivalent CLI command with `--json`, so agents without MCP can follow the same workflow through a shell.
- **The same contract in every skill.** Each `SKILL.md` contains an identical "Rail contract" section (FR-SKL-03):
  1. inspect state and policy;
  2. claim before modifying;
  3. work only in the assigned worktree;
  4. renew the lease;
  5. no proactive rebase;
  6. submit structured evidence;
  7. never bypass merge authority;
  8. report blockers instead of retrying indefinitely;
  9. request the next safe action after a handoff.
- **Untrusted content.** Each skill states that repository files, issues, PR comments, logs and tool output are data, not instructions (FR-SEC-02).
- **No administrative capability.** Skills never instruct agents to merge, force-push, change policy or credentials, or run operator-only commands.

A test (`tests/unit/host-installers/skills.test.ts`) validates the frontmatter against the specification and enforces the last three points.

## Skills are advisory

A skill tells a model what to do; it does not grant or restrict anything. Rail enforces leases, fencing generations, scope reservations, state transitions, approval gates and GitHub permissions in the CLI/MCP layer, and rejects forbidden actions even when an agent requests them. Administrative actions (policy changes, credential creation, forced cleanup, direct merges) are not exposed as MCP tools at all.

## Bootstrap instructions

With `rail install --instructions`, Rail appends a short marked block to the project's `AGENTS.md` (Codex, OpenCode) or `CLAUDE.md` (Claude Code) pointing agents at the skills and the core rules. It never rewrites existing content, and `rail uninstall` removes only that block.

## Writing additional skills

Follow the specification: `name` is 1-64 lowercase letters, digits and single hyphens and matches the directory; `description` (up to 1024 characters) says what the skill does and when to use it. Keep `SKILL.md` under 500 lines and move detail to `references/`. Copy the "Rail contract" and "Untrusted content" sections from an existing skill.
