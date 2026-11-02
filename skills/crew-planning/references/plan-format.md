# Plan format

Use the output schema provided by the planning session when there is one. Otherwise return one JSON object in this shape. Field names map to Crewyard task fields; unknown fields are rejected.

```json
{
  "goalId": "GOAL-1",
  "summary": "Add JWT authentication to the API",
  "tasks": [
    {
      "id": "T1",
      "title": "Add token claims schema",
      "objective": "Define the JWT claims type and validation used by the API and the CLI.",
      "acceptanceCriteria": [
        "Claims schema rejects tokens without `sub` and `exp` (unit test)",
        "`bun test tests/unit/auth` passes"
      ],
      "risk": "high",
      "priority": 80,
      "dependsOn": [],
      "scopeHints": ["src/auth/claims.ts", "tests/unit/auth/**"],
      "exclusiveResources": [],
      "requestedRole": "engineer",
      "tests": ["bun test tests/unit/auth"],
      "contracts": ["Claims type exported from src/auth/index.ts"]
    },
    {
      "id": "T2",
      "title": "Validate tokens in request middleware",
      "objective": "Reject requests with invalid or expired tokens.",
      "acceptanceCriteria": ["Expired token returns 401 (integration test)"],
      "risk": "high",
      "priority": 70,
      "dependsOn": ["T1"],
      "scopeHints": ["src/http/middleware/**"],
      "exclusiveResources": [],
      "requestedRole": "engineer",
      "tests": ["bun test tests/integration/http"],
      "contracts": []
    }
  ],
  "risks": ["Touches security-sensitive paths: approval required before integration."],
  "openQuestions": []
}
```

| Field | Notes |
|---|---|
| `id` | Unique within the plan. Crewyard assigns stable task IDs on import. |
| `risk` | `low`, `medium` or `high`. Sensitive paths (auth, payments, migrations, deployment, dependencies) are `high`. |
| `priority` | Integer; higher runs first. Crewyard adds unblock value, age and fairness. |
| `dependsOn` | Plan IDs or existing task IDs. Must not form a cycle. |
| `scopeHints` | Paths or globs the task is expected to touch. Drives reservations and conflict prediction. |
| `exclusiveResources` | Named resources that only one task may hold, such as `db-schema`. |
| `tests` | Commands that prove the acceptance criteria. |
| `contracts` | Public interfaces the task creates or changes. |
