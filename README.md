# Crewyard

Crewyard coordinates independent AI coding agents (Codex, Claude Code, OpenCode and others) working in the same repositories. It owns task claiming, isolated worktrees, versioned repository context, reviews, validation, pull-request integration, recovery and observability. Agents do not need to share an LLM provider or a conversation.

It runs locally: a `crew` CLI, an MCP server over stdio (`crew mcp`), portable Agent Skills, an optional background service and a terminal dashboard, all calling the same application services. State lives in a local SQLite database. There is no hosted backend; the only network services are the LLM providers and GitHub you configure.

> Status: under development toward v1.0. Command and tool names follow the [v1.0 specification](docs/reference/cli.md); check `crew <command> --help` for what your build implements.

## How it works

1. You describe a goal. A planning agent proposes a task DAG; Crewyard validates it and you approve it.
2. The scheduler admits tasks that are ready, within WIP limits and without conflicting scope reservations.
3. Each agent claims a task (an atomic lease with a fencing generation), works in its own Git worktree, and hands off structured evidence.
4. Crewyard opens or attaches the PR, runs incremental review, and queues it for integration through GitHub's merge queue or a serialized fallback, never bypassing branch protection.
5. After a merge, Crewyard reconciles state, re-indexes the base and unblocks dependent tasks. Crashes and failures resume from durable state.

```mermaid
flowchart TB
  U[Developer or Automation] --> CLI[crew CLI / TUI]
  A[Codex / Claude / OpenCode / Other] --> MCP[MCP stdio adapter]
  A --> SK[Agent Skills]
  SK --> CLI
  SK --> MCP
  CLI --> CORE[Application Services]
  MCP --> CORE
  CORE --> DB[(SQLite WAL)]
  CORE --> IDX[Versioned Project Index]
  CORE --> SCH[Scheduler + Leases]
  CORE --> INT[Review + Integration Engine]
  SCH --> WRK[Agent Process Supervisor]
  WRK --> WT[Git Worktrees / Sandbox]
  INT <--> GH[GitHub / GitHub Actions]
  CORE --> EVT[Durable Event Log]
  EVT --> TUI[Terminal Dashboard]
```

## Requirements

- Git 2.38 or newer
- GitHub CLI (`gh`) authenticated, for GitHub integration
- At least one agent host or provider CLI (Codex CLI, Claude Code, OpenCode, or a generic process)
- Bun 1.4.4 or newer only when installing from npm or source; release binaries embed the runtime

Linux (x64, arm64), macOS (arm64, x64) and Windows (x64) are supported.

## Install

Download the binary for your platform from the GitHub release, verify it, and put it on `PATH`:

```bash
curl -LO https://github.com/orafaelfragoso/crewyard/releases/download/v1.0.0/crew-linux-x64
curl -LO https://github.com/orafaelfragoso/crewyard/releases/download/v1.0.0/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS
gh attestation verify crew-linux-x64 --repo orafaelfragoso/crewyard
install -m 755 crew-linux-x64 ~/.local/bin/crew
```

Alternatives (Bun runtime, from source), upgrades and uninstalling are covered in [docs/installation.md](docs/installation.md).

## Quick start

### Bootstrap a repository (J-01)

```bash
crew doctor                                   # runtime, git, gh, storage, providers, secret store
cd ~/src/my-repo
crew init --repo .                            # writes .crewyard/config.yaml, initializes local state
gh auth login                                 # GitHub access used by Crewyard
crew account add --provider codex --name personal
crew agent create --name engineer --provider codex --account personal
crew install --target codex,claude,opencode --dry-run   # review the pending changes
crew install --target codex,claude,opencode             # MCP registration + Skills, with backups
crew index build
crew doctor                                   # readiness report
```

### Run a goal to merged PRs (J-02)

```bash
crew goal create --title "Add JWT authentication" --description-file goal.md
crew goal plan GOAL-1 --agent architect       # planning agent proposes a task DAG
crew goal approve GOAL-1                      # operator approval gate
crew service start                            # continuous scheduling, sessions, GitHub polling
crew dashboard                                # live tasks, agents, queue, events
crew queue explain --pr 148 --json            # why a PR is or is not merging
```

Continuous autonomous work needs `crew service run`/`start` (or an installed user service). Closing an MCP host does not keep work running.

## Interfaces

| Surface | Use |
|---|---|
| `crew` CLI | Operators, scripts and shell-capable agents. Every read command supports `--json`. [Reference](docs/reference/cli.md) |
| `crew mcp` | MCP server over stdio for agent hosts: `crew_*` tools, `crew://` resources, `execution-handoff` prompt. [Reference](docs/reference/mcp.md) |
| Skills | `crew-planning`, `crew-execution`, `crew-review`, `crew-integration`, `crew-recovery`, `crew-context`. [Guide](docs/skills.md) |
| `crew dashboard` | Terminal UI over the durable event stream |

Skills are guidance. Leases, scopes, state transitions, policy and GitHub permissions are enforced by Crewyard regardless of what an agent asks for.

## Documentation

- [Installation, upgrades, backups](docs/installation.md)
- [`crew doctor` and troubleshooting](docs/doctor.md)
- [MCP configuration per host](docs/mcp-hosts.md) and [Agent Skills](docs/skills.md)
- [Security model](docs/policies/security-model.md) and [default policies](docs/policies/default-policies.md)
- [Architecture overview](docs/architecture/overview.md), [desktop integration](docs/architecture/desktop-integration.md), [ADRs](docs/adr.md)
- [Incident and recovery runbooks](docs/incident-recovery/runbooks.md)
- [CLI reference](docs/reference/cli.md), [MCP reference](docs/reference/mcp.md), [example configuration](docs/examples/config.yaml)

## Development

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build:binaries   # dist/crew-<os>-<arch>, manifest.json, SHA256SUMS
bun run sbom             # dist/sbom.cdx.json (CycloneDX 1.6)
```

Contributor conventions are in [AGENTS.md](AGENTS.md).
