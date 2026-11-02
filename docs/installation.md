# Installation, upgrades and data

## Choose a package

| Package | When to use | Runtime needed |
|---|---|---|
| Release binary `rail-<os>-<arch>` | Default. Single file, no runtime. | None |
| npm package `agent-rail` with Bun | Platforms without a binary, or if you already manage tools with Bun | Bun 1.4.4+ |
| Source checkout | Development | Bun 1.4.4+ |

Release binaries are built with `bun build --compile` for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64` and `bun-windows-x64`. Every release has a `manifest.json` listing each target as `available` (with its SHA-256) or `unavailable` (with the reason and the Bun-runtime alternative). If your target is unavailable, use the Bun runtime install.

All packages need Git 2.38+. GitHub integration needs the GitHub CLI (`gh`) logged in.

## Install a release binary

Each release contains the binaries, `manifest.json`, `sbom.cdx.json` (CycloneDX 1.6) and `SHA256SUMS`, which covers every other asset. Release assets carry GitHub artifact attestations (SLSA build provenance, plus an SBOM attestation for the binaries).

```bash
VERSION=v1.0.0
ASSET=rail-linux-x64          # rail-linux-arm64, rail-darwin-arm64, rail-darwin-x64, rail-windows-x64.exe
BASE=https://github.com/orafaelfragoso/agent-rail/releases/download/$VERSION
curl -LO "$BASE/$ASSET" -LO "$BASE/SHA256SUMS"

sha256sum --ignore-missing -c SHA256SUMS          # macOS: shasum -a 256 --ignore-missing -c SHA256SUMS
gh attestation verify "$ASSET" --repo orafaelfragoso/agent-rail

install -m 755 "$ASSET" ~/.local/bin/rail
rail version
```

On Windows (PowerShell), compare `(Get-FileHash .\rail-windows-x64.exe -Algorithm SHA256).Hash` with the line in `SHA256SUMS`, then place `rail.exe` in a directory on `PATH`.

macOS may quarantine downloaded binaries. After verifying the checksum and attestation: `xattr -d com.apple.quarantine ~/.local/bin/rail`.

## Install with the Bun runtime

Agent Rail is not yet published to npm; the workspace packages are private. Until a package is published, the Bun-runtime install is a source checkout (below), run with `bun apps/cli/src/main.ts` or linked as `rail`:

```bash
git clone git@github.com:orafaelfragoso/agent-rail.git && cd agent-rail
bun install --frozen-lockfile
ln -s "$PWD/apps/cli/src/main.ts" ~/.local/bin/rail   # requires bun on PATH (shebang)
rail version
```

When npm publishing is enabled for a release, `bun install -g agent-rail` will provide the same `rail` command.

## Install from source

```bash
git clone https://github.com/orafaelfragoso/agent-rail.git
cd agent-rail
bun install --frozen-lockfile
bun run rail doctor           # runs apps/cli/src/main.ts
alias rail="bun $PWD/apps/cli/src/main.ts"
```

## First run

```bash
rail doctor                   # see docs/doctor.md
rail init --repo .
rail install --target codex,claude,opencode --dry-run
rail install --target codex,claude,opencode
```

`rail install` registers `rail mcp` with each host and installs the Skills; see [mcp-hosts.md](mcp-hosts.md).

## Where data lives

| Platform | Data | User config |
|---|---|---|
| Linux | `$XDG_DATA_HOME/agent-rail` (default `~/.local/share/agent-rail`) | `$XDG_CONFIG_HOME/agent-rail` (default `~/.config/agent-rail`) |
| macOS | `~/Library/Application Support/agent-rail` | `~/Library/Preferences/agent-rail` |
| Windows | `%LOCALAPPDATA%\agent-rail` | `%APPDATA%\agent-rail` |

`RAIL_DATA_DIR` overrides the data directory (config then defaults to `$RAIL_DATA_DIR/config`); `RAIL_CONFIG_DIR` overrides the config directory. The data directory must be on a local filesystem that supports SQLite WAL and file locking.

```text
agent-rail/
  agent-rail.sqlite         # state, events, audit (WAL mode)
  cache/index/
  worktrees/<workspace-id>/
  artifacts/<artifact-id>/
  logs/<session-id>/
  backups/                  # database backups and host-installer backups
  run/
```

Repository configuration is `.agent-rail/config.yaml` in the repository (safe to commit, no secrets). User overrides are `config.yaml` in the user config directory. Precedence: CLI flags > `RAIL_*` environment variables > repository config > user config > defaults. See the [annotated example](examples/config.yaml).

Credentials are never in these files: they stay in the OS secret store (macOS Keychain, Windows Credential Manager, Linux Secret Service) or in the provider CLI's own login.

## Upgrade

1. Stop the service: `rail service stop`. Close agent hosts running `rail mcp`.
2. Replace the binary (verify as above), or `git pull && bun install --frozen-lockfile` for a source install.
3. Run `rail doctor`. The first command after an upgrade applies pending database migrations.
4. Re-run `rail install --target ...` to refresh the installed Skills; it only changes Rail-owned content.
5. Start the service again: `rail service start`.

### Database migrations

- Migrations are versioned files with recorded checksums. A database migrated by a different build of the same version is refused.
- Before applying migrations to an existing database, Rail writes a consistent backup with `VACUUM INTO` to `backups/pre-migration-v<N>-<timestamp>-<pid>.sqlite`.
- Migrations run in a transaction. If one fails, the database stays at the previous version.
- A database created by a newer Rail is refused with `SCHEMA_TOO_NEW` (exit code 8). Upgrade Rail, or restore a backup made by your version.
- `rail doctor` reports pending migrations (`sqlite.schema`).

## Back up and restore

Never copy `agent-rail.sqlite` while Rail is running: the WAL file holds recent transactions. Use the backups Rail writes (they are consistent snapshots), or stop every Rail process first.

Restore a backup:

```bash
rail service stop             # and close agent hosts running `rail mcp`
cd ~/.local/share/agent-rail  # your data directory
mkdir -p backups/replaced
mv agent-rail.sqlite agent-rail.sqlite-wal agent-rail.sqlite-shm backups/replaced/ 2>/dev/null
cp backups/pre-migration-v3-2026-11-02T12-00-00Z-4242.sqlite agent-rail.sqlite
rail doctor
```

After a restore, state is as of the backup. Rail reconciles with reality on the next start: live sessions and worktrees are inspected, GitHub PR/check/merge state is re-read and treated as authoritative, and stale leases are fenced. See [runbooks](incident-recovery/runbooks.md#database-busy-or-corrupted).

### Re-authorize providers after a restore or a move

Backups exclude credentials by design. Account profiles in the database only reference secrets.

1. `rail account list` shows the profiles from the backup.
2. For CLI-login providers (Codex, Claude Code, OpenCode), log in again with the provider's own CLI if the session is gone (for example `codex login`, `claude auth`, `opencode auth login`).
3. For API-key profiles, store the key again: `rail account add --provider <id> --name <profile>` (Rail writes it to the OS secret store).
4. `rail account test <profile>` for each profile, then `rail doctor` (`security.secret_store`, `provider.*`).
5. `gh auth status`; run `gh auth login` if needed.

## Uninstall

```bash
rail uninstall --target codex,claude,opencode --dry-run
rail uninstall --target codex,claude,opencode   # removes only Rail-owned entries, Skills and instruction blocks
rail service uninstall                          # if you installed the user service
```

Then remove the binary (`rm ~/.local/bin/rail`, `bun remove -g agent-rail`, or delete the checkout). To delete all local state, remove the data and config directories listed above; worktrees under `worktrees/` may contain unmerged work, so check `rail workspace list` first. Credentials Rail stored in the OS secret store are listed by `rail account list`; remove them with `rail account remove <profile>` before deleting the data directory.
