import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RailError, resolveDirs, safeJoin } from '@agent-rail/core';
import { tempDir } from '../../helpers/index.ts';

const root = tempDir();
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('path safety', () => {
  test('rejects traversal and symlink escapes', () => {
    const ws = join(root, 'ws');
    const outside = join(root, 'outside');
    mkdirSync(ws);
    mkdirSync(outside);
    expect(() => safeJoin(ws, '../outside/file')).toThrow(RailError);
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(ws, 'link'));
      expect(() => safeJoin(ws, 'link/file')).toThrow(RailError);
    }
    expect(safeJoin(ws, 'src/a.ts').endsWith(join('ws', 'src', 'a.ts'))).toBe(true);
  });

  test('uses OS-standard data directories', () => {
    expect(resolveDirs({ HOME: '/h' } as NodeJS.ProcessEnv, 'linux').data).toBe('/h/.local/share/agent-rail');
    expect(resolveDirs({ HOME: '/h', XDG_DATA_HOME: '/x' } as NodeJS.ProcessEnv, 'linux').data).toBe('/x/agent-rail');
    expect(resolveDirs({ HOME: '/h' } as NodeJS.ProcessEnv, 'darwin').data).toBe('/h/Library/Application Support/agent-rail');
  });
});
