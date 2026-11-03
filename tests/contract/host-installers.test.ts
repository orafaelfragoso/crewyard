import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CrewError, resolveDirs } from '@crewyard/core';
import {
  applyPlan,
  applyUninstall,
  type CommandRunner,
  type HostId,
  type PlanOptions,
  planInstall,
  planUninstall,
} from '@crewyard/host-installers';
import { tempDir, writeFiles } from '../helpers/index.ts';

const SKILLS_DIR = join(import.meta.dir, '..', '..', 'skills');
const CREW = ['/opt/crew/bin/crew'];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function setup() {
  const root = tempDir('crew-hosts-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const env = { HOME: home, PATH: '', CREW_DATA_DIR: join(root, 'data') } as NodeJS.ProcessEnv;
  const dirs = resolveDirs(env);
  const base = { env, dirs, which: () => null, crewCommand: CREW, skillsSourceDir: SKILLS_DIR };
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out[`${relative(root, full)}/`] = '<dir>';
          walk(full);
        } else out[relative(root, full)] = readFileSync(full, 'utf8');
      }
    };
    walk(home);
    walk(project);
    return out;
  };
  return { root, home, project, env, dirs, base, snapshot };
}

const CODEX_CONFIG = `model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--stdio"]\n`;
const OPENCODE_CONFIG = `{\n  "$schema": "https://opencode.ai/config.json",\n  // team servers\n  "mcp": {\n    "jira": { "type": "local", "command": ["jira-mcp"], "enabled": true },\n  },\n  "theme": "dark"\n}\n`;
const CLAUDE_MCP = `{\n  "mcpServers": {\n    "github": {\n      "type": "stdio",\n      "command": "gh-mcp"\n    }\n  }\n}\n`;

async function install(options: PlanOptions) {
  const plan = await planInstall(options);
  await applyPlan(plan, options);
  return plan;
}

async function uninstall(options: PlanOptions) {
  const plan = await planUninstall(options);
  await applyUninstall(plan, options);
  return plan;
}

describe('AT-16 install/uninstall round trip', () => {
  test('user scope: codex and opencode configs return byte-identical', async () => {
    const t = setup();
    writeFiles(t.home, {
      '.codex/config.toml': CODEX_CONFIG,
      '.config/opencode/opencode.jsonc': OPENCODE_CONFIG,
      '.agents/skills/mine/SKILL.md': '---\nname: mine\ndescription: user skill\n---\n',
    });
    const before = t.snapshot();
    const options: PlanOptions = { ...t.base, targets: ['codex', 'opencode'], scope: 'user' };
    const plan = await install(options);
    expect(plan.manualInstructions).toEqual([]);

    const codex = Bun.TOML.parse(readFileSync(join(t.home, '.codex/config.toml'), 'utf8')) as {
      mcp_servers: Record<string, unknown>;
    };
    expect(codex.mcp_servers.docs).toEqual({ command: 'docs-mcp', args: ['--stdio'] });
    expect(codex.mcp_servers.crewyard).toEqual({ command: '/opt/crew/bin/crew', args: ['mcp'] });
    const opencode = Bun.JSONC.parse(readFileSync(join(t.home, '.config/opencode/opencode.jsonc'), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(Object.keys(opencode.mcp)).toEqual(['jira', 'crewyard']);
    expect(readFileSync(join(t.home, '.config/opencode/opencode.jsonc'), 'utf8')).toContain('// team servers');
    expect(existsSync(join(t.home, '.agents/skills/crew-execution/SKILL.md'))).toBe(true);

    await uninstall(options);
    expect(t.snapshot()).toEqual(before);
  });

  test('project scope: all hosts with bootstrap instructions return byte-identical', async () => {
    const t = setup();
    writeFiles(t.project, {
      '.mcp.json': CLAUDE_MCP,
      'AGENTS.md': '# Team rules\n\nUse bun.\n',
      'CLAUDE.md': '# Claude rules\n',
    });
    const before = t.snapshot();
    const options: PlanOptions = {
      ...t.base,
      targets: ['codex', 'claude', 'opencode'],
      scope: 'project',
      projectRoot: t.project,
      includeInstructions: true,
    };
    const plan = await install(options);
    expect(plan.manualInstructions).toEqual([]);
    const agentsMd = plan.changes.filter((c) => c.kind === 'file' && c.path.endsWith('AGENTS.md'));
    expect(agentsMd).toHaveLength(1);
    expect(agentsMd[0]!.hosts.sort()).toEqual(['codex', 'opencode']);
    expect(readFileSync(join(t.project, 'AGENTS.md'), 'utf8')).toStartWith(
      '# Team rules\n\nUse bun.\n\n<!-- >>> crewyard',
    );
    expect(readFileSync(join(t.project, 'CLAUDE.md'), 'utf8')).toContain('crew_claim_task');
    expect(JSON.parse(readFileSync(join(t.project, '.mcp.json'), 'utf8')).mcpServers).toEqual({
      github: { type: 'stdio', command: 'gh-mcp' },
      crewyard: { type: 'stdio', command: '/opt/crew/bin/crew', args: ['mcp'] },
    });
    expect(Bun.JSONC.parse(readFileSync(join(t.project, 'opencode.json'), 'utf8'))).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: { crewyard: { type: 'local', command: ['/opt/crew/bin/crew', 'mcp'], enabled: true } },
    });
    expect(existsSync(join(t.project, '.claude/skills/crew-review/references/finding-format.md'))).toBe(true);

    await uninstall(options);
    expect(t.snapshot()).toEqual(before);
  });

  test('structural removal works without backup manifests', async () => {
    const t = setup();
    writeFiles(t.project, { '.mcp.json': CLAUDE_MCP, 'opencode.json': OPENCODE_CONFIG, 'AGENTS.md': '# Rules\n' });
    writeFiles(t.project, { '.codex/config.toml': CODEX_CONFIG });
    const before = t.snapshot();
    const options: PlanOptions = {
      ...t.base,
      targets: ['codex', 'claude', 'opencode'],
      scope: 'project',
      projectRoot: t.project,
      includeInstructions: true,
    };
    await install(options);
    rmSync(t.dirs.backups, { recursive: true, force: true });
    await uninstall(options);
    expect(t.snapshot()).toEqual(before);
  });

  test('reinstall is idempotent', async () => {
    const t = setup();
    const options: PlanOptions = { ...t.base, targets: ['codex', 'opencode'], scope: 'user' };
    await install(options);
    expect((await planInstall(options)).changes).toEqual([]);
  });

  test('uninstalling one host keeps shared files another registered host still uses', async () => {
    const t = setup();
    const options: PlanOptions = {
      ...t.base,
      targets: ['codex', 'opencode'],
      scope: 'project',
      projectRoot: t.project,
      includeInstructions: true,
    };
    await install(options);
    const plan = await uninstall({ ...options, targets: ['codex'] });
    expect(plan.notes.some((n) => n.includes('opencode still uses'))).toBe(true);
    expect(readFileSync(join(t.project, 'AGENTS.md'), 'utf8')).toContain('crewyard');
    expect(existsSync(join(t.project, '.agents/skills/crew-execution/SKILL.md'))).toBe(true);
    expect(existsSync(join(t.project, '.codex/config.toml'))).toBe(false);
  });
});

describe('safety', () => {
  test('dry run writes nothing, including backups', async () => {
    const t = setup();
    writeFiles(t.home, { '.codex/config.toml': CODEX_CONFIG });
    const before = t.snapshot();
    const options: PlanOptions = { ...t.base, targets: ['codex', 'claude', 'opencode'], scope: 'user' };
    const plan = await planInstall(options);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.every((c) => c.preview.length > 0)).toBe(true);
    const result = await applyPlan(plan, { ...options, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, backupDir: null, applied: [] });
    expect(t.snapshot()).toEqual(before);
    expect(existsSync(t.dirs.backups)).toBe(false);
  });

  test.each<[HostId, string, string]>([
    ['codex', '.codex/config.toml', '[mcp_servers.crewyard]\ncommand = "someone-else"\n'],
    ['claude', '.mcp.json', '{ "mcpServers": { "crewyard": { "command": "someone-else" } } }\n'],
    ['opencode', 'opencode.json', '{ "mcp": { "crewyard": { "type": "local", "command": ["x"] } } }\n'],
  ])('%s: foreign crewyard entry yields manual instructions', async (host, file, content) => {
    const t = setup();
    writeFiles(t.project, { [file]: content });
    const plan = await planInstall({ ...t.base, targets: [host], scope: 'project', projectRoot: t.project });
    expect(plan.changes.some((c) => c.kind === 'file' && c.path === join(t.project, file))).toBe(false);
    const manual = plan.manualInstructions.find((m) => m.purpose === 'mcp')!;
    expect(manual.reason).toMatch(/not create|outside Crewyard-managed/);
    expect(manual.snippet).toContain('/opt/crew/bin/crew');

    const removal = await planUninstall({ ...t.base, targets: [host], scope: 'project', projectRoot: t.project });
    expect(removal.changes.filter((c) => c.purpose === 'mcp')).toEqual([]);
    expect(removal.manualInstructions.some((m) => m.purpose === 'mcp')).toBe(true);
  });

  test('unparseable config yields manual instructions instead of an edit', async () => {
    const t = setup();
    writeFiles(t.project, { 'opencode.json': '{ "mcp": { oops } }\n', '.codex/config.toml': 'x = [\n' });
    const plan = await planInstall({
      ...t.base,
      targets: ['codex', 'opencode'],
      scope: 'project',
      projectRoot: t.project,
      skillsSourceDir: undefined,
    });
    expect(plan.changes).toEqual([]);
    expect(plan.manualInstructions.map((m) => m.host).sort()).toEqual(['codex', 'opencode']);
  });

  test('a host version newer than tested is not edited', async () => {
    const t = setup();
    const exec: CommandRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 1.0.0\n', stderr: '' });
    const plan = await planInstall({
      ...t.base,
      which: (bin) => (bin === 'codex' ? '/usr/bin/codex' : null),
      exec,
      targets: ['codex'],
      scope: 'user',
    });
    expect(plan.changes).toEqual([]);
    expect(plan.hosts[0]).toMatchObject({ host: 'codex', version: '1.0.0', support: 'unsupported' });
    expect(plan.manualInstructions[0]?.command).toBe('codex mcp add crewyard -- /opt/crew/bin/crew mcp');
  });

  test('a file edited after planning aborts the apply', async () => {
    const t = setup();
    writeFiles(t.home, { '.codex/config.toml': CODEX_CONFIG });
    const options: PlanOptions = { ...t.base, targets: ['codex'], scope: 'user' };
    const plan = await planInstall(options);
    writeFileSync(join(t.home, '.codex/config.toml'), `${CODEX_CONFIG}# edited\n`);
    const error = await applyPlan(plan, options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrewError);
    expect((error as CrewError).code).toBe('CONFLICT');
    expect(existsSync(join(t.home, '.agents/skills'))).toBe(false);
  });
});

describe('claude user scope', () => {
  test('registers and removes through the claude CLI with a backup', async () => {
    const t = setup();
    const stateFile = join(t.home, '.claude.json');
    writeFileSync(stateFile, '{"mcpServers":{}}');
    const calls: string[][] = [];
    const exec: CommandRunner = async (argv) => {
      calls.push([...argv]);
      if (argv[1] === '--version') return { exitCode: 0, stdout: '2.1.316 (Claude Code)\n', stderr: '' };
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { mcpServers: Record<string, unknown> };
      if (argv[2] === 'add-json') state.mcpServers[argv[5]!] = { ...JSON.parse(argv[6]!), env: {} };
      if (argv[2] === 'remove') delete state.mcpServers[argv[5]!];
      writeFileSync(stateFile, JSON.stringify(state));
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const options: PlanOptions = {
      ...t.base,
      which: (bin) => (bin === 'claude' ? '/usr/bin/claude' : null),
      exec,
      targets: ['claude'],
      scope: 'user',
    };
    const plan = await install(options);
    const command = plan.changes.find((c) => c.kind === 'command')!;
    expect(command.preview).toBe(
      `$ /usr/bin/claude mcp add-json --scope user crewyard '{"type":"stdio","command":"/opt/crew/bin/crew","args":["mcp"]}'`,
    );
    expect(existsSync(join(t.home, '.claude/skills/crew-context/SKILL.md'))).toBe(true);
    expect((await planInstall(options)).changes).toEqual([]);

    await uninstall(options);
    expect(calls.at(-1)).toEqual(['/usr/bin/claude', 'mcp', 'remove', '--scope', 'user', 'crewyard']);
    expect(readFileSync(stateFile, 'utf8')).toBe('{"mcpServers":{}}');
    expect(existsSync(join(t.home, '.claude/skills'))).toBe(false);
  });

  test('missing claude CLI yields the exact manual command', async () => {
    const t = setup();
    const plan = await planInstall({ ...t.base, targets: ['claude'], scope: 'user', skillsSourceDir: undefined });
    expect(plan.changes).toEqual([]);
    expect(plan.manualInstructions[0]?.command).toBe('claude mcp add --scope user crewyard -- /opt/crew/bin/crew mcp');
  });
});
