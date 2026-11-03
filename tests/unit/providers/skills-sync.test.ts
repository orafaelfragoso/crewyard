import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCrewSkills } from '@crewyard/provider-generic';

let root: string | undefined;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

test('replaces Crewyard skills and leaves the account owner skills alone', () => {
  root = mkdtempSync(join(tmpdir(), 'crew-skills-'));
  const source = join(root, 'source');
  const target = join(root, 'target');
  mkdirSync(join(source, 'crew-execution'), { recursive: true });
  writeFileSync(join(source, 'crew-execution', 'SKILL.md'), 'new');
  mkdirSync(join(target, 'crew-retired'), { recursive: true });
  mkdirSync(join(target, 'my-skill'), { recursive: true });

  syncCrewSkills(source, target);

  expect(readFileSync(join(target, 'crew-execution', 'SKILL.md'), 'utf8')).toBe('new');
  expect(existsSync(join(target, 'crew-retired'))).toBe(false);
  expect(existsSync(join(target, 'my-skill'))).toBe(true);
});
