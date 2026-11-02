import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiBaseUrlForHost,
  assertRemoteMatches,
  forgetCachedTokens,
  GitHubClient,
  ghTokenProvider,
  graphqlUrlFor,
  staticTokenProvider,
} from '@crewyard/github';
import { tempDir } from '../../helpers/index.ts';
import { type MockGitHub, startMockGitHub } from '../../helpers/mock-github.ts';

let mock: MockGitHub | undefined;
afterEach(() => mock?.stop());

function client(m: MockGitHub, overrides: { timeoutMs?: number } = {}) {
  return new GitHubClient({
    repository: { host: 'github.com', owner: m.owner, name: m.name },
    token: staticTokenProvider(m.token),
    baseUrl: m.url,
    retryBaseMs: 1,
    maxRetries: 2,
    ...overrides,
  });
}

describe('GitHub client', () => {
  test('normalises pull requests, checks and reviews into typed DTOs', async () => {
    mock = startMockGitHub();
    const pr = mock.addPull({ headRef: 'feature', headSha: 'a'.repeat(40) });
    mock.setCheck(pr.headSha, 'ci', 'failure');
    mock.setCheck(pr.headSha, 'ci', 'success');
    mock.setCheck(pr.headSha, 'lint', null, 'in_progress');
    mock.statuses.push({ sha: pr.headSha, context: 'legacy', state: 'error' });
    mock.approve(pr.number, 'alice');
    const c = client(mock);
    const [listed] = await c.listPullRequests();
    expect(listed).toMatchObject({
      number: 1,
      headRef: 'feature',
      headSha: 'a'.repeat(40),
      state: 'open',
      mergeable: 'MERGEABLE',
    });
    expect(await c.listChecks(pr.headSha)).toEqual([
      expect.objectContaining({ name: 'ci', state: 'success', kind: 'check_run' }),
      expect.objectContaining({ name: 'legacy', state: 'failure', kind: 'status' }),
      expect.objectContaining({ name: 'lint', state: 'pending' }),
    ]);
    expect(await c.listReviews(1)).toEqual([expect.objectContaining({ reviewer: 'alice', state: 'APPROVED' })]);
  });

  test('combines rulesets and branch protection, detecting the merge queue rule', async () => {
    mock = startMockGitHub();
    mock.setBranch('main', 'b'.repeat(40));
    mock.requireChecks('main', ['ci']);
    mock.requireReviews('main', 1, true);
    mock.protection.set('main', {
      required_status_checks: { strict: true, contexts: ['legacy-ci'] },
      required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true },
    });
    const c = client(mock);
    const before = await c.getBranchRequirements('main');
    expect(before).toMatchObject({
      requiredChecks: [
        { context: 'ci', appId: 15368 },
        { context: 'legacy-ci', appId: null },
      ],
      strictChecks: true,
      requiredApprovals: 2,
      requireCodeOwnerReview: true,
      dismissStaleReviews: true,
      mergeQueue: null,
      sources: ['branch_protection', 'ruleset'],
    });
    mock.enableMergeQueue('main');
    const after = await c.getBranchRequirements('main');
    expect(after.mergeQueue).toMatchObject({ mergeMethod: 'squash', groupingStrategy: 'ALLGREEN' });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('follows Link pagination within the repository only', async () => {
    mock = startMockGitHub({ pageSize: 2 });
    for (let i = 0; i < 5; i++) mock.addPull({ headRef: `b${i}` });
    expect((await client(mock).listPullRequests()).map((p) => p.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test('primary rate limits surface the reset time and stop further calls', async () => {
    mock = startMockGitHub();
    const reset = Math.floor(Date.now() / 1000) + 600;
    mock.rateLimit = { kind: 'primary', resetEpochSeconds: reset };
    const c = client(mock);
    const error = await c.listPullRequests().catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { kind: 'primary', resetAt: new Date(reset * 1000).toISOString().replace('.000', '') },
    });
    const calls = mock.calls.length;
    await expect(c.getPullRequest(1)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(mock.calls.length).toBe(calls);
  });

  test('secondary rate limits honour retry-after', async () => {
    mock = startMockGitHub();
    mock.rateLimit = { kind: 'secondary', retryAfterSeconds: 30, remainingRequests: 1 };
    const c = client(mock);
    await c.verifyRepository();
    const error = (await c.listPullRequests().catch((e: unknown) => e)) as {
      code: string;
      details: { resetAt: string };
    };
    expect(error.code).toBe('RATE_LIMITED');
    expect(Date.parse(error.details.resetAt) - Date.now()).toBeGreaterThan(25_000);
  });

  test('transient read failures are retried with backoff', async () => {
    mock = startMockGitHub();
    mock.addPull({ headRef: 'feature' });
    mock.faults.push({ method: 'GET', path: /\/pulls$/, action: 'status', status: 502, times: 1 });
    expect(await client(mock).listPullRequests()).toHaveLength(1);
    expect(mock.calls.filter((c) => c.path.endsWith('/pulls')).map((c) => c.status)).toEqual([502, 200]);
  });

  test('mutations are never retried blindly: timeouts and gateway errors are ambiguous', async () => {
    mock = startMockGitHub();
    mock.addPull({ headRef: 'feature', headSha: 'c'.repeat(40) });
    mock.setBranch('main', 'd'.repeat(40));
    const c = client(mock, { timeoutMs: 200 });
    await c.verifyRepository();
    mock.faults.push({ method: 'PUT', path: /\/merge$/, action: 'status', status: 502 });
    await expect(c.mergePullRequest(1, { sha: 'c'.repeat(40), mergeMethod: 'squash' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_REMOTE_OUTCOME',
    });
    mock.faults.push({ method: 'PUT', path: /\/merge$/, action: 'timeout-after-apply', delayMs: 800 });
    await expect(c.mergePullRequest(1, { sha: 'c'.repeat(40), mergeMethod: 'squash' })).rejects.toMatchObject({
      code: 'AMBIGUOUS_REMOTE_OUTCOME',
    });
    expect(mock.pull(1).merged).toBe(true);
    expect(mock.countCalls('PUT', /\/merge$/)).toBe(2);
  });

  test('merge maps head mismatch and unmergeable responses to stable codes', async () => {
    mock = startMockGitHub();
    mock.addPull({ headRef: 'feature', headSha: 'e'.repeat(40) });
    mock.addPull({ headRef: 'conflict', headSha: 'f'.repeat(40), mergeable: false });
    const c = client(mock);
    await expect(c.mergePullRequest(1, { sha: '0'.repeat(40), mergeMethod: 'merge' })).rejects.toMatchObject({
      code: 'HEAD_MISMATCH',
    });
    await expect(c.mergePullRequest(2, { sha: 'f'.repeat(40), mergeMethod: 'merge' })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
  });

  test('connection failures are reported as offline and repository moves are refused', async () => {
    mock = startMockGitHub();
    const c = client(mock);
    mock.movedTo = 'acme/renamed';
    await expect(c.verifyRepository()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    mock.goOffline();
    await expect(client(mock).listPullRequests()).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  test('enqueues to the native merge queue through GraphQL', async () => {
    mock = startMockGitHub();
    mock.enableMergeQueue('main');
    mock.addPull({ headRef: 'feature', headSha: '1'.repeat(40) });
    const c = client(mock);
    const state = await c.getPullRequestState(1);
    expect(state).toMatchObject({ nodeId: 'PR_node_1', isMergeQueueEnabled: true, isInMergeQueue: false });
    const entry = await c.enqueuePullRequest(state.nodeId, '1'.repeat(40));
    expect(entry).toMatchObject({ position: 1, state: 'QUEUED', pullRequestNumber: 1 });
    expect(await c.listMergeQueue('main')).toEqual([entry]);
  });
});

describe('credentials and repository identity', () => {
  test.skipIf(process.platform === 'win32')(
    'gh token is read per identity, cached in memory and never echoed in errors',
    async () => {
      forgetCachedTokens();
      const dir = tempDir();
      const counter = join(dir, 'calls');
      const gh = join(dir, 'gh');
      writeFileSync(
        gh,
        `#!/bin/sh\necho "$GH_CONFIG_DIR $*" >> ${counter}\nif [ "$GH_CONFIG_DIR" = "${dir}/work" ]; then echo ghp_${'x'.repeat(36)}; else exit 1; fi\n`,
      );
      chmodSync(gh, 0o755);
      const work = ghTokenProvider({ host: 'github.com', configDir: join(dir, 'work'), ghBinary: gh });
      expect(await work()).toBe(`ghp_${'x'.repeat(36)}`);
      expect(await work()).toBe(`ghp_${'x'.repeat(36)}`);
      const personal = ghTokenProvider({ host: 'github.com', configDir: join(dir, 'personal'), ghBinary: gh });
      const error = await personal().catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(JSON.stringify(error)).not.toContain('ghp_');
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual([
        `${dir}/work auth token --hostname github.com`,
        `${dir}/personal auth token --hostname github.com`,
      ]);
      forgetCachedTokens();
    },
  );

  test('remote validation refuses another repository', () => {
    const expected = { host: 'github.com', owner: 'acme', name: 'widgets' };
    expect(() => assertRemoteMatches(expected, 'git@github.com:acme/widgets.git')).not.toThrow();
    expect(() => assertRemoteMatches(expected, 'https://github.com/ACME/Widgets')).not.toThrow();
    expect(() => assertRemoteMatches(expected, 'https://github.com/acme/other.git')).toThrow('does not match');
    expect(() => assertRemoteMatches(expected, null)).toThrow();
  });

  test('derives API endpoints for github.com and GitHub Enterprise', () => {
    expect(apiBaseUrlForHost('github.com')).toBe('https://api.github.com');
    expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrlFor(apiBaseUrlForHost('ghe.example.com'))).toBe('https://ghe.example.com/api/graphql');
  });
});
