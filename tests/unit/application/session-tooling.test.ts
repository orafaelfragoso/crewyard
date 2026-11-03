import { afterEach, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sessionTooling } from '@crewyard/application';
import { createTestContext, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

test('skills folder is content-addressed, reused, and recreated when deleted', () => {
  ctx = createTestContext();
  const first = sessionTooling(ctx);
  expect(existsSync(join(first.skillsDir!, 'skills', 'crew-execution', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(first.skillsDir!, '.claude-plugin', 'plugin.json'))).toBe(true);
  expect(sessionTooling(ctx).skillsDir).toBe(first.skillsDir);
  rmSync(first.skillsDir!, { recursive: true, force: true });
  expect(existsSync(join(sessionTooling(ctx).skillsDir!, 'skills', 'crew-execution', 'SKILL.md'))).toBe(true);
});
