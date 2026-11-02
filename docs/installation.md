# Installation, upgrades and data

## Choose a package

| Package | When to use | Runtime needed |
|---|---|---|
| Release binary `crew-<os>-<arch>` | Default. Single file, no runtime. | None |
| npm package `crewyard` with Bun | Platforms without a binary, or if you already manage tools with Bun | Bun 1.4.4+ |
| Source checkout | Development | Bun 1.4.4+ |

Release binaries are built with `bun build --compile` for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64` and `bun-windows-x64`. Every release has a `manifest.json` listing each target as `available` (with its SHA-256) or `unavailable` (with the reason and the Bun-runtime alternative). If your target is unavailable, use the Bun runtime install.

All packages need Git 2.38+. GitHub integration needs the GitHub CLI (`gh`) logged in.

## Install a release binary

Each release contains the binaries, `manifest.json`, `sbom.cdx.json` (CycloneDX 1.6) and `SHA256SUMS`, which covers every other asset. Release assets carry GitHub artifact attestations (SLSA build provenance, plus an SBOM attestation for the binaries).

```bash
VERSION=v1.0.0
ASSET=crew-linux-x64          # crew-linux-arm64, crew-darwin-arm64, crew-darwin-x64, crew-windows-x64.exe
BASE=https://github.com/orafaelfragoso/crewyard/releases/download/$VERSION
curl -LO "$BASE/$ASSET" -LO "$BASE/SHA256SUMS"

sha256sum --ignore-missing -c SHA256SUMS          # macOS: shasum -a 256 --ignore-missing -c SHA256SUMS
gh attestation verify "$ASSET" --repo orafaelfragoso/crewyard

install -m 755 "$ASSET" ~/.local/bin/crew
crew version
```

On Windows (PowerShell), compare `(Get-FileHash .\crew-windows-x64.exe -Algorithm SHA256).Hash` with the line in `SHA256SUMS`, then place `crew.exe` in a directory on `PATH`.

macOS may quarantine downloaded binaries. After verifying the checksum and attestation: `xattr -d com.apple.quarantine ~/.local/bin/crew`.

## Install with the Bun runtime

Crewyard is not yet published to npm; the workspace packages are private. Until a package is published, the Bun-runtime install is a source checkout (below), run with `bun apps/cli/src/main.ts` or linked as `crew`:

```bash
git clone git@github.com:orafaelfragoso/crewyard.git && cd crewyard
bun install --frozen-lockfile
ln -s "$PWD/apps/cli/src/main.ts" ~/.local/bin/crew   # requires bun on PATH (shebang)
crew version
```

When npm publishing is enabled for a release, `bun install -g crewyard` will provide the same `crew` command.

## Install from source

```bash
git clone https://github.com/orafaelfragoso/crewyard.git
cd crewyard
bun install --frozen-lockfile
bun run crew doctor           # runs apps/cli/src/main.ts
alias crew="bun $PWD/apps/cli/src/main.ts"
```

## First run

```bash
crew doctor                   # see docs/doctor.md
crew init --repo .
crew install --target codex,claude,opencode --dry-run
crew install --target codex,claude,opencode
```

`crew install` registers `crew mcp` with each host and installs the Skills; see [mcp-hosts.md](mcp-hosts.md).

## Where data lives

| Platform | Data | User config |
|---|---|---|
| Linux | `$XDG_DATA_HOME/crewyard` (default `~/.local/share/crewyard`) | `$XDG_CONFIG_HOME/crewyard` (default `~/.config/crewyard`) |
| macOS | `~/Library/Application Support/crewyard` | `~/Library/Preferences/crewyard` |
| Windows | `%LOCALAPPDATA%\crewyard` | `%APPDATA%\crewyard` |

`CREW_DATA_DIR` overrides the data directory (config then defaults to `$CREW_DATA_DIR/config`); `CREW_CONFIG_DIR` overrides the config directory. The data directory must be on a local filesystem that supports SQLite WAL and file locking.

```text
crewyard/
  crewyard.sqlite         # state, events, audit (WAL mode)
  cache/index/
  worktrees/<workspace-id>/
  artifacts/<artifact-id>/
  logs/<session-id>/
  backups/                  # database backups and host-installer backups
  run/
```

Repository configuration is `.crewyard/config.yaml` in the repository (safe to commit, no secrets). User overrides are `config.yaml` in the user config directory. Precedence: CLI flags > `CREW_*` environment variables > repository config > user config > defaults. See the [annotated example](examples/config.yaml).

Credentials are never in these files: they stay in the OS secret store (macOS Keychain, Windows Credential Manager, Linux Secret Service) or in the provider CLI's own login.

## Upgrade

1. Stop the service: `crew service stop`. Close agent hosts running `crew mcp`.
2. Replace the binary (verify as above), or `git pull && bun install --frozen-lockfile` for a source install.
3. Run `crew doctor`. The first command after an upgrade applies pending database migrations.
4. Re-run `crew install --target ...` to refresh the installed Skills; it only changes Crewyard-owned content.
5. Start the service again: `crew service start`.

### Database migrations

- Migrations are versioned files with recorded checksums. A database migrated by a different build of the same version is refused.
- Before applying migrations to an existing database, Crewyard writes a consistent backup with `VACUUM INTO` to `backups/pre-migration-v<N>-<timestamp>-<pid>.sqlite`.
- Migrations run in a transaction. If one fails, the database stays at the previous version.
- A database created by a newer Crewyard is refused with `SCHEMA_TOO_NEW` (exit code 8). Upgrade Crewyard, or restore a backup made by your version.
- `crew doctor` reports pending migrations (`sqlite.schema`).

## Back up and restore

Never copy `crewyard.sqlite` while Crewyard is running: the WAL file holds recent transactions. Use the backups Crewyard writes (they are consistent snapshots), or stop every Crewyard process first.

Restore a backup:

```bash
crew service stop             # and close agent hosts running `crew mcp`
cd ~/.local/share/crewyard  # your data directory
mkdir -p backups/replaced
mv crewyard.sqlite crewyard.sqlite-wal crewyard.sqlite-shm backups/replaced/ 2>/dev/null
cp backups/pre-migration-v3-2026-11-02T12-00-00Z-4242.sqlite crewyard.sqlite
crew doctor
```

After a restore, state is as of the backup. Crewyard reconciles with reality on the next start: live sessions and worktrees are inspected, GitHub PR/check/merge state is re-read and treated as authoritative, and stale leases are fenced. See [runbooks](incident-recovery/runbooks.md#database-busy-or-corrupted).

### Re-authorize providers after a restore or a move

Backups exclude credentials by design. Account profiles in the database only reference secrets.

1. `crew account list` shows the profiles from the backup.
2. For CLI-login providers (Codex, Claude Code, OpenCode), log in again with the provider's own CLI if the session is gone (for example `codex login`, `claude auth`, `opencode auth login`).
3. For API-key profiles, store the key again: `crew account add --provider <id> --name <profile>` (Crewyard writes it to the OS secret store).
4. `crew account test <profile>` for each profile, then `crew doctor` (`security.secret_store`, `provider.*`).
5. `gh auth status`; run `gh auth login` if needed.

## Uninstall

```bash
crew uninstall --target codex,claude,opencode --dry-run
crew uninstall --target codex,claude,opencode   # removes only Crewyard-owned entries, Skills and instruction blocks
crew service uninstall                          # if you installed the user service
```

Then remove the binary (`rm ~/.local/bin/crew`, `bun remove -g crewyard`, or delete the checkout). To delete all local state, remove the data and config directories listed above; worktrees under `worktrees/` may contain unmerged work, so check `crew workspace list` first. Credentials Crewyard stored in the OS secret store are listed by `crew account list`; remove them with `crew account remove <profile>` before deleting the data directory.
