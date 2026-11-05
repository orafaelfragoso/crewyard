import { afterEach, expect, test } from 'bun:test';
import { gitText } from '@crewyard/core';
import {
  buildAndValidateCandidate,
  createCandidate,
  fetchIntegrationRefs,
  requestIntegration,
  selectGroup,
  showPullRequest,
  syncRepository,
} from '@crewyard/integration';
import { getRepository } from '@crewyard/projects';
import { all } from '@crewyard/storage';
import { createGitHubFixture, type GitHubFixture } from './github-fixture.ts';

let fixture: GitHubFixture | undefined;
afterEach(() => fixture?.cleanup());
const actor = { kind: 'operator' as const, id: 'tester' };

async function prepare(files: readonly Record<string, string>[], command: string) {
  const f = await createGitHubFixture({ config: { validation: { broad: [{ name: 'prefix', command }] } } });
  fixture = f;
  const numbers: number[] = [];
  for (const [i, content] of files.entries()) {
    await f.pushBranch(`change-${i}`, content);
    const pull = f.mock.addPull({
      headRef: `change-${i}`,
      files: Object.keys(content).map((filename) => ({ filename, status: 'added', additions: 1, deletions: 0 })),
    });
    f.mock.passChecks(pull.number);
    numbers.push(pull.number);
  }
  await syncRepository(f.ctx, f.repositoryId, f.env);
  const group = [];
  for (const number of numbers) {
    const { entry } = await requestIntegration(
      f.ctx,
      { repositoryId: f.repositoryId, number, requestedBy: actor },
      f.env,
    );
    group.push({ entry, pr: showPullRequest(f.ctx, { prId: entry.prId }) });
  }
  const baseSha = await fetchIntegrationRefs(
    f.repo,
    'main',
    group.map((g) => g.pr),
  );
  const candidate = createCandidate(
    f.ctx,
    {
      queueId: group[0]!.entry.queueId,
      group,
      baseSha,
      policyRevision: 1,
      rulesFingerprint: group[0]!.pr.governance!.requirements!.fingerprint,
    },
    actor,
    600,
  );
  return { f, candidate, group };
}

test('a passing final tree cannot conceal a broken first exposed prefix', async () => {
  const { f, candidate } = await prepare([{ broken: 'yes' }, { repair: 'yes' }], 'test ! -f broken || test -f repair');
  const outcome = await buildAndValidateCandidate(f.ctx, candidate.id, {
    repository: getRepository(f.ctx, f.repositoryId),
    config: f.config,
    actor,
    hooks: [],
  });
  expect(outcome.candidate.status).toBe('failed');
  expect(outcome.candidate.ciEvidence.failingPrefix).toBe(1);
  const finalFiles = await gitText(f.repo, ['ls-tree', '--name-only', outcome.candidate.commitSha!]);
  expect(finalFiles).toContain('repair');
  expect(all(f.ctx.store.db, 'SELECT status FROM validation_runs WHERE candidate_id = ?', candidate.id)).toEqual([
    { status: 'failed' },
  ]);
  expect(f.mock.countCalls('PUT', /\/merge$/)).toBe(0);
}, 30_000);

test('later behavioral failure records the smallest failing prefix and interaction set without blaming the first PR', async () => {
  const { f, candidate, group } = await prepare(
    [{ a: 'yes' }, { b: 'yes' }, { c: 'yes' }],
    'test ! -f a || test ! -f b',
  );
  const outcome = await buildAndValidateCandidate(f.ctx, candidate.id, {
    repository: getRepository(f.ctx, f.repositoryId),
    config: f.config,
    actor,
    hooks: [],
  });
  expect(outcome.candidate.status).toBe('failed');
  expect(outcome.candidate.ciEvidence.failingPrefix).toBe(2);
  expect(outcome.candidate.ciEvidence.contributors).toEqual(group.slice(0, 2).map((g) => g.pr.id));
  expect(
    all(f.ctx.store.db, 'SELECT status FROM validation_runs WHERE candidate_id = ? ORDER BY rowid', candidate.id),
  ).toEqual([{ status: 'passed' }, { status: 'failed' }]);
  expect(all(f.ctx.store.db, "SELECT * FROM failure_records WHERE subject_kind = 'pr'")).toHaveLength(0);
  expect(all(f.ctx.store.db, 'SELECT status FROM queue_entries ORDER BY rowid')).toEqual([
    { status: 'blocked' },
    { status: 'blocked' },
    { status: 'waiting' },
  ]);
}, 30_000);

test('every passed prefix binds its own exact tree, command, environment, policy and expiry', async () => {
  const { f, candidate } = await prepare([{ a: 'yes' }, { b: 'yes' }], 'test -f a');
  const outcome = await buildAndValidateCandidate(f.ctx, candidate.id, {
    repository: getRepository(f.ctx, f.repositoryId),
    config: f.config,
    actor,
    hooks: [],
  });
  expect(outcome.candidate.status).toBe('valid');
  const prefixes = outcome.candidate.ciEvidence.prefixes as {
    treeSha: string;
    validationId: string;
    configFingerprint: string;
    envFingerprint: string;
    expiresAt: string;
    policyRevision: number;
  }[];
  expect(prefixes).toHaveLength(2);
  expect(prefixes.map((p) => p.treeSha)).toEqual(outcome.candidate.entries.map((e) => e.treeSha!));
  expect(new Set(prefixes.map((p) => p.validationId)).size).toBe(2);
  for (const prefix of prefixes) {
    expect(prefix.configFingerprint.length).toBeGreaterThan(0);
    expect(prefix.envFingerprint.length).toBeGreaterThan(0);
    expect(prefix.policyRevision).toBe(1);
    expect(prefix.expiresAt).toBe(candidate.expiresAt!);
    expect(all(f.ctx.store.db, 'SELECT commands FROM validation_runs WHERE id = ?', prefix.validationId)).toEqual([
      { commands: expect.stringContaining('test -f a') },
    ]);
  }
}, 30_000);

test('speculation excludes a high-risk first entry, absent metadata, rename sources and uncertain contract changes', async () => {
  const { f, group } = await prepare([{ a: 'yes' }, { b: 'yes' }], 'true');
  const items = group.map((g) => ({ ...g, eligible: true, dependsOn: [] as string[] }));
  expect(selectGroup(items, f.config, 2)).toHaveLength(2);
  expect(
    selectGroup([{ ...items[0]!, entry: { ...items[0]!.entry, risk: 'high' } }, items[1]!], f.config, 2),
  ).toHaveLength(1);
  expect(
    selectGroup([{ ...items[0]!, pr: { ...items[0]!.pr, changedFiles: null } }, items[1]!], f.config, 2),
  ).toHaveLength(1);
  const renamed = {
    ...items[1]!,
    pr: {
      ...items[1]!.pr,
      changedFiles: [
        {
          path: 'renamed',
          previousPath: 'a',
          status: 'renamed' as const,
          additions: 0,
          deletions: 0,
          changes: 0,
          blobSha: null,
          patch: null,
        },
      ],
    },
  };
  expect(selectGroup([items[0]!, renamed], f.config, 2)).toHaveLength(1);
  const contract = {
    ...items[1]!,
    pr: {
      ...items[1]!.pr,
      changedFiles: items[1]!.pr.changedFiles!.map((file) => ({ ...file, path: 'src/types.ts' })),
    },
  };
  expect(selectGroup([items[0]!, contract], f.config, 2)).toHaveLength(1);
}, 30_000);
