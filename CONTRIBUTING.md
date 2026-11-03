# Contributing to Crewyard

Thanks for helping. This guide covers how to propose a change and what a pull request needs to be merged.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in an issue.

## Before you start

- **Bugs:** search the [issues](https://github.com/orafaelfragoso/crewyard/issues) first, then open one with the bug report form.
- **Features and design changes:** open a feature request and wait for agreement on the approach before writing a large change.
- **Small fixes** (typos, docs, obvious bugs) can go straight to a pull request.

## Set up

Requirements: [Bun 1.4.4](https://bun.sh/) (pinned in `mise.toml`), Git 2.38+, and the GitHub CLI for the GitHub integration tests.

```bash
git clone https://github.com/orafaelfragoso/crewyard.git
cd crewyard
bun install --frozen-lockfile
bun run crew doctor
```

## Make a change

Code conventions are in [AGENTS.md](AGENTS.md). The short version:

- TypeScript strict; Biome formats and lints.
- Packages import each other only by package name (`@crewyard/<name>`).
- State changes write their event in the same transaction; external side effects go through the outbox.
- Never log or persist secrets.
- Comments only where the code cannot speak for itself.
- Tests stay focused: one behavior per test, no smoke tests for their own sake.

Before you push:

```bash
bun run typecheck
bun run lint
bun test
```

If you change CLI commands or options, regenerate the reference with `bun run docs:cli` and commit the result.

## Pull requests

- Keep each pull request to one change.
- Title it as a [Conventional Commit](https://www.conventionalcommits.org/): `feat: add queue pause command`, `fix(github): retry rate-limited syncs`, `docs: clarify recovery runbook`. Allowed types: `feat`, `fix`, `perf`, `revert`, `docs`, `deps`, `refactor`, `test`, `build`, `ci`, `chore`. Mark breaking changes with `!` (`feat!: …`) and explain them in the body.
- Pull requests are squash-merged: the title becomes the commit on `main` and the first changelog entry, and the body becomes the commit message.
- End the body with a `## Changelog` section that lists every other user-visible change, one Conventional Commit line each, so each one gets its own changelog entry. Write `none` when the title covers the whole change. Put a blank line between entries: release-please only splits out an entry that follows an empty line, and drops or truncates entries on consecutive lines. Entries can use every type except `deps`.

  ```markdown
  ## Changelog

  feat(agents): add `crew agent` create, list and remove

  fix(storage): migrate the agents table without losing rows
  ```

- To correct the changelog of a merged pull request, add a `BEGIN_COMMIT_OVERRIDE` … `END_COMMIT_OVERRIDE` block with the corrected lines to its body before the release pull request is merged.
- Every change reaches `main` through a pull request, so it appears in the changelog with a link.
- CI must pass on Linux and macOS.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). Every merge to `main` updates a release pull request with the next version and the `CHANGELOG.md` entries. Merging that pull request tags the release, publishes the binaries and the npm packages. See [docs/releasing.md](docs/releasing.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
