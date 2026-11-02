import { describe, expect, test } from 'bun:test';
import {
  findMarkerBlock,
  HASH_MARKERS,
  removeMarkerBlock,
  unifiedDiff,
  upsertMarkerBlock,
} from '@agent-rail/host-installers';

describe('marker blocks', () => {
  test.each([
    ['empty', ''],
    ['newline-terminated', 'model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n'],
    ['crlf', 'a = 1\r\nb = 2\r\n'],
  ])('upsert then remove is byte-identical: %s', (_name, text) => {
    const added = upsertMarkerBlock(text, HASH_MARKERS, '[mcp_servers.agent-rail]\ncommand = "rail"');
    expect(added).toContain('# >>> agent-rail >>>');
    expect(removeMarkerBlock(added, HASH_MARKERS)).toBe(text);
  });

  test('upsert replaces an existing block in place', () => {
    const once = upsertMarkerBlock('a = 1\n', HASH_MARKERS, 'old = 1');
    const twice = upsertMarkerBlock(`${once}b = 2\n`, HASH_MARKERS, 'new = 1');
    expect(twice).toBe('a = 1\n\n# >>> agent-rail >>>\nnew = 1\n# <<< agent-rail <<<\nb = 2\n');
  });

  test('unbalanced markers are reported as malformed', () => {
    expect(findMarkerBlock('# >>> agent-rail >>>\nx = 1\n', HASH_MARKERS)).toBe('malformed');
    expect(findMarkerBlock('# <<< agent-rail <<<\n# >>> agent-rail >>>\n', HASH_MARKERS)).toBe('malformed');
    expect(() => removeMarkerBlock('# >>> agent-rail >>>\n', HASH_MARKERS)).toThrow();
  });
});

describe('unifiedDiff', () => {
  test('shows a contiguous change with context', () => {
    const diff = unifiedDiff('f.toml', 'a\nb\nc\n', 'a\nb\nX\nc\n');
    expect(diff.split('\n')).toEqual(['--- a/f.toml', '+++ b/f.toml', '@@ -1,3 +1,4 @@', ' a', ' b', '+X', ' c']);
  });

  test('marks created files', () => {
    expect(unifiedDiff('n.md', null, 'x\n')).toStartWith('--- /dev/null\n+++ b/n.md\n@@ -0,0 +1,1 @@\n+x');
  });
});
