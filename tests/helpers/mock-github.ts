import { createHash } from 'node:crypto';

export interface MockFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
}

export interface MockReview {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  commitId: string;
  submittedAt: string;
}

export interface MockStack {
  id: number;
  position: number;
  size: number;
}

export interface MockPull {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  user: string;
  state: 'open' | 'closed';
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean | null;
  files: MockFile[] | null;
  reviews: MockReview[];
  codeownerApproved: boolean;
  stack: MockStack | null;
  updatedAt: string;
}

export interface MockCheck {
  id: number;
  sha: string;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'cancelled' | 'timed_out' | null;
  appId: number;
}

export interface MockQueueEntry {
  id: string;
  number: number;
  state: 'QUEUED' | 'AWAITING_CHECKS' | 'MERGEABLE' | 'UNMERGEABLE' | 'LOCKED';
  enqueuedAt: string;
  headSha: string;
}

export interface MockFault {
  method?: string;
  path?: RegExp;
  operation?: string;
  times?: number;
  action: 'timeout-after-apply' | 'timeout' | 'status';
  status?: number;
  delayMs?: number;
  message?: string;
}

export interface MockCall {
  method: string;
  path: string;
  operation: string | null;
  status: number;
}

export interface MockRateLimit {
  kind: 'primary' | 'secondary';
  resetEpochSeconds?: number;
  retryAfterSeconds?: number;
  remainingRequests?: number;
}

export interface MockGitHubOptions {
  owner?: string;
  name?: string;
  token?: string;
  gitDir?: string;
  defaultBranch?: string;
  pageSize?: number;
}

type Json = Record<string, unknown>;

function gitSync(gitDir: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const proc = Bun.spawnSync(['git', `--git-dir=${gitDir}`, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      GIT_AUTHOR_NAME: 'Mock GitHub',
      GIT_AUTHOR_EMAIL: 'mock@github.local',
      GIT_COMMITTER_NAME: 'Mock GitHub',
      GIT_COMMITTER_EMAIL: 'mock@github.local',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString().trim() };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeSha(seed: string): string {
  return createHash('sha1').update(seed).digest('hex');
}

export class MockGitHub {
  readonly owner: string;
  readonly name: string;
  readonly token: string;
  readonly gitDir: string | null;
  readonly defaultBranch: string;
  pageSize: number;
  pulls = new Map<number, MockPull>();
  branches = new Map<string, string>();
  checks: MockCheck[] = [];
  statuses: { sha: string; context: string; state: 'success' | 'pending' | 'failure' | 'error' }[] = [];
  rules = new Map<string, Json[]>();
  protection = new Map<string, Json>();
  mergeQueues = new Map<string, MockQueueEntry[]>();
  asyncMerges = new Map<string, Json>();
  faults: MockFault[] = [];
  calls: MockCall[] = [];
  rateLimit: MockRateLimit | null = null;
  movedTo: string | null = null;
  pendingMergeCommits = new Set<number>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port = 0;
  private nextId = 1000;
  private clock = Date.parse('2026-11-02T12:00:00Z');

  constructor(options: MockGitHubOptions = {}) {
    this.owner = options.owner ?? 'acme';
    this.name = options.name ?? 'widgets';
    this.token = options.token ?? 'test-token';
    this.gitDir = options.gitDir ?? null;
    this.defaultBranch = options.defaultBranch ?? 'main';
    this.pageSize = options.pageSize ?? 100;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get remoteUrl(): string {
    return `https://github.com/${this.owner}/${this.name}.git`;
  }

  start(): this {
    this.server = Bun.serve({ port: this.port, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
    this.port = this.server.port ?? 0;
    return this;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  goOffline(): void {
    this.stop();
  }

  goOnline(): void {
    if (!this.server) this.start();
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  countCalls(method: string, pattern: RegExp | string): number {
    return this.calls.filter(
      (c) =>
        c.method === method &&
        (typeof pattern === 'string' ? c.operation === pattern || c.path === pattern : pattern.test(c.path)),
    ).length;
  }

  branchSha(name: string): string | null {
    if (this.gitDir) {
      const result = gitSync(this.gitDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
      return result.code === 0 ? result.out : null;
    }
    return this.branches.get(name) ?? null;
  }

  setBranch(name: string, sha: string): void {
    if (this.gitDir) gitSync(this.gitDir, ['update-ref', `refs/heads/${name}`, sha]);
    else this.branches.set(name, sha);
  }

  headSha(pr: MockPull): string {
    if (pr.state === 'open' && this.gitDir) {
      const live = this.branchSha(pr.headRef);
      if (live) pr.headSha = live;
    }
    return pr.headSha;
  }

  addPull(input: Partial<MockPull> & { headRef: string; baseRef?: string; headSha?: string }): MockPull {
    const number = input.number ?? this.pulls.size + 1;
    const pr: MockPull = {
      number,
      nodeId: `PR_node_${number}`,
      title: input.title ?? `PR ${number}`,
      body: input.body ?? '',
      user: input.user ?? 'octo',
      state: input.state ?? 'open',
      draft: input.draft ?? false,
      headRef: input.headRef,
      headSha: input.headSha ?? this.branchSha(input.headRef) ?? fakeSha(`${input.headRef}:${number}`),
      baseRef: input.baseRef ?? this.defaultBranch,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: input.mergeable === undefined ? (this.gitDir ? null : true) : input.mergeable,
      files: input.files ?? null,
      reviews: input.reviews ?? [],
      codeownerApproved: input.codeownerApproved ?? true,
      stack: input.stack ?? null,
      updatedAt: this.tick(),
    };
    this.pulls.set(number, pr);
    return pr;
  }

  pull(number: number): MockPull {
    const pr = this.pulls.get(number);
    if (!pr) throw new Error(`mock: no PR ${number}`);
    return pr;
  }

  setCheck(sha: string, name: string, conclusion: MockCheck['conclusion'], status: MockCheck['status'] = 'completed') {
    this.checks.push({ id: this.nextId++, sha, name, status, conclusion, appId: 15368 });
  }

  passChecks(number: number, names: string[] = ['ci']): void {
    const sha = this.headSha(this.pull(number));
    for (const name of names) this.setCheck(sha, name, 'success');
  }

  approve(number: number, user = 'reviewer'): void {
    const pr = this.pull(number);
    pr.reviews.push({
      id: this.nextId++,
      user,
      state: 'APPROVED',
      commitId: this.headSha(pr),
      submittedAt: this.tick(),
    });
    pr.updatedAt = this.tick();
  }

  requireChecks(branch: string, contexts: string[], strict = false): void {
    const rules = (this.rules.get(branch) ?? []).filter((r) => r.type !== 'required_status_checks');
    rules.push({
      type: 'required_status_checks',
      ruleset_source_type: 'Repository',
      ruleset_id: 1,
      parameters: {
        strict_required_status_checks_policy: strict,
        required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })),
      },
    });
    this.rules.set(branch, rules);
  }

  requireReviews(branch: string, count: number, codeOwners = false): void {
    const rules = (this.rules.get(branch) ?? []).filter((r) => r.type !== 'pull_request');
    rules.push({
      type: 'pull_request',
      ruleset_source_type: 'Repository',
      ruleset_id: 1,
      parameters: {
        required_approving_review_count: count,
        require_code_owner_review: codeOwners,
        dismiss_stale_reviews_on_push: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    });
    this.rules.set(branch, rules);
  }

  enableMergeQueue(branch: string): void {
    const rules = (this.rules.get(branch) ?? []).filter((r) => r.type !== 'merge_queue');
    rules.push({
      type: 'merge_queue',
      ruleset_source_type: 'Repository',
      ruleset_id: 2,
      parameters: {
        check_response_timeout_minutes: 60,
        grouping_strategy: 'ALLGREEN',
        max_entries_to_build: 5,
        max_entries_to_merge: 5,
        merge_method: 'SQUASH',
        min_entries_to_merge: 1,
        min_entries_to_merge_wait_minutes: 5,
      },
    });
    this.rules.set(branch, rules);
  }

  private requirements(branch: string) {
    const rules = this.rules.get(branch) ?? [];
    const checks = rules.find((r) => r.type === 'required_status_checks');
    const reviews = rules.find((r) => r.type === 'pull_request');
    const params = (r: Json | undefined) => (r?.parameters ?? {}) as Json;
    return {
      contexts: ((params(checks).required_status_checks as Json[] | undefined) ?? []).map((c) => String(c.context)),
      strict: params(checks).strict_required_status_checks_policy === true,
      approvals: Number(params(reviews).required_approving_review_count ?? 0),
      codeOwners: params(reviews).require_code_owner_review === true,
      mergeQueue: rules.some((r) => r.type === 'merge_queue'),
    };
  }

  private checksFor(sha: string): { name: string; state: 'success' | 'pending' | 'failure' }[] {
    const latest = new Map<string, MockCheck>();
    for (const check of this.checks.filter((c) => c.sha === sha)) {
      const current = latest.get(check.name);
      if (!current || check.id > current.id) latest.set(check.name, check);
    }
    const out = [...latest.values()].map((c) => ({
      name: c.name,
      state:
        c.status !== 'completed'
          ? ('pending' as const)
          : c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped'
            ? ('success' as const)
            : ('failure' as const),
    }));
    for (const s of this.statuses.filter((st) => st.sha === sha)) {
      if (!out.some((o) => o.name === s.context)) {
        out.push({
          name: s.context,
          state: s.state === 'success' ? 'success' : s.state === 'pending' ? 'pending' : 'failure',
        });
      }
    }
    return out;
  }

  private approvals(pr: MockPull): { approved: number; changesRequested: boolean } {
    const latest = new Map<string, MockReview>();
    for (const review of pr.reviews) {
      if (review.state === 'COMMENTED') continue;
      latest.set(review.user, review);
    }
    const states = [...latest.values()].map((r) => r.state);
    return {
      approved: states.filter((s) => s === 'APPROVED').length,
      changesRequested: states.includes('CHANGES_REQUESTED'),
    };
  }

  reviewDecision(pr: MockPull): string | null {
    const req = this.requirements(pr.baseRef);
    const { approved, changesRequested } = this.approvals(pr);
    if (changesRequested) return 'CHANGES_REQUESTED';
    if (req.approvals === 0 && !req.codeOwners) return approved > 0 ? 'APPROVED' : null;
    if (approved >= req.approvals && (!req.codeOwners || pr.codeownerApproved)) return 'APPROVED';
    return 'REVIEW_REQUIRED';
  }

  private conflicts(pr: MockPull): boolean {
    if (pr.mergeable !== null) return !pr.mergeable;
    if (!this.gitDir) return false;
    const base = this.branchSha(pr.baseRef);
    if (!base) return false;
    return gitSync(this.gitDir, ['merge-tree', '--write-tree', base, this.headSha(pr)]).code !== 0;
  }

  mergeableState(pr: MockPull): string {
    if (pr.state !== 'open') return 'unknown';
    if (pr.draft) return 'draft';
    if (this.conflicts(pr)) return 'dirty';
    const req = this.requirements(pr.baseRef);
    const checks = this.checksFor(this.headSha(pr));
    const required = req.contexts.every((c) => checks.some((k) => k.name === c && k.state === 'success'));
    if (!required || this.reviewDecision(pr) === 'REVIEW_REQUIRED' || this.reviewDecision(pr) === 'CHANGES_REQUESTED') {
      return 'blocked';
    }
    if (req.strict && this.gitDir) {
      const base = this.branchSha(pr.baseRef);
      if (base && gitSync(this.gitDir, ['merge-base', '--is-ancestor', base, this.headSha(pr)]).code !== 0) {
        return 'behind';
      }
    }
    if (checks.some((c) => c.state === 'failure')) return 'unstable';
    return 'clean';
  }

  private pullJson(pr: MockPull): Json {
    const head = this.headSha(pr);
    const conflict = pr.state === 'open' ? this.conflicts(pr) : false;
    const baseSha = this.branchSha(pr.baseRef) ?? fakeSha(pr.baseRef);
    const stackBase = pr.stack ? this.stackTrunk(pr) : null;
    return {
      number: pr.number,
      node_id: pr.nodeId,
      html_url: `https://github.com/${this.owner}/${this.name}/pull/${pr.number}`,
      title: pr.title,
      body: pr.body,
      user: { login: pr.user },
      state: pr.state,
      draft: pr.draft,
      head: { ref: pr.headRef, sha: head, repo: { full_name: `${this.owner}/${this.name}` } },
      base: { ref: pr.baseRef, sha: baseSha },
      merged_at: pr.mergedAt,
      merge_commit_sha: this.pendingMergeCommits.has(pr.number) ? null : pr.mergeCommitSha,
      mergeable: pr.state === 'open' ? !conflict : null,
      mergeable_state: this.mergeableState(pr),
      updated_at: pr.updatedAt,
      ...(pr.stack && stackBase
        ? {
            stack: {
              id: pr.stack.id,
              number: pr.number,
              position: pr.stack.position,
              size: pr.stack.size,
              base: { ref: stackBase, sha: this.branchSha(stackBase) ?? '' },
            },
          }
        : {}),
    };
  }

  private stackTrunk(pr: MockPull): string {
    const bottom = [...this.pulls.values()].find((p) => p.stack?.id === pr.stack?.id && p.stack?.position === 1);
    return bottom?.baseRef ?? pr.baseRef;
  }

  private filesFor(pr: MockPull): MockFile[] {
    if (pr.files) return pr.files;
    if (!this.gitDir) return [];
    const base = this.branchSha(pr.baseRef);
    if (!base) return [];
    const out = gitSync(this.gitDir, ['diff', '--numstat', `${base}...${this.headSha(pr)}`]).out;
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [add, del, filename] = line.split('\t');
        return { filename: filename!, status: 'modified' as const, additions: Number(add), deletions: Number(del) };
      });
  }

  mergeLocally(pr: MockPull, method: string): string {
    const now = this.tick();
    let sha: string;
    if (this.gitDir) {
      const base = this.branchSha(pr.baseRef)!;
      const head = this.headSha(pr);
      const tree = gitSync(this.gitDir, ['merge-tree', '--write-tree', base, head]);
      if (tree.code !== 0) throw new Error('conflict');
      const parents = method === 'merge' ? ['-p', base, '-p', head] : ['-p', base];
      sha = gitSync(this.gitDir, ['commit-tree', tree.out.split('\n')[0]!, ...parents, '-m', `Merge #${pr.number}`], {
        GIT_AUTHOR_DATE: now,
        GIT_COMMITTER_DATE: now,
      }).out;
      gitSync(this.gitDir, ['update-ref', `refs/heads/${pr.baseRef}`, sha]);
    } else {
      sha = fakeSha(`merge:${pr.number}:${pr.headSha}:${now}`);
      this.branches.set(pr.baseRef, sha);
    }
    pr.headSha = this.headSha(pr);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = now;
    pr.mergeCommitSha = sha;
    pr.updatedAt = now;
    return sha;
  }

  mergeExternally(number: number, method = 'squash'): string {
    return this.mergeLocally(this.pull(number), method);
  }

  processMergeQueue(branch: string, outcome: 'merge' | 'fail' = 'merge'): number[] {
    const entries = this.mergeQueues.get(branch) ?? [];
    const done: number[] = [];
    for (const entry of entries) {
      const pr = this.pull(entry.number);
      if (outcome === 'merge') this.mergeLocally(pr, 'squash');
      done.push(entry.number);
    }
    this.mergeQueues.set(branch, []);
    return done;
  }

  private mergeBlockReason(pr: MockPull): string | null {
    if (pr.state !== 'open') return 'Pull Request is not mergeable';
    const req = this.requirements(pr.baseRef);
    if (req.mergeQueue) return 'Changes must be made through the merge queue';
    const state = this.mergeableState(pr);
    if (state === 'dirty') return 'Pull Request is not mergeable';
    if (state === 'blocked' || state === 'behind' || state === 'draft') return 'Repository rule violations found';
    return null;
  }

  private page(items: unknown[], url: URL): { body: unknown[]; link: string | null } {
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30), this.pageSize);
    const page = Number(url.searchParams.get('page') ?? 1);
    const body = items.slice((page - 1) * perPage, page * perPage);
    if (page * perPage >= items.length) return { body, link: null };
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    return { body, link: `<${next.toString()}>; rel="next"` };
  }

  private respond(req: Request, status: number, body: unknown, headers: Record<string, string> = {}): Response {
    if (req.method === 'GET' && status === 200) {
      const etag = `W/"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
      if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return json(status, body, { etag, ...headers });
    }
    return json(status, body, headers);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let operation: string | null = null;
    let payload: Json = {};
    if (req.method !== 'GET') {
      const text = await req.text();
      payload = text ? (JSON.parse(text) as Json) : {};
      if (url.pathname === '/graphql') operation = String(payload.operationName ?? '');
    }
    const record = (status: number) => this.calls.push({ method: req.method, path: url.pathname, operation, status });
    if (req.headers.get('authorization') !== `Bearer ${this.token}`) {
      record(401);
      return json(401, { message: 'Bad credentials' });
    }
    if (this.rateLimit && !(req.method === 'GET' && req.headers.get('if-none-match'))) {
      const limit = this.rateLimit;
      if (limit.remainingRequests !== undefined && limit.remainingRequests > 0) {
        limit.remainingRequests--;
      } else {
        record(limit.kind === 'primary' ? 403 : 429);
        return limit.kind === 'primary'
          ? json(
              403,
              { message: 'API rate limit exceeded' },
              { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(limit.resetEpochSeconds ?? 0) },
            )
          : json(
              429,
              { message: 'You have exceeded a secondary rate limit' },
              { 'retry-after': String(limit.retryAfterSeconds ?? 60) },
            );
      }
    }
    const fault = this.faults.find(
      (f) =>
        (f.times ?? 1) > 0 &&
        (!f.method || f.method === req.method) &&
        (!f.path || f.path.test(url.pathname)) &&
        (!f.operation || f.operation === operation),
    );
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      if (fault.action === 'status') {
        record(fault.status ?? 500);
        return json(fault.status ?? 500, { message: fault.message ?? 'injected failure' });
      }
      if (fault.action === 'timeout') {
        record(0);
        await Bun.sleep(fault.delayMs ?? 2_000);
        return json(504, { message: 'late' });
      }
    }
    let response: Response;
    try {
      response = url.pathname === '/graphql' ? this.graphql(payload) : this.rest(req, url, payload);
    } catch (error) {
      response = json(500, { message: String(error) });
    }
    record(response.status);
    if (fault?.action === 'timeout-after-apply') await Bun.sleep(fault.delayMs ?? 2_000);
    return response;
  }

  private rest(req: Request, url: URL, payload: Json): Response {
    const prefix = `/repos/${this.owner}/${this.name}`;
    if (this.movedTo && url.pathname.startsWith(prefix)) {
      return json(301, { message: 'Moved Permanently' }, { location: `${this.url}/repos/${this.movedTo}` });
    }
    if (!url.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const path = url.pathname.slice(prefix.length);
    const m = (re: RegExp) => re.exec(path);
    let match: RegExpExecArray | null;
    if (path === '' && req.method === 'GET') {
      return this.respond(req, 200, { full_name: `${this.owner}/${this.name}`, default_branch: this.defaultBranch });
    }
    if (path === '/pulls' && req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const head = url.searchParams.get('head');
      const items = [...this.pulls.values()]
        .filter((p) => state === 'all' || (state === 'open' ? p.state === 'open' : p.state === 'closed'))
        .filter((p) => !head || `${this.owner}:${p.headRef}` === head)
        .sort((a, b) => a.number - b.number)
        .map((p) => {
          const { mergeable: _m, mergeable_state: _s, ...listed } = this.pullJson(p) as Record<string, unknown>;
          return listed as Json;
        });
      const { body, link } = this.page(items, url);
      return this.respond(req, 200, body, link ? { link } : {});
    }
    if (path === '/pulls' && req.method === 'POST') {
      const headRef = String(payload.head);
      if ([...this.pulls.values()].some((p) => p.headRef === headRef && p.state === 'open')) {
        return json(422, { message: 'A pull request already exists' });
      }
      const pr = this.addPull({
        headRef,
        baseRef: String(payload.base),
        title: String(payload.title),
        body: String(payload.body ?? ''),
        draft: payload.draft === true,
        number: Math.max(0, ...this.pulls.keys()) + 1,
      });
      return json(201, this.pullJson(pr));
    }
    match = m(/^\/pulls\/(\d+)$/);
    if (match) {
      const pr = this.pulls.get(Number(match[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      if (req.method === 'PATCH') {
        if (typeof payload.title === 'string') pr.title = payload.title;
        if (typeof payload.body === 'string') pr.body = payload.body;
        if (typeof payload.base === 'string') pr.baseRef = payload.base;
        if (payload.state === 'closed' || payload.state === 'open') pr.state = payload.state;
        pr.updatedAt = this.tick();
        return json(200, this.pullJson(pr));
      }
      return this.respond(req, 200, this.pullJson(pr));
    }
    match = m(/^\/pulls\/(\d+)\/files$/);
    if (match) {
      const pr = this.pulls.get(Number(match[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      const { body, link } = this.page(this.filesFor(pr), url);
      return this.respond(req, 200, body, link ? { link } : {});
    }
    match = m(/^\/pulls\/(\d+)\/reviews$/);
    if (match) {
      const pr = this.pulls.get(Number(match[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      return this.respond(
        req,
        200,
        pr.reviews.map((r) => ({
          id: r.id,
          user: { login: r.user },
          state: r.state,
          commit_id: r.commitId,
          submitted_at: r.submittedAt,
        })),
      );
    }
    match = m(/^\/pulls\/(\d+)\/merge$/);
    if (match && req.method === 'PUT') {
      const pr = this.pulls.get(Number(match[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      if (pr.merged) return json(405, { message: 'Pull Request is not mergeable' });
      if (payload.sha && payload.sha !== this.headSha(pr)) {
        return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      }
      const reason = this.mergeBlockReason(pr);
      if (reason) return json(405, { message: reason });
      const sha = this.mergeLocally(pr, String(payload.merge_method ?? 'merge'));
      return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    match = m(/^\/pulls\/(\d+)\/merge-async$/);
    if (match && req.method === 'PUT') {
      const pr = this.pulls.get(Number(match[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      if (pr.merged)
        return json(200, { status: 'merged', details: { message: 'already merged', sha: pr.mergeCommitSha } });
      if (payload.sha && payload.sha !== this.headSha(pr)) return json(409, { message: 'Head branch was modified' });
      const stack = pr.stack;
      const chain = stack
        ? [...this.pulls.values()]
            .filter((p) => p.stack?.id === stack.id && p.stack.position <= stack.position && p.state === 'open')
            .sort((a, b) => a.stack!.position - b.stack!.position)
        : [pr];
      const uuid = crypto.randomUUID();
      const action = String(payload.merge_action ?? 'default');
      const trunk = pr.stack ? this.stackTrunk(pr) : pr.baseRef;
      if (action === 'merge_queue' || (action === 'default' && this.requirements(trunk).mergeQueue)) {
        const queue = this.mergeQueues.get(trunk) ?? [];
        for (const p of chain) {
          queue.push({
            id: `MQE_${p.number}`,
            number: p.number,
            state: 'QUEUED',
            enqueuedAt: this.tick(),
            headSha: this.headSha(p),
          });
        }
        this.mergeQueues.set(trunk, queue);
        this.asyncMerges.set(uuid, { status: 'enqueued', details: { message: 'enqueued', uuid } });
        return json(202, {
          status: 'pending',
          details: { uuid, merge_action: action, expected_head_sha: payload.sha },
        });
      }
      for (const p of chain) {
        const reason = this.mergeBlockReason({ ...p, baseRef: trunk });
        if (reason) {
          this.asyncMerges.set(uuid, { status: 'failed', details: { message: reason } });
          return json(202, { status: 'pending', details: { uuid } });
        }
      }
      let sha = '';
      for (const p of chain) {
        p.baseRef = trunk;
        sha = this.mergeLocally(p, String(payload.merge_method ?? 'squash'));
      }
      this.asyncMerges.set(uuid, { status: 'merged', details: { message: 'merged', sha } });
      return json(202, { status: 'pending', details: { uuid, expected_head_sha: payload.sha } });
    }
    match = m(/^\/pulls\/(\d+)\/merge-async\/([\w-]+)$/);
    if (match) {
      const result = this.asyncMerges.get(match[2]!);
      return result ? json(200, result) : json(404, { message: 'Not Found' });
    }
    match = m(/^\/commits\/([0-9a-f]+)\/check-runs$/);
    if (match) {
      const runs = this.checks
        .filter((c) => c.sha === match![1])
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          head_sha: c.sha,
          app: { id: c.appId },
          details_url: null,
        }));
      return this.respond(req, 200, { total_count: runs.length, check_runs: runs });
    }
    match = m(/^\/commits\/([0-9a-f]+)\/status$/);
    if (match) {
      const statuses = this.statuses
        .filter((s) => s.sha === match![1])
        .map((s) => ({ context: s.context, state: s.state }));
      return this.respond(req, 200, { state: 'success', statuses });
    }
    if (path === '/actions/runs') {
      const sha = url.searchParams.get('head_sha');
      const runs = this.checks
        .filter((c) => c.sha === sha)
        .map((c) => ({
          id: c.id,
          name: c.name,
          event: 'pull_request',
          status: c.status,
          conclusion: c.conclusion,
          head_sha: c.sha,
          head_branch: null,
        }));
      return this.respond(req, 200, { total_count: runs.length, workflow_runs: runs });
    }
    match = m(/^\/branches\/([^/]+)\/protection$/);
    if (match) {
      const protection = this.protection.get(decodeURIComponent(match[1]!));
      return protection ? this.respond(req, 200, protection) : json(404, { message: 'Branch not protected' });
    }
    match = m(/^\/branches\/([^/]+)$/);
    if (match) {
      const name = decodeURIComponent(match[1]!);
      const sha = this.branchSha(name);
      if (!sha) return json(404, { message: 'Branch not found' });
      return this.respond(req, 200, { name, commit: { sha }, protected: this.rules.has(name) });
    }
    match = m(/^\/rules\/branches\/([^/]+)$/);
    if (match) {
      const { body, link } = this.page(this.rules.get(decodeURIComponent(match[1]!)) ?? [], url);
      return this.respond(req, 200, body, link ? { link } : {});
    }
    match = m(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
    if (match) {
      const [, base, head] = match;
      if (!this.gitDir) return this.respond(req, 200, { status: 'diverged', ahead_by: 1, behind_by: 1 });
      const exists = (sha: string) => gitSync(this.gitDir!, ['cat-file', '-e', `${sha}^{commit}`]).code === 0;
      if (!exists(base!) || !exists(head!)) return json(404, { message: 'Not Found' });
      const ancestor = (a: string, b: string) =>
        gitSync(this.gitDir!, ['merge-base', '--is-ancestor', a, b]).code === 0;
      const status =
        base === head ? 'identical' : ancestor(base!, head!) ? 'ahead' : ancestor(head!, base!) ? 'behind' : 'diverged';
      return this.respond(req, 200, { status, ahead_by: 0, behind_by: 0 });
    }
    return json(404, { message: `mock: unhandled ${req.method} ${path}` });
  }

  private entryJson(entry: MockQueueEntry, position: number): Json {
    const pr = this.pull(entry.number);
    return {
      id: entry.id,
      position,
      state: entry.state,
      enqueuedAt: entry.enqueuedAt,
      headCommit: { oid: entry.headSha },
      baseCommit: { oid: this.branchSha(pr.baseRef) },
      pullRequest: { number: entry.number },
    };
  }

  private graphql(payload: Json): Response {
    const op = String(payload.operationName ?? '');
    const vars = (payload.variables ?? {}) as Json;
    if (op === 'PullRequestState') {
      const pr = this.pulls.get(Number(vars.number));
      if (!pr)
        return json(200, {
          data: { repository: { pullRequest: null } },
          errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
        });
      const queue = this.mergeQueues.get(pr.baseRef) ?? [];
      const index = queue.findIndex((e) => e.number === pr.number);
      return json(200, {
        data: {
          repository: {
            pullRequest: {
              id: pr.nodeId,
              reviewDecision: this.reviewDecision(pr),
              mergeable: pr.state === 'open' ? (this.conflicts(pr) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN',
              mergeStateStatus: this.mergeableState(pr).toUpperCase(),
              isInMergeQueue: index >= 0,
              isMergeQueueEnabled: this.requirements(pr.baseRef).mergeQueue,
              mergeQueueEntry: index >= 0 ? this.entryJson(queue[index]!, index + 1) : null,
            },
          },
        },
      });
    }
    if (op === 'MergeQueueEntries') {
      const queue = this.mergeQueues.get(String(vars.branch)) ?? [];
      return json(200, {
        data: {
          repository: { mergeQueue: { id: 'MQ_1', entries: { nodes: queue.map((e, i) => this.entryJson(e, i + 1)) } } },
        },
      });
    }
    if (op === 'EnqueuePullRequest') {
      const pr = [...this.pulls.values()].find((p) => p.nodeId === vars.pullRequestId);
      if (!pr) return json(200, { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] });
      if (!this.requirements(pr.baseRef).mergeQueue) {
        return json(200, { errors: [{ type: 'UNPROCESSABLE', message: 'Merge queue is not enabled' }] });
      }
      if (vars.expectedHeadOid && vars.expectedHeadOid !== this.headSha(pr)) {
        return json(200, { errors: [{ type: 'UNPROCESSABLE', message: 'Head SHA mismatch' }] });
      }
      const queue = this.mergeQueues.get(pr.baseRef) ?? [];
      let entry = queue.find((e) => e.number === pr.number);
      if (!entry) {
        entry = {
          id: `MQE_${pr.number}`,
          number: pr.number,
          state: 'QUEUED',
          enqueuedAt: this.tick(),
          headSha: this.headSha(pr),
        };
        queue.push(entry);
      }
      this.mergeQueues.set(pr.baseRef, queue);
      return json(200, {
        data: { enqueuePullRequest: { mergeQueueEntry: this.entryJson(entry, queue.indexOf(entry) + 1) } },
      });
    }
    if (op === 'DequeuePullRequest') {
      for (const [branch, queue] of this.mergeQueues) {
        this.mergeQueues.set(
          branch,
          queue.filter((e) => this.pull(e.number).nodeId !== vars.id),
        );
      }
      return json(200, { data: { dequeuePullRequest: { mergeQueueEntry: { id: String(vars.id) } } } });
    }
    return json(200, { errors: [{ type: 'UNKNOWN', message: `mock: unhandled operation ${op}` }] });
  }
}

export function startMockGitHub(options: MockGitHubOptions = {}): MockGitHub {
  return new MockGitHub(options).start();
}
