import { afterEach, expect, test } from 'bun:test';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crewConfigSchema } from '@crewyard/config';
import { git } from '@crewyard/core';
import {
  collectReviewSource,
  type ReviewAcceptancePolicy,
  type Reviewer,
  requestReview,
  reviewPolicyVersion,
  reviewSummary,
} from '@crewyard/reviews';
import {
  commitFiles,
  createTempGitRepo,
  createTestContext,
  ManualClock,
  type TestContext,
} from '../../helpers/index.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(files: Record<string, string>) {
  const repo = await createTempGitRepo(files);
  cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
  const base = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { repo, base };
}

function reviewContext(repo: string, clock: ManualClock): TestContext {
  const ctx = createTestContext({ clock });
  cleanups.push(() => ctx.cleanup());
  const at = clock.now().toISOString();
  ctx.store.db
    .query('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('project', 'test', at, at);
  ctx.store.db
    .query(
      'INSERT INTO repositories (id, project_id, canonical_path, default_base, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('repo', 'project', repo, 'main', at, at);
  ctx.store.db
    .query(
      'INSERT INTO pull_requests (id, repository_id, number, title, head_ref, head_sha, base_ref, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('pr', 'repo', 1, 'test', 'feature', 'head', 'main', 'open', at, at);
  return ctx;
}

const config = crewConfigSchema.parse({ version: 1, project: { name: 'test' } });
const reviewer: Reviewer = {
  identity: 'fixture',
  model: 'fixture-model',
  promptVersion: '1',
  review: async () => ({ confidence: 0.9, findings: [] }),
};

function acceptance(clock: ManualClock, expectedBaseSha: string): ReviewAcceptancePolicy {
  return {
    at: clock.now().toISOString(),
    expectedBaseSha,
    policyVersion: reviewPolicyVersion(config),
    minConfidence: 0.5,
    cacheEnabled: true,
    requireReviewForHighRisk: true,
    expectedReviewers: { code: reviewer },
  };
}

test('Git evidence preserves literal whitespace, indentation and terminal newlines', async () => {
  const { repo, base } = await fixture({
    'literal.ts': 'export const message = "a b";\n',
    'indent.py': 'if True:\n    print("yes")\n',
  });
  const first = await commitFiles(repo, {
    'literal.ts': 'export const message = "ab";\n',
    'indent.py': 'if True:\n  print("yes")\n',
  });
  const a = await collectReviewSource(repo, base, first, 1024 * 1024);
  const second = await commitFiles(repo, {
    'literal.ts': 'export const message = "a b";',
    'indent.py': 'if True:\n    print("yes")\n',
  });
  const b = await collectReviewSource(repo, base, second, 1024 * 1024);
  expect(a.source.headTree).not.toBe(b.source.headTree);
  expect(a.source.changes.find((change) => change.newPath === 'indent.py')?.oldBlob).not.toBe(
    a.source.changes.find((change) => change.newPath === 'indent.py')?.newBlob,
  );
  expect(b.source.changes[0]).toMatchObject({ oldEndsWithNewline: true, newEndsWithNewline: false });
});

test('Git manifest records binary, mode, NUL-delimited rename paths and gitlinks', async () => {
  const oldPath = 'odd\tname\n.txt';
  const newPath = 'renamed\tname\n.txt';
  const { repo, base } = await fixture({
    [oldPath]: 'same\n',
    'binary.bin': 'old\0binary',
    'run.sh': '#!/bin/sh\ntrue\n',
  });
  renameSync(join(repo, oldPath), join(repo, newPath));
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 255, 1]));
  chmodSync(join(repo, 'run.sh'), 0o755);
  await git(repo, ['add', '-A']);
  await git(repo, ['update-index', '--add', '--cacheinfo', `160000,${base},submodule`]);
  await git(repo, ['commit', '-qm', 'all source kinds']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const result = await collectReviewSource(repo, base, head, 1024 * 1024);
  expect(result.source.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ oldPath, newPath, status: 'R100' }),
      expect.objectContaining({ newPath: 'binary.bin', binary: true }),
      expect.objectContaining({ newPath: 'run.sh', oldMode: '100644', newMode: '100755' }),
      expect.objectContaining({ newPath: 'submodule', newMode: '160000', newBlob: base }),
    ]),
  );
  expect(result.files.map((file) => file.path)).toContain(newPath);
});

test('truncated collection and caller-omitted patch content fail before review', async () => {
  const { repo, base } = await fixture({ 'file.ts': 'export const a = 1;\n' });
  const head = await commitFiles(repo, { 'file.ts': `export const a = "${'x'.repeat(10_000)}";\n` });
  await expect(collectReviewSource(repo, base, head, 512)).rejects.toThrow('complete-input limit');
  const ctx = reviewContext(repo, new ManualClock());
  await expect(
    requestReview(
      ctx,
      { repositoryId: 'repo', commitSha: head, baseSha: base, patch: '', types: ['code'] },
      { config, reviewers: { code: reviewer } },
    ),
  ).rejects.toThrow('complete Git source');
});

test('identical Git trees reuse across commit IDs, while an unrelated tree change requires full review', async () => {
  const { repo, base } = await fixture({ 'file.ts': 'export const a = 1;\n', 'other.ts': 'export const b = 1;\n' });
  const first = await commitFiles(repo, { 'file.ts': 'export const a = 2;\n' });
  const source = await collectReviewSource(repo, base, first, 1024 * 1024);
  const second = (
    await git(repo, ['commit-tree', source.source.headTree, '-p', base], { input: 'same tree\n' })
  ).stdout.trim();
  const clock = new ManualClock();
  const ctx = reviewContext(repo, clock);
  let calls = 0;
  const counted: Reviewer = {
    ...reviewer,
    review: async () => {
      calls++;
      return { confidence: 0.9, findings: [] };
    },
  };
  const firstResult = await requestReview(
    ctx,
    { repositoryId: 'repo', prId: 'pr', commitSha: first, baseSha: base, patch: source.patch, types: ['code'] },
    { config, reviewers: { code: counted } },
  );
  clock.advance(1);
  const reused = await requestReview(
    ctx,
    { repositoryId: 'repo', prId: 'pr', commitSha: second, baseSha: base, patch: source.patch, types: ['code'] },
    { config, reviewers: { code: counted } },
  );
  expect(reused.outcomes[0]?.decision).toBe('reuse');
  expect(reused.outcomes[0]?.review?.expiresAt).toBe(firstResult.outcomes[0]?.review?.expiresAt);
  const changed = await commitFiles(repo, { 'other.ts': 'export const b = 2;\n' });
  const next = await collectReviewSource(repo, base, changed, 1024 * 1024);
  const fresh = await requestReview(
    ctx,
    { repositoryId: 'repo', prId: 'pr', commitSha: changed, baseSha: base, patch: next.patch, types: ['code'] },
    { config, reviewers: { code: counted } },
  );
  expect(fresh.outcomes[0]?.decision).toBe('full');
  expect(calls).toBe(2);
});

test('summaries reject legacy, expired, changed-policy, changed-reviewer and changed-base evidence', async () => {
  const { repo, base } = await fixture({ 'file.ts': 'a\n' });
  const head = await commitFiles(repo, { 'file.ts': 'b\n' });
  const source = await collectReviewSource(repo, base, head, 1024 * 1024);
  const clock = new ManualClock();
  const ctx = reviewContext(repo, clock);
  const result = await requestReview(
    ctx,
    { repositoryId: 'repo', prId: 'pr', commitSha: head, baseSha: base, patch: source.patch, types: ['code'] },
    { config, reviewers: { code: reviewer } },
  );
  const policy = acceptance(clock, base);
  expect(reviewSummary(ctx.store.db, 'pr', head, policy).byType.code?.status).toBe('passed');
  for (const changed of [
    { ...policy, policyVersion: 'new' },
    { ...policy, expectedReviewers: {} },
    { ...policy, expectedBaseSha: head },
    { ...policy, at: '2099-01-01T00:00:00.000Z' },
  ]) {
    expect(reviewSummary(ctx.store.db, 'pr', head, changed).byType.code?.status).toBe('invalidated');
  }
  ctx.store.db
    .query('UPDATE review_artifacts SET fingerprint_inputs = ? WHERE id = ?')
    .run('{}', result.outcomes[0]!.review!.id);
  expect(reviewSummary(ctx.store.db, 'pr', head, policy).byType.code?.status).toBe('invalidated');
});

test('evidence expiring during provider work completes as invalidated', async () => {
  const { repo, base } = await fixture({ 'file.ts': 'a\n' });
  const head = await commitFiles(repo, { 'file.ts': 'b\n' });
  const source = await collectReviewSource(repo, base, head, 1024 * 1024);
  const clock = new ManualClock();
  const ctx = reviewContext(repo, clock);
  const slow: Reviewer = {
    ...reviewer,
    review: async () => {
      clock.advance(config.review.cache_ttl_hours * 3600);
      return { confidence: 0.9, findings: [] };
    },
  };
  const result = await requestReview(
    ctx,
    { repositoryId: 'repo', prId: 'pr', commitSha: head, baseSha: base, patch: source.patch, types: ['code'] },
    { config, reviewers: { code: slow } },
  );
  expect(result.outcomes[0]?.review?.status).toBe('invalidated');
  expect(ctx.store.db.query("SELECT id FROM events WHERE type = 'review.invalidated'").all()).toHaveLength(1);
});
