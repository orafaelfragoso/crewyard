import { describe, expect, test } from 'bun:test';
import { crewInvocation } from '@crewyard/application';

describe('crewInvocation', () => {
  const compiled = '/$bunfs/root/crew';

  test('uses the running binary while it exists', () => {
    expect(crewInvocation({ execPath: process.execPath, main: compiled, which: () => '/usr/bin/crew' })).toEqual([
      process.execPath,
    ]);
  });

  test('falls back to crew on PATH after an upgrade replaced the running binary', () => {
    const replaced = '/opt/node_modules/.crewyard-abc/bin/crew (deleted)';
    expect(crewInvocation({ execPath: replaced, main: compiled, which: () => '/usr/bin/crew' })).toEqual([
      '/usr/bin/crew',
    ]);
  });

  test('runs the entry script when not compiled', () => {
    expect(crewInvocation({ execPath: '/usr/bin/bun', main: '/src/apps/cli/src/main.ts' })).toEqual([
      '/usr/bin/bun',
      '/src/apps/cli/src/main.ts',
    ]);
  });
});
