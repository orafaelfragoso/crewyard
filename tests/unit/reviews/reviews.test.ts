import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type CrewConfig, crewConfigSchema } from '@crewyard/config';
import {
  type ContextFingerprintProvider,
  classifyPaths,
  invalidateReviews,
  listFindings,
  normalizePatch,
  type Reviewer,
  type ReviewInput,
  requestReview,
  runValidation,
  StaticAnalysisReviewer,
  type StructuredFindings,
  selectValidation,
  updateFindingStatus,
} from '@crewyard/reviews';
import { all } from '@crewyard/storage';
import { createTestContext, type TestContext, tempDir } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

function diff(path: string, removed: string[], added: string[], context = ['  // ctx']): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${removed.length + context.length} +1,${added.length + context.length} @@`,
    ...context.map((c) => ` ${c}`),
    ...removed.map((r) => `-${r}`),
    ...added.map((a) => `+${a}`),
    '',
  ].join('\n');
}

class CountingReviewer implements Reviewer {
  readonly identity: string;
  readonly model = 'test-model-1';
  readonly promptVersion = 'p1';
  calls: ReviewInput[] = [];
  constructor(
    identity = 'llm-reviewer',
    private readonly result: StructuredFindings = { confidence: 0.9, findings: [] },
  ) {
    this.identity = identity;
  }
  async review(input: ReviewInput): Promise<StructuredFindings> {
    this.calls.push(input);
    return this.result;
  }
}

class Context implements ContextFingerprintProvider {
  schema = 'schema-v1';
  async interfaceFingerprint(): Promise<string> {
    return this.schema;
  }
  async relatedDependencyFingerprint(): Promise<string> {
    return `deps:${this.schema}`;
  }
  async symbolGraphRevision(): Promise<string | null> {
    return 'graph-1';
  }
}

function setup(overrides: Record<string, unknown> = {}): {
  ctx: TestContext;
  repositoryId: string;
  config: CrewConfig;
} {
  const c = createTestContext();
  const at = '2026-11-02T12:00:00Z';
  c.store.db.query(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('prj_1', 'p', ?, ?)`).run(at, at);
  c.store.db
    .query(
      `INSERT INTO repositories (id, project_id, canonical_path, default_base, created_at, updated_at) VALUES ('repo_1', 'prj_1', '/tmp/x', 'main', ?, ?)`,
    )
    .run(at, at);
  c.store.db
    .query(
      `INSERT INTO pull_requests (id, repository_id, number, title, head_ref, head_sha, base_ref, state, created_at, updated_at) VALUES ('pr_1', 'repo_1', 1, 't', 'h', 'h1', 'main', 'open', ?, ?)`,
    )
    .run(at, at);
  ctx = c;
  return {
    ctx: c,
    repositoryId: 'repo_1',
    config: crewConfigSchema.parse({ version: 1, project: { name: 'p' }, ...overrides }),
  };
}

const PATCH = diff('src/service.ts', ['export const a = 1;'], ['export const a = 2;']);

describe('evidence fingerprint and cache', () => {
  test('normalised patches ignore whitespace and context lines', () => {
    const a = normalizePatch(diff('src/x.ts', ['let a=1;'], ['let a = 2;']));
    const b = normalizePatch(diff('src/x.ts', ['let  a = 1;'], ['let a=2;'], ['  other context']));
    const c = normalizePatch(diff('src/x.ts', ['let a=1;'], ['let a = 3;']));
    expect(a.patchHash).toBe(b.patchHash);
    expect(a.patchHash).not.toBe(c.patchHash);
  });

  test('AT-07: identical evidence reuses the review with zero reviewer invocations', async () => {
    const { ctx: c, repositoryId, config } = setup();
    const reviewer = new CountingReviewer();
    const deps = { reviewers: { code: reviewer }, config, context: new Context() };
    const input = {
      repositoryId,
      prId: 'pr_1',
      commitSha: 'h1',
      baseSha: 'b1',
      patch: PATCH,
      types: ['code' as const],
    };
    const first = await requestReview(c, input, deps);
    const second = await requestReview(c, { ...input, commitSha: 'h2', baseSha: 'b2' }, deps);
    expect(reviewer.calls).toHaveLength(1);
    expect(first.outcomes[0]).toMatchObject({ decision: 'full', reviewerInvoked: true });
    expect(second.outcomes[0]).toMatchObject({ decision: 'reuse', reviewerInvoked: false });
    expect(second.outcomes[0]!.review).toMatchObject({
      reusedFrom: first.outcomes[0]!.review!.id,
      llmInvoked: false,
      commitSha: 'h2',
    });
    expect(second.outcomes[0]!.review!.fingerprintInputs).toMatchObject({
      patchHash: normalizePatch(PATCH).patchHash,
      policyVersion: '1',
    });
  });

  test('AT-08: unchanged patch with a changed relevant schema invalidates reuse and runs integration review', async () => {
    const { ctx: c, repositoryId, config } = setup();
    const code = new CountingReviewer('code-llm');
    const integration = new CountingReviewer('integration-llm');
    const context = new Context();
    const deps = { reviewers: { code, integration }, config, context };
    const input = {
      repositoryId,
      prId: 'pr_1',
      commitSha: 'h1',
      baseSha: 'b1',
      patch: PATCH,
      types: ['code' as const],
    };
    await requestReview(c, input, deps);
    context.schema = 'schema-v2';
    const result = await requestReview(c, input, deps);
    expect(code.calls).toHaveLength(2);
    expect(result.integrationRequired).toBe(true);
    expect(result.outcomes.map((o) => [o.reviewType, o.decision])).toEqual([
      ['code', 'full'],
      ['integration', 'full'],
    ]);
    expect(result.outcomes[0]!.reasons).toEqual(
      expect.arrayContaining(['interface_changed', 'dependency_context_changed']),
    );
    expect(integration.calls).toHaveLength(1);
  });

  test('changed files in bounded scope are reviewed incrementally and earlier findings carry over', async () => {
    const { ctx: c, repositoryId, config } = setup();
    const reviewer = new CountingReviewer('llm', {
      confidence: 0.8,
      findings: [
        { ruleId: 'naming', severity: 'low', confidence: 0.7, path: 'src/a.ts', startLine: 1, reason: 'name' },
      ],
    });
    const deps = { reviewers: { code: reviewer }, config, context: new Context() };
    const two = diff('src/a.ts', ['a'], ['b']) + diff('src/b.ts', ['c'], ['d']);
    await requestReview(
      c,
      { repositoryId, prId: 'pr_1', commitSha: 'h1', baseSha: 'b', patch: two, types: ['code'] },
      deps,
    );
    const changed = diff('src/a.ts', ['a'], ['b']) + diff('src/b.ts', ['c'], ['e']);
    const result = await requestReview(
      c,
      { repositoryId, prId: 'pr_1', commitSha: 'h2', baseSha: 'b', patch: changed, types: ['code'] },
      deps,
    );
    expect(result.outcomes[0]!.decision).toBe('incremental');
    expect(reviewer.calls[1]!.focusPaths).toEqual(['src/b.ts']);
    expect(result.outcomes[0]!.review!.findings.filter((f) => f.path === 'src/a.ts')).toHaveLength(1);
  });

  test('security reviews of sensitive paths are never reused when policy requires review', async () => {
    const { ctx: c, repositoryId, config } = setup();
    const reviewer = new CountingReviewer('sec');
    const deps = { reviewers: { security: reviewer }, config, context: new Context() };
    const patch = diff('src/auth/session.ts', ['x'], ['y']);
    const input = { repositoryId, prId: 'pr_1', commitSha: 'h1', baseSha: 'b', patch, types: ['security' as const] };
    await requestReview(c, input, deps);
    const again = await requestReview(c, input, deps);
    expect(reviewer.calls).toHaveLength(2);
    expect(again.risk).toBe('high');
    expect(again.outcomes[0]!.reasons).toContain('risk_class_forbids_reuse');
  });

  test('invalidation removes evidence from reuse and records the reason', async () => {
    const { ctx: c, repositoryId, config } = setup();
    const reviewer = new CountingReviewer();
    const deps = { reviewers: { code: reviewer }, config, context: new Context() };
    const input = { repositoryId, prId: 'pr_1', commitSha: 'h1', baseSha: 'b', patch: PATCH, types: ['code' as const] };
    await requestReview(c, input, deps);
    expect(invalidateReviews(c, { prId: 'pr_1', reason: 'operator' })).toHaveLength(1);
    await requestReview(c, input, deps);
    expect(reviewer.calls).toHaveLength(2);
  });
});

describe('structured findings', () => {
  test('static analysis flags secrets, debug leftovers and sensitive paths with dedupe and status updates', async () => {
    const { ctx: c, repositoryId, config } = setup();
    const token = `ghp_${'a'.repeat(36)}`;
    const patch =
      diff('src/auth/client.ts', [], [`const token = "${token}";`, 'console.log(token);', 'console.log(token);']) +
      diff('test/a.test.ts', [], ['it.only("x", () => {});']);
    const reviewer = new StaticAnalysisReviewer();
    const result = await requestReview(
      c,
      { repositoryId, prId: 'pr_1', commitSha: 'h1', baseSha: 'b', patch, types: ['code', 'security'] },
      { reviewers: { code: reviewer, security: reviewer }, config },
    );
    const code = result.outcomes.find((o) => o.reviewType === 'code')!.review!;
    expect(code.status).toBe('changes_requested');
    const rules = code.findings.map((f) => f.reason);
    expect(rules).toContain('Possible secret committed in source');
    expect(rules).toContain('Focused test disables the rest of the suite');
    expect(code.findings.filter((f) => f.reason.startsWith('Debug logging'))).toHaveLength(2);
    expect(JSON.stringify(code.findings)).not.toContain(token);
    const security = result.outcomes.find((o) => o.reviewType === 'security')!.review!;
    expect(security.findings.map((f) => f.reason)).toContain(
      'Change touches security-sensitive paths and needs operator attention',
    );
    for (const finding of code.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')) {
      updateFindingStatus(
        c,
        { findingId: finding.id, status: 'dismissed', note: 'test fixture' },
        { kind: 'operator', id: 'op' },
      );
    }
    expect(
      all<{ status: string }>(c.store.db, 'SELECT status FROM review_artifacts WHERE id = ?', code.id)[0]!.status,
    ).toBe('passed');
    expect(listFindings(c, { prId: 'pr_1', status: 'dismissed' }).length).toBeGreaterThan(0);
  });

  test('path classification drives risk and approval classes', () => {
    const { config } = setup();
    expect(classifyPaths(config.security, ['docs/readme.md'])).toMatchObject({ risk: 'low', classes: [] });
    expect(classifyPaths(config.security, ['db/migrations/001.sql', 'package.json'])).toMatchObject({
      risk: 'high',
      classes: ['database-migration', 'dependency-change'],
      approvalClasses: ['database-migration'],
    });
  });
});

describe('validation', () => {
  test('selects fast checks by affected paths and broad checks for candidates', () => {
    const { config } = setup({
      validation: {
        fast: [
          { name: 'web', command: 'true', paths: ['web/**'] },
          { name: 'api', command: 'true', paths: ['api/**'] },
          { name: 'lint', command: 'true' },
        ],
        broad: [{ name: 'all', command: 'true' }],
      },
    });
    expect(selectValidation(config, 'fast', ['api/x.ts']).map((s) => s.name)).toEqual(['api', 'lint']);
    expect(selectValidation(config, 'broad', []).map((s) => s.name)).toEqual(['all']);
  });

  test('runs commands with timeouts and records exact revision, environment and failure fingerprint', async () => {
    const { ctx: c, repositoryId } = setup();
    const cwd = tempDir();
    const win = process.platform === 'win32';
    const commands = [
      { name: 'ok', command: 'echo fine', paths: [], timeout_seconds: 10 },
      {
        name: 'unit',
        command: win ? 'echo boom at 12ms & exit /b 3' : 'echo "boom at 12ms"; exit 3',
        paths: [],
        timeout_seconds: 10,
      },
      { name: 'never', command: win ? 'exit /b 0' : 'true', paths: [], timeout_seconds: 10 },
    ];
    const run = await runValidation(c, { repositoryId, scope: 'broad', cwd, commitSha: 'c1', treeSha: 't1', commands });
    expect(run).toMatchObject({
      status: 'failed',
      exitCode: 3,
      commitSha: 'c1',
      treeSha: 't1',
      failureClass: 'test_failure',
    });
    expect(run.commands.map((x) => x.name)).toEqual(['ok', 'unit']);
    expect(readFileSync(run.outputRef!, 'utf8')).toContain('boom');
    const again = await runValidation(c, {
      repositoryId,
      scope: 'broad',
      cwd,
      commitSha: 'c2',
      treeSha: 't2',
      commands,
    });
    expect(again.failureFingerprint).toBe(run.failureFingerprint);
    expect(again.envFingerprint).toBe(run.envFingerprint);
    const slow = await runValidation(c, {
      repositoryId,
      scope: 'fast',
      cwd,
      commitSha: 'c3',
      commands: [{ name: 'slow', command: 'sleep 5', paths: [], timeout_seconds: 1 }],
    });
    expect(slow).toMatchObject({ status: 'failed', failureClass: 'transient_ci' });
  }, 15_000);
});
