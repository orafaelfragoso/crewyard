# Security policy

## Supported versions

Crewyard is pre-1.0. Security fixes land on `main` and ship in the next release; only the latest release is supported.

| Version | Supported |
|---|---|
| Latest release | ✓ |
| Older releases | — |

## Report a vulnerability

Do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through [GitHub private vulnerability reporting](https://github.com/orafaelfragoso/crewyard/security/advisories/new). Include:

- the affected version (`crew version --json`) and platform
- what an attacker can do, and the conditions they need
- steps or a proof of concept that reproduce it

You can expect an acknowledgement within 3 business days and an assessment within 10. Once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Scope

In scope: the `crew` CLI and binaries, the MCP server, the `crewyard` and `@crewyard/*` npm packages, the Skills, and the release pipeline in this repository.

Especially relevant, given what Crewyard does:

- an agent bypassing a lease, scope reservation, approval gate or policy
- secrets reaching logs, events, the database, backups, worktrees or agent prompts
- path traversal or symlink escapes from task worktrees
- a GitHub merge or push that skips repository protections or happens twice
- tampering with release artifacts or npm packages

Out of scope: vulnerabilities in the agent CLIs, LLM providers or GitHub themselves, and attacks that need someone who already controls your user account.

See the [security model](docs/policies/security-model.md) for the trust boundaries Crewyard is designed to enforce.
