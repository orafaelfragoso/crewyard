# `rail doctor`

`rail doctor` checks that this machine can run Agent Rail and reports how to fix what is missing. It changes nothing; repairs are printed as commands for you to run.

```bash
rail doctor            # human-readable report
rail doctor --json     # { "generatedAt", "status", "checks": [ { "id", "category", "status", "summary", "detail", "repair" } ] }
```

Each check has a status: `ok`, `warn` (works with reduced capability), `error` (Rail cannot work correctly) or `skip` (not applicable, for example a provider CLI that is not installed). The overall status is the worst check status. The process exits non-zero when the overall status is `error`.

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
| `security.secret_store` | security | The OS secret store can store and read a probe value |
| `hosts.*` | hosts | Which agent hosts are installed, their versions, and whether `rail mcp` is registered |
| `github.*` | github | Remote owner/repo matches the project, token scopes, branch rules and merge queue availability |
| `index.*` | index | Index presence and freshness against the current base commit |

The `hosts`, `github` and `index` checks run when a project is selected (inside an initialized repository or with `--project`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `tools.git` error: version too old | Git < 2.38 | Upgrade Git. |
| `tools.gh` warn: not authenticated | No `gh` login, or an expired token | `gh auth login`; use minimum scopes (`repo`, read access to workflows). For several GitHub identities, keep separate `GH_CONFIG_DIR` environments. |
| `fs.*` warn: permissions too open | Data directory readable by other users | Run the printed `chmod 700 '<path>'`. |
| `fs.*` error: not writable | Read-only or missing directory | Fix permissions or set `RAIL_DATA_DIR` to a writable local directory. |
| `sqlite.wal` or `sqlite.locking` error | Data directory on a network share, a synced folder or a virtual filesystem | Move it to a local disk with `RAIL_DATA_DIR`. |
| `sqlite.schema` warn: pending migrations | Rail was upgraded | Run any `rail` command; a backup is written before migrating. |
| `SCHEMA_TOO_NEW` (exit 8) | Database written by a newer Rail | Upgrade Rail, or [restore a backup](installation.md#back-up-and-restore). |
| `security.secret_store` error | No Secret Service on Linux (headless or minimal desktop), locked keychain | Install and unlock a Secret Service provider (for example GNOME Keyring or KeePassXC), or set `security.credential_store: encrypted-file` explicitly. |
| `provider.<id>` skip | That CLI is not installed | Install it only if you plan to use that provider. |
| Rail tools missing in an agent host | MCP server not registered, host not restarted, or project-level config not trusted | `rail install --target <host> --dry-run`, then install; restart the host. See [mcp-hosts.md](mcp-hosts.md). |
| `rail install` prints manual instructions | The host config is unparseable, has a foreign `agent-rail` entry, or the host version is newer than Rail has verified | Apply the printed snippet or command yourself, or fix the file and re-run. |
| `BUSY` errors under load | Many writers contending for the database | Rail retries with a bounded busy timeout; if persistent, see [runbooks](incident-recovery/runbooks.md#database-busy-or-corrupted). |
| `INDEX_STALE` | The requested commit is not indexed | `rail index update` (or the recovery action in the error). |

## Sharing a report

`rail doctor --json` output contains paths and versions but no secrets. Review it before attaching it to an issue.
