# Getting started

This guide takes you from nothing to an agent working on a task in your repository, in about 15 minutes. Every command here was run as written.

## How the pieces fit

Crewyard has four kinds of things. Set them up in this order:

| Thing | What it is | Example |
|---|---|---|
| **Project** | A Git repository Crewyard coordinates | your repo, registered with `crew init` |
| **Account** | A login for an agent CLI you already use | your Claude Code login: `claude/personal` |
| **Agent** | A worker with a role that uses an account | `engineer` (writes code) using `claude/personal` |
| **Goal → tasks** | What you want done, split into tasks with dependencies | "Add a greeting helper" → TASK-1, TASK-2 |

Agents do the work; the **service** (`crew service start`) keeps handing ready tasks to agents in the background.

## 1. Before you start

You need:

- Git 2.38 or newer
- At least one agent CLI installed and logged in: [Claude Code](https://code.claude.com/docs) (`claude`), [Codex CLI](https://github.com/openai/codex) (`codex`) or [OpenCode](https://opencode.ai) (`opencode`)
- The [GitHub CLI](https://cli.github.com/), logged in with `gh auth login`, if you want Crewyard to open and merge pull requests
- Node.js 22+ to install from npm

## 2. Install

```bash
npm install --global crewyard
crew doctor
```

`crew doctor` checks your machine. Every line should say `OK`; a `provider.*` line that is not OK means that agent CLI is missing. Fix those first ([what each check means](doctor.md)).

## 3. Register your repository

```bash
cd ~/src/my-repo
crew init --repo .
```

This writes `.crewyard/config.yaml` (safe to commit), indexes the code, and prints a readiness report. The ✗ lines tell you what is still missing; the next steps fix them.

For pull requests, the repository needs a GitHub `origin` remote.

## 4. Add an account

An account tells Crewyard how to log in to an agent CLI. If you are already logged in to the CLI on this machine, reuse that login:

```bash
crew account add --provider claude --name personal --use-default-config
crew account test claude/personal
```

`crew account test` should print `"status": "healthy"`. Use `--provider codex` or `--provider opencode` the same way.

Want a separate login for Crewyard, or several accounts for one provider? See [Accounts](accounts.md).

## 5. Create agents

Each agent has a **role** and uses an account. Most setups need three:

```bash
crew agent create --name architect --role architect --provider claude --account claude/personal
crew agent create --name engineer  --role engineer  --provider claude --account claude/personal
crew agent create --name reviewer  --role reviewer  --provider claude --account claude/personal
crew agent list
```

- **architect** turns a goal into a task plan
- **engineer** implements tasks (the default role)
- **reviewer** reviews the work before it is merged

Agents can use different providers: for example a Claude architect and a Codex engineer.

## 6. Connect your agent tools (optional)

This lets Claude Code, Codex and OpenCode sessions you start yourself see Crewyard's tasks and tools:

```bash
crew install --target codex,claude,opencode --dry-run   # shows every file it would change
crew install --target codex,claude,opencode
```

It registers `crew mcp` as an MCP server and installs the `crew-*` Skills, backing up anything it changes. `crew uninstall` restores the originals. See [MCP host setup](mcp-hosts.md).

## 7. Give Crewyard a goal

```bash
crew goal create --title "Add a greeting helper" --description "Add greet(name) to src/greet.ts with a test."
```

It prints the goal ID, such as `GOAL-1`. Then plan it, in one of two ways.

**Let the architect plan it.** Plans written by an AI wait for your approval:

```bash
crew goal plan GOAL-1 --agent architect
crew goal status GOAL-1                # read the proposed tasks
crew goal approve GOAL-1 --yes         # creates the tasks
```

**Or write the plan yourself** as YAML or JSON. Your own plans are accepted immediately:

```yaml
# plan.yaml
summary: Add a greeting helper
tasks:
  - key: greet
    title: Add greet(name)
    objective: Add an exported greet(name) to src/greet.ts that returns "Hello, <name>!".
    acceptanceCriteria: ["greet('Ada') returns 'Hello, Ada!'"]
    dependencies: []
    scopeHints: [src/greet.ts]
    risk: low
  - key: greet-test
    title: Test greet
    objective: Add a unit test for greet.
    acceptanceCriteria: ["the test fails if greet changes its output"]
    dependencies: [greet]
    scopeHints: [src/greet.test.ts]
    risk: low
```

```bash
crew goal plan GOAL-1 --file plan.yaml
crew task list
```

```text
ID      STATE  PRIORITY  RISK  TITLE            DEPS
TASK-1  READY  50        low   Add greet(name)  []
TASK-2  READY  50        low   Test greet       ["TASK-1"]
```

Whether AI plans need approval depends on `autonomy` in `.crewyard/config.yaml`: `guarded` (the default) asks for AI plans only, `observe` and `assisted` ask for every plan, `autopilot` never asks.

## 8. Run one task and watch it

Before you let Crewyard run on its own, watch a single task:

```bash
crew agent run engineer --task TASK-1
```

The engineer claims the task, gets its own Git worktree (your checkout is never touched), and works in the foreground until it finishes. `crew task show TASK-1` shows where the task ended up.

## 9. Let it run

```bash
crew service start      # dispatches ready tasks, syncs GitHub, runs the merge queue
crew dashboard          # live view of tasks, agents, PRs and alerts
```

Useful while it runs:

| Question | Command |
|---|---|
| Why isn't TASK-2 running? | `crew task explain TASK-2` |
| What is each agent doing? | `crew agent sessions` |
| Show a session's output | `crew agent logs <sessionId>` |
| Why isn't a PR merging? | `crew queue explain --pr <number>` |
| Is the service up? | `crew service status` |
| Stop it | `crew service stop` |

To keep the service running across reboots, use `crew service install`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `crew account test` says `unauthenticated` | Run the command it suggests: `crew account login <account>` |
| `error APPROVAL_REQUIRED … confirmation required` | Add `--yes` to approve, or `--dry-run` to preview |
| `Goal … has no plan awaiting approval` | The plan was already accepted. Check `crew task list` |
| Tasks stay `READY` | The service isn't running (`crew service start`), or see `crew task explain <task>` |
| `✗ remote` in the readiness report | Add a GitHub `origin` remote and run `gh auth login` |

More in [`crew doctor`](doctor.md) and the [recovery runbooks](incident-recovery/runbooks.md). Every command is in the [CLI reference](reference/cli.md).
