<!-- Crewyard README · Keep installation instructions consistent with docs/installation.md. -->

<div align="center">

  <h1>crewyard</h1>

  <p><strong>Ship together. Merge safely.</strong></p>

  <p>
    The local-first coordination engine for independent AI coding agents.<br />
    One workflow for planning, parallel execution, review, and integration.
  </p>

  <p>
    <a href="#quick-start"><strong>Get started</strong></a>
    &nbsp;&nbsp;·&nbsp;&nbsp;
    <a href="#how-it-works">How it works</a>
    &nbsp;&nbsp;·&nbsp;&nbsp;
    <a href="docs/architecture/overview.md">Architecture</a>
    &nbsp;&nbsp;·&nbsp;&nbsp;
    <a href="#documentation">Documentation</a>
  </p>

  <p>
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-18181B?style=flat-square&logo=typescript&logoColor=white" />
    <img alt="Bun" src="https://img.shields.io/badge/Bun-18181B?style=flat-square&logo=bun&logoColor=white" />
    <img alt="MCP" src="https://img.shields.io/badge/MCP-18181B?style=flat-square" />
    <img alt="Local first" src="https://img.shields.io/badge/Local--first-18181B?style=flat-square" />
    <a href="https://www.npmjs.com/package/crewyard"><img alt="npm" src="https://img.shields.io/npm/v/crewyard?style=flat-square&color=18181B&label=npm" /></a>
    <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-18181B?style=flat-square" /></a>
    <a href="https://github.com/orafaelfragoso/crewyard/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/orafaelfragoso/crewyard/actions/workflows/ci.yml/badge.svg" /></a>
  </p>

  <sub>In development toward v1.0 · MIT licensed · No hosted backend required</sub>

</div>

<br />

> [!NOTE]
> **Pre-1.0 software.** Crewyard is being developed toward v1.0, and commands and configuration may still change between minor versions. Run `crew <command> --help` to see what your installed version supports, and check the [changelog](CHANGELOG.md) before upgrading.

## Coding agents are good at writing code. Coordinating them is the hard part.

Running multiple independent agents on one repository creates a new set of engineering problems: duplicated work, conflicting edits, stale context, overflowing PR queues, repeated reviews, and merges that invalidate work already in flight.

**Crewyard is the coordination layer between your agents and your repository.** It gives independent agents a shared, durable workflow—without forcing them to use the same model, provider, or chat session.

| Without coordination | With Crewyard |
| :--- | :--- |
| Agents pick up overlapping tasks | Atomic claims, leases, and scope reservations |
| Parallel work collides in one checkout | Isolated Git worktrees per task |
| Context drifts as branches change | Versioned repository indexing and context packs |
| Reviews repeat or become stale | Evidence-aware incremental review |
| PRs accumulate and merges conflict | Serialized integration and GitHub-aware queueing |
| Crashes lose orchestration state | Durable events, reconciliation, and recovery |

## One workflow. From goal to merge.

```mermaid
flowchart LR
    A["01 · Plan"] --> B["02 · Schedule"]
    B --> C["03 · Execute"]
    C --> D["04 · Review"]
    D --> E["05 · Integrate"]
    E --> F["06 · Reconcile"]
    F -. "Unblock dependent work" .-> B

    classDef default fill:#18181b,color:#fafafa,stroke:#52525b,stroke-width:1px;
    classDef finish fill:#134e4a,color:#f0fdfa,stroke:#2dd4bf,stroke-width:1px;
    class F finish;
```

1. **Plan with dependencies.** Turn a goal into a validated task graph and approve the plan before execution.
2. **Schedule safely.** Dispatch ready tasks subject to concurrency limits, dependencies, and reservations.
3. **Run independently.** Assign work to Codex, Claude Code, OpenCode, or another compatible process in isolated worktrees.
4. **Review with evidence.** Collect structured handoffs, tests, and review findings associated with the work being proposed.
5. **Integrate deliberately.** Coordinate pull requests and validation without bypassing repository protections.
6. **Recover and continue.** Persist events, reconcile remote state, re-index the base, and unblock downstream tasks.

## Built for real engineering workflows

<table>
<tr>
<td width="50%" valign="top">

### Multi-agent, multi-provider

Use independent coding agents and account profiles without tying the workflow to one LLM provider.

**Adapters:** Codex · Claude Code · OpenCode · Ollama · Generic process

</td>
<td width="50%" valign="top">

### Parallel work, without collisions

Atomic task claims, fenced leases, dependency-aware scheduling, and dedicated Git worktrees are designed to keep work isolated and accountable.

</td>
</tr>
<tr>
<td valign="top">

### Repository-aware context

Build versioned indexes and retrieve code context with symbol, reference, path, and commit provenance.

</td>
<td valign="top">

### Review-to-merge orchestration

Track review evidence, integration readiness, GitHub checks, queue state, and merge outcomes across the full task lifecycle.

</td>
</tr>
<tr>
<td valign="top">

### Local by design

Keep orchestration state in a local SQLite database. No Crewyard-hosted backend is required; configured providers and GitHub may still use network services.

</td>
<td valign="top">

### Multiple ways to interact

Operate through a CLI, MCP tools, portable Agent Skills, a background service, or a terminal dashboard—all backed by the same application services.

</td>
</tr>
</table>

## Installation

Crewyard targets **Linux (x64, arm64)**, **macOS (Apple Silicon, Intel)**, and **Windows (x64)**. You need Git 2.38+, at least one compatible coding-agent CLI, and the authenticated [GitHub CLI](https://cli.github.com/) for GitHub integration.

### Install with npm

```bash
npm install --global crewyard
crew version
```

npm installs a prebuilt binary for your platform; Node.js 22+ is only needed for the small launcher. Standalone binaries that need neither Node.js nor Bun are attached to every [GitHub release](https://github.com/orafaelfragoso/crewyard/releases).

### Install from source

Requires [Bun 1.4.4+](https://bun.sh/).

```bash
git clone https://github.com/orafaelfragoso/crewyard.git
cd crewyard
bun install --frozen-lockfile
bun run crew doctor
```

In a source checkout, run `bun run crew` from the repository root wherever this README uses `crew`.

See [installation and upgrades](docs/installation.md) for supported platforms, direct binary installs, checksums, backups, and removal.

## Quick start

### 1. Initialize your repository

```bash
crew doctor
crew init --repo /path/to/your/project
```

Crewyard creates repository configuration at `.crewyard/config.yaml` and manages coordination state locally.

### 2. Connect your agents

```bash
crew account add --provider codex --name personal
crew agent create --name engineer --provider codex --account personal
crew install --target codex,claude,opencode --dry-run
crew install --target codex,claude,opencode
```

The installer registers `crew mcp` and adds portable Agent Skills to supported agent hosts. Inspect the dry-run output before allowing changes to host configuration.

### 3. Plan and supervise a goal

Review the plan before approving it, and watch the first runs before leaving the service unattended:

```bash
crew goal create --title "Add JWT authentication" --description-file goal.md
crew goal plan GOAL-1 --agent architect
crew goal approve GOAL-1
crew service start
crew dashboard
```

Create an agent with `--role architect` before using `--agent architect`. `GOAL-1` is illustrative; use the ID returned by the create command.

The background service is required for continuous dispatch and reconciliation; the MCP server alone does not keep autonomous work running after the host exits.

<p><a href="docs/installation.md"><strong>Installation guide →</strong></a> &nbsp;·&nbsp; <a href="docs/reference/cli.md"><strong>CLI reference →</strong></a></p>

## How it works

Crewyard is a local orchestration system, not an LLM gateway. It coordinates tools you already use while maintaining its own authoritative task and integration state.

```mermaid
flowchart TB
    DEV["Developer / automation"] --> CLI["CLI & terminal dashboard"]
    AG["Codex · Claude Code · OpenCode · Other"] --> MCP["MCP server & Agent Skills"]

    CLI --> APP["Shared application services"]
    MCP --> APP

    APP --> PLAN["Task graph & scheduler"]
    APP --> CTX["Versioned index & context"]
    APP --> REV["Review & integration"]
    APP --> EVT["Events & observability"]

    PLAN --> WORK["Isolated Git worktrees"]
    REV <--> GH["GitHub & CI"]
    PLAN --> DB[("Local SQLite")]
    CTX --> DB
    REV --> DB
    EVT --> DB

    classDef default fill:#18181b,color:#fafafa,stroke:#52525b,stroke-width:1px;
    classDef store fill:#134e4a,color:#f0fdfa,stroke:#2dd4bf;
    class DB store;
```

**The architecture is deliberately provider-agnostic.** The CLI and MCP server are thin interfaces over shared application services. SQLite WAL provides durable coordination; external GitHub and process side effects are reconciled rather than treated as a single database transaction.

For an engineering-level explanation, see the [architecture overview](docs/architecture/overview.md), [indexing model](docs/architecture/indexing.md), and [task/lease design](docs/architecture/tasks-and-leases.md).

## Interfaces

| Interface | Designed for | Reference |
| :--- | :--- | :--- |
| **CLI** (`crew`) | Humans, scripts, and command-capable agents | [CLI reference](docs/reference/cli.md) |
| **MCP** (`crew mcp`) | Agent hosts that support Model Context Protocol | [MCP reference](docs/reference/mcp.md) |
| **Agent Skills** | Portable instructions for planning, execution, review, integration, recovery, and context | [Skills guide](docs/skills.md) |
| **Local service** (`crew service`) | Continuous dispatch, reconciliation, and integration | [Architecture](docs/architecture/overview.md) |
| **Terminal dashboard** (`crew dashboard`) | Operational visibility into active work and events | [CLI reference](docs/reference/cli.md) |

## Safety is an architectural boundary

Autonomous agents should not be able to bypass coordination simply by asking for it.

- **Fenced task leases** prevent stale workers from submitting work as the current owner.
- **Scoped worktrees** separate parallel tasks and protect developer checkouts.
- **Approval and policy gates** control high-impact transitions.
- **GitHub branch protections** remain authoritative during integration.
- **Idempotent outbox operations** support retries and recovery after interruption.
- **Local credential handling** keeps secrets out of repository configuration and orchestration event logs.

Security properties depend on configuration and implementation maturity. Read the [security model](docs/policies/security-model.md) and [default policies](docs/policies/default-policies.md) before enabling unattended workflows.

## Documentation

| Start here | Learn more |
| :--- | :--- |
| [Installation](docs/installation.md) | Supported setups, local data, upgrades, and backups |
| [CLI reference](docs/reference/cli.md) | Commands, options, and machine-readable output |
| [MCP host setup](docs/mcp-hosts.md) | Connecting existing coding-agent tools |
| [Agent Skills](docs/skills.md) | Reusable workflows for compatible agents |
| [Architecture](docs/architecture/overview.md) | Services, storage, scheduling, and system boundaries |
| [Security model](docs/policies/security-model.md) | Trust boundaries, permissions, and operational safety |
| [Recovery runbooks](docs/incident-recovery/runbooks.md) | Failures, restarts, and reconciliation |

## Development

The codebase is a Bun/TypeScript monorepo with packages for scheduling, providers, indexing, reviews, integration, storage, and telemetry.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build:binaries  # platform binaries, manifest and checksums
bun run build:npm       # npm tarballs, after binaries have been built
```

See [AGENTS.md](AGENTS.md) for code conventions, the [architecture documentation](docs/architecture/overview.md) for package boundaries, and the [release process](docs/releasing.md) for distribution.

## Contributing

Contributions are welcome. Read the [contributing guide](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md), and use [GitHub Issues](https://github.com/orafaelfragoso/crewyard/issues) for bug reports and feature requests. Report vulnerabilities privately as described in the [security policy](SECURITY.md).

## Project status & licensing

Crewyard is **under active development toward v1.0**. Releases are cut automatically from `main` with [release-please](https://github.com/googleapis/release-please); every release is listed in the [changelog](CHANGELOG.md) and on the [releases page](https://github.com/orafaelfragoso/crewyard/releases). See the [release process](docs/releasing.md) for how npm packages and platform binaries are built and published.

Licensed under the [MIT License](LICENSE). Copyright © 2026 Rafael Fragoso.

---

<div align="center">
  <p><strong>More agents. Less coordination overhead.</strong></p>
  <sub>Built for developers who want autonomous work to reach a safe, reviewable merge.</sub>
  <br /><br />
  <a href="#quick-start">Get started</a> · <a href="docs/architecture/overview.md">Explore the architecture</a> · <a href="https://github.com/orafaelfragoso/crewyard/issues">Issues</a>
</div>
