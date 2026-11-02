import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadSkills, parseSkillFrontmatter, validateSkill } from '@agent-rail/host-installers';

const SKILLS_DIR = join(import.meta.dir, '..', '..', '..', 'skills');
const REQUIRED = [
  'rail-context',
  'rail-execution',
  'rail-integration',
  'rail-planning',
  'rail-recovery',
  'rail-review',
];
const skills = loadSkills(SKILLS_DIR);
const text = (name: string) =>
  skills
    .find((s) => s.name === name)!
    .files.map((f) => f.content)
    .join('\n');

describe('bundled skills (FR-SKL-01..03)', () => {
  test('all required skills exist and pass Agent Skills validation', () => {
    expect(skills.map((s) => s.name)).toEqual(REQUIRED);
  });

  const contractOf = (name: string) => /## Rail contract\n([\s\S]*?)\n## /.exec(text(name))?.[1] ?? '';

  test('every skill carries the same FR-SKL-03 contract', () => {
    const contract = contractOf('rail-execution');
    for (const clause of [
      /Inspect `rail_get_state` and the project policy/,
      /`rail_claim_task` before modifying/,
      /assigned worktree/,
      /Renew the lease with `rail_heartbeat`/,
      /Do not rebase proactively/,
      /structured evidence with `rail_submit_work`/,
      /Never bypass merge authority/,
      /`rail_report_blocker` instead of retrying indefinitely/,
      /next safe action with `rail_get_next_action`/,
    ]) {
      expect(contract).toMatch(clause);
    }
    for (const name of REQUIRED) expect(contractOf(name)).toBe(contract);
  });

  test.each(REQUIRED)('%s maps MCP tools to CLI commands in JSON mode', (name) => {
    expect(text(name)).toMatch(/\| `rail_[a-z_]+` \| `rail [a-z]+ [^`]*--json`/);
  });

  test('rail-integration states it cannot merge directly', () => {
    expect(text('rail-integration')).toContain('cannot merge directly');
  });
});

describe('AT-15 static check: skills grant no administrative capability', () => {
  const forbidden: [string, RegExp][] = [
    ['direct merge command', /gh\s+pr\s+merge|gh\s+api\b[^\n]*merge/i],
    ['force push', /git\s+push\s+[^\n]*(--force|-f\b)/i],
    ['proactive rebase command', /git\s+rebase/i],
    ['hard reset', /git\s+reset\s+--hard/i],
    ['credential or account administration', /rail\s+account\s+(add|remove)|rail\s+config\s+set/i],
    [
      'operator-only queue/service control',
      /rail\s+(queue\s+(tick|pause|resume)|service\s|workspace\s+clean|goal\s+approve)/i,
    ],
    ['secret store access', /keychain|secret-tool|credential manager|security\s+find-generic-password/i],
    ['admin bypass flag', /--admin\b|--no-verify\b|--force\b/i],
  ];

  test.each(REQUIRED)('%s contains no forbidden instruction', (name) => {
    const body = text(name);
    for (const [label, pattern] of forbidden) {
      expect({ label, match: pattern.exec(body)?.[0] ?? null }).toEqual({ label, match: null });
    }
  });

  test.each(REQUIRED)('%s treats repository content and tool output as untrusted', (name) => {
    const body = text(name);
    expect(body).toContain('## Untrusted content');
    expect(body).toMatch(/data, not instructions|not instructions to you/);
    expect(body).toMatch(/tool output/i);
  });
});

describe('validateSkill', () => {
  const skill = (front: string) => `---\n${front}\n---\nbody\n`;

  test('accepts the optional spec fields', () => {
    const md = skill('name: a-b\ndescription: Does x. Use when y.\nlicense: MIT\nmetadata:\n  version: "1"');
    expect(validateSkill('a-b', md)).toEqual([]);
    expect(parseSkillFrontmatter(md)?.license).toBe('MIT');
  });

  test.each([
    ['name mismatch', 'other', skill('name: a-b\ndescription: d')],
    ['uppercase', 'A-b', skill('name: A-b\ndescription: d')],
    ['consecutive hyphens', 'a--b', skill('name: a--b\ndescription: d')],
    ['leading hyphen', '-ab', skill('name: -ab\ndescription: d')],
    ['missing description', 'a', skill('name: a')],
    ['long description', 'a', skill(`name: a\ndescription: ${'x'.repeat(1025)}`)],
    ['non-string metadata', 'a', skill('name: a\ndescription: d\nmetadata:\n  n: 1')],
    ['unknown field', 'a', skill('name: a\ndescription: d\nversion: 1')],
    ['no frontmatter', 'a', '# a\n'],
  ])('rejects %s', (_label, dir, md) => {
    expect(validateSkill(dir, md).length).toBeGreaterThan(0);
  });
});
