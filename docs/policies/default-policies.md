# Default policies

These are the built-in defaults from `packages/config/src/schema.ts`. Override them in `.crewyard/config.yaml`; see the [annotated example](../examples/config.yaml).

## Sensitive path classes

Paths are matched as globs against repository-relative paths. A change touching any path in a class listed in `security.require_approval_for` waits for operator approval before integration. Setting `security.sensitive_paths` replaces this whole map, so copy the classes you want to keep.

| Class | Default globs | Requires approval by default |
|---|---|---|
| `crew-policy` | `.crewyard/**` (built in, not configurable) | Always |
| `security-sensitive` | `**/auth/**`, `**/authentication/**`, `**/security/**`, `**/permissions/**`, `**/rbac/**`, `**/*secret*`, `**/*credential*`, `**/payments/**`, `**/billing/**`, `**/.env*` | Yes |
| `database-migration` | `**/migrations/**`, `**/migrate/**`, `**/*.sql`, `**/schema.prisma`, `**/alembic/**` | Yes |
| `deployment-config` | `.github/workflows/**`, `**/Dockerfile`, `**/docker-compose*.yml`, `**/k8s/**`, `**/helm/**`, `**/terraform/**`, `**/*.tf`, `**/deploy/**`, `**/infra/**` | Yes |
| `dependency-change` | `**/package.json`, `**/bun.lock`, `**/package-lock.json`, `**/pnpm-lock.yaml`, `**/yarn.lock`, `**/Cargo.toml`, `**/Cargo.lock`, `**/pyproject.toml`, `**/requirements*.txt`, `**/poetry.lock`, `**/uv.lock` | No (add it to `require_approval_for` to enable) |

`high-risk` is also accepted in `require_approval_for` and applies to tasks whose risk is `high`, regardless of paths.

```yaml
security:
  require_approval_for: [security-sensitive, database-migration, deployment-config, dependency-change]
```

## Other defaults that act as policy

| Setting | Default | Effect |
|---|---|---|
| `project.autonomy` | `guarded` | Autonomous execution and merge for eligible low/medium-risk work |
| `integration.mode` | `auto` | GitHub merge queue when the repository has one, otherwise Crewyard-managed serialized integration |
| `integration.require_github_checks` | `true` | Required GitHub checks must pass on the exact head; AI review never substitutes |
| `integration.rebasing` | `only_when_required` | No blanket rebases after the base advances |
| `integration.auto_merge_eligible` | `true` | Must be `false` for `observe`/`assisted` |
| `review.require_review_for_high_risk` | `true` | High-risk tasks need a review before integration |
| `review.cache_enabled` | `true` | Reuse review evidence only for an identical fingerprint |
| `agents.max_retries_per_failure` | `2` | Identical failures beyond this go to `ESCALATED` |
| `agents.allow_profile_fallback` | `false` | No routing to another account profile without opt-in |
| `scheduler.protect_high_risk_scopes` | `true` | Exclusive reservations for high-risk scopes |
| `scheduler.max_open_prs` | `8` | Admission backpressure on new implementation work |
| `security.credential_store` | `system` | OS secret store |
| `security.network` | `provider-and-github-only` | Remote calls only to configured providers and GitHub |
| `index.embedding.consent_external` | `false` | No repository data to external embedding services |
| `observability.local_only` | `true` | Fixed; telemetry never leaves the machine |

## Contradictions rejected by `crew config validate`

The validator rejects unknown keys, invalid enum values, secret-like keys and settings that contradict each other, for example `auto_merge_eligible: true` with `autonomy: observe` or `assisted`, a heartbeat interval longer than half the lease, `require_review_for_high_risk` without `review.enabled`, a non-local embedding endpoint without `consent_external`, a `branch_name_format` without `{task_id}`, or an approval class with no `sensitive_paths` entry.
