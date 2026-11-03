import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProject, resolveProject } from '@crewyard/projects';
import { createTempGitRepo, createTestContext, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
let repo: string | undefined;
afterEach(() => {
  ctx?.cleanup();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('commands outside a registered repository are refused even with a single project', async () => {
  ctx = createTestContext();
  repo = await createTempGitRepo({ 'README.md': '# r\n', 'src/app.ts': 'export {};\n' });
  const { project } = await registerProject(ctx, {
    repoPath: repo,
    baseBranch: 'main',
    actor: { kind: 'operator', id: 'o' },
  });
  expect((await resolveProject(ctx, undefined, join(repo, 'src'))).id).toBe(project.id);
  await expect(resolveProject(ctx, undefined, tmpdir())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect((await resolveProject(ctx, project.name, tmpdir())).id).toBe(project.id);
});
