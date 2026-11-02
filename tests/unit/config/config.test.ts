import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { RailError, resolveDirs } from '@agent-rail/core';
import { loadConfig, renderConfigTemplate, setConfigValue, validateConfigText } from '@agent-rail/config';
import { tempDir, writeFiles } from '../../helpers/index.ts';

const dirs = () => resolveDirs({ RAIL_DATA_DIR: join(tempDir(), 'data') } as NodeJS.ProcessEnv);

describe('configuration', () => {
  test('generated template validates', () => {
    expect(validateConfigText(renderConfigTemplate({ projectName: 'demo', baseBranch: 'main' }))).toEqual([]);
  });

  test('rejects unknown keys, bad enums, secrets and contradictions', () => {
    const issues = validateConfigText(`version: 1
project: { name: demo, autonomy: assisted }
integration: { mode: yolo, auto_merge_eligible: true }
security: { github_token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB }
surprise: true
`);
    const paths = issues.map((i) => i.path);
    expect(paths).toContain('security.github_token');
    expect(paths.some((p) => p.startsWith('integration.mode') || p === '(root)' || p === 'security')).toBe(true);
    const contradictions = validateConfigText('version: 1\nproject: { name: demo, autonomy: assisted }\n');
    expect(contradictions.map((i) => i.path)).toContain('integration.auto_merge_eligible');
  });

  test('precedence is flags > env > repository > user > defaults', () => {
    const d = dirs();
    const repo = tempDir();
    writeFiles(d.config, { 'config.yaml': 'version: 1\nproject: { name: demo }\nagents: { max_parallel: 2, max_retries_per_failure: 5 }\n' });
    writeFiles(repo, { '.agent-rail/config.yaml': 'version: 1\nproject: { name: demo }\nagents: { max_parallel: 3 }\nscheduler: { max_open_prs: 4 }\n' });
    const loaded = loadConfig({
      repoRoot: repo,
      dirs: d,
      env: { RAIL_MAX_OPEN_PRS: '5', RAIL_MAX_PARALLEL: '7' },
      flags: { 'agents.max_parallel': 9 },
    });
    expect(loaded.config.agents.max_parallel).toBe(9);
    expect(loaded.sources['agents.max_parallel']).toBe('flag');
    expect(loaded.config.scheduler.max_open_prs).toBe(5);
    expect(loaded.sources['scheduler.max_open_prs']).toBe('env');
    expect(loaded.config.agents.max_retries_per_failure).toBe(5);
    expect(loaded.sources['agents.max_retries_per_failure']).toBe('user');
    expect(loaded.sources['index.max_context_tokens']).toBe('default');
  });

  test('config set validates and refuses secrets', () => {
    const repo = tempDir();
    const file = join(repo, '.agent-rail/config.yaml');
    writeFiles(repo, { '.agent-rail/config.yaml': renderConfigTemplate({ projectName: 'demo', baseBranch: 'main' }) });
    expect(setConfigValue(file, 'index.max_context_tokens', '12000').next).toBe(12000);
    expect(() => setConfigValue(file, 'integration.mode', 'yolo')).toThrow(RailError);
    expect(() => setConfigValue(file, 'security.api_key', 'abcdefghijklmnop')).toThrow(RailError);
  });
});
