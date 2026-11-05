# `crew doctor`

`crew doctor` checks that this machine can run Crewyard and prints repair commands. Like other CLI commands, it
opens local state and applies pending schema migrations, so [quiesce writers before an upgrade](installation.md#upgrade).
Checks may create data directories and perform temporary database/secret-store probes; doctor does not apply the
suggested configuration repairs or start agents.

```bash
crew doctor            # human-readable report
crew doctor --json     # { "generatedAt", "status", "checks": [ { "id", "category", "status", "summary", "detail", "repair" } ] }
```

Each check has a status: `ok`, `warn` (works with reduced capability), `error` (Crewyard cannot work correctly) or `skip` (not applicable, for example a provider CLI that is not installed). The overall status is the worst check status. The process exits non-zero when the overall status is `error`.

`security.execution_isolation` always reports `warn` because Crewyard supplies no OS sandbox. A fully configured
machine therefore need not have an all-`ok` report. Bounded subprocess workers and attempt directories do not
remove this warning; resolve actual errors and assess each warning's stated limitation.

## Checks

| ID | Category | What it verifies |
|---|---|---|
| `runtime.bun` | runtime | Bun runtime version (source/npm installs) or embedded runtime (binaries) |
| `tools.git` | tools | Git is installed and is 2.38+ (needed for `git merge-tree --write-tree`) |
| `tools.gh` | tools | GitHub CLI is installed and `gh auth status` succeeds |
| `fs.<dir>` | storage | Data, config, worktree, log and backup directories exist, are writable and not readable by other users |
| `sqlite.wal` | storage | The database opens in WAL mode on this filesystem |
| `sqlite.schema` | storage | Schema version and pending migrations |
| `sqlite.locking` | storage | File locking works (two connections cannot both hold a write lock) |
| `provider.<id>` | providers | Provider CLIs (`codex`, `claude`, `opencode`, `ollama`) and their versions |
| `security.execution_isolation` | security | Explicitly reports that worktrees, attempt directories and scrubbing are not an OS sandbox |
| `security.secret_store` | security | The OS secret store can store and read a probe value |
| `hosts.*` | hosts | Which agent hosts are installed, their versions, and whether `crew mcp` is registered |
| `github.*` | github | Remote owner/repo matches the project, token scopes, branch rules and merge queue availability |
| `index.*` | index | Index presence and freshness against the current base commit |

The `hosts`, `github` and `index` checks run when a project is selected (inside an initialized repository or with `--project`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `tools.git` error: version too old | Git < 2.38 | Upgrade Git. |
| `tools.gh` warn: not authenticated | No `gh` login, or an expired token | `gh auth login`; use minimum scopes (`repo`, read access to workflows). For several GitHub identities, keep separate `GH_CONFIG_DIR` environments. |
| `fs.*` warn: permissions too open | Data directory readable by other users | Run the printed `chmod 700 '<path>'`. |
| `fs.*` error: not writable | Read-only or missing directory | Fix permissions or set `CREW_DATA_DIR` to a writable local directory. |
| `sqlite.wal` or `sqlite.locking` error | Data directory on a network share, a synced folder or a virtual filesystem | Move it to a local disk with `CREW_DATA_DIR`. |
| `sqlite.schema` warn: pending migrations | Crewyard was upgraded | Stop all service/CLI/MCP writers and provider children first; the current build backs up before migrating. |
| `SCHEMA_TOO_NEW` (exit 8) | Database written by a newer Crewyard | Upgrade Crewyard to the supported schema; never resume an older writer. |
| `security.execution_isolation` warn | No OS sandbox is enforced | Run only trusted commands, or provide isolation outside Crewyard when required. |
| `security.secret_store` error | No Secret Service on Linux (headless or minimal desktop), locked keychain | Install and unlock a Secret Service provider (for example GNOME Keyring or KeePassXC), or set `security.credential_store: encrypted-file` explicitly. |
| `provider.<id>` skip | That CLI is not installed | Install it only if you plan to use that provider. |
| Crewyard tools missing in an agent host | MCP server not registered, host not restarted, or project-level config not trusted | `crew install --target <host> --dry-run`, then install; restart the host. See [mcp-hosts.md](mcp-hosts.md). |
| `crew install` prints manual instructions | The host config is unparseable, has a foreign `crewyard` entry, or the host version is newer than Crewyard has verified | Apply the printed snippet or command yourself, or fix the file and re-run. |
| `BUSY` errors under load | Many writers contending for the database | Crewyard retries with a bounded busy timeout; if persistent, see [runbooks](incident-recovery/runbooks.md#database-busy-or-corrupted). |
| `INDEX_STALE` | The requested commit is not indexed | `crew index update` (or the recovery action in the error). |

## Sharing a report

`crew doctor --json` output contains paths and versions but no secrets. Review it before attaching it to an issue.
