# Finding format

Each finding is one object. Crewyard deduplicates findings by location plus semantic signature, so keep `title` stable when re-reporting the same issue.

```json
{
  "reviewedSha": "3f2c9e1d7a...",
  "reviewType": "code",
  "verdict": "changes_requested",
  "findings": [
    {
      "id": "F1",
      "severity": "high",
      "confidence": "high",
      "category": "correctness",
      "path": "src/auth/claims.ts",
      "range": { "startLine": 42, "endLine": 47 },
      "title": "Expired tokens accepted when clock skew is negative",
      "reason": "`exp` is compared with `now + skew`; a negative skew extends validity.",
      "evidence": "Test `rejects expired token` passes only because skew is 0 in fixtures.",
      "suggestedFix": "Compare with `now - Math.abs(skew)` and add a test with skew = -30.",
      "status": "open"
    }
  ]
}
```

| Field | Values |
|---|---|
| `reviewType` | `code`, `security`, `integration` |
| `verdict` | `approved_for_policy`, `changes_requested`, `needs_operator` |
| `severity` | `critical`, `high`, `medium`, `low`, `info` |
| `confidence` | `high`, `medium`, `low` |
| `category` | e.g. `correctness`, `security`, `contract`, `tests`, `maintainability`, `prompt-injection` |
| `status` | `open`, `accepted`, `dismissed`, `resolved` |

`approved_for_policy` means the review found no blocking issues. It does not satisfy GitHub required reviews or checks.
