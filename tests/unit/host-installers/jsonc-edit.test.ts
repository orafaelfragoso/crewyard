import { describe, expect, test } from 'bun:test';
import {
  findMember,
  insertMember,
  parseJsoncObject,
  readMemberValue,
  removeMember,
  replaceMemberValue,
} from '@crewyard/host-installers';

function roundTrip(text: string, containerKey: string): string {
  const root = parseJsoncObject(text)!;
  const container = findMember(root, containerKey)!;
  const inserted = insertMember(text, container.object!, 'crewyard', { command: 'crew', args: ['mcp'] });
  const nextRoot = parseJsoncObject(inserted)!;
  const nextContainer = findMember(nextRoot, containerKey)!;
  expect(readMemberValue(inserted, findMember(nextContainer.object!, 'crewyard')!)).toEqual({
    command: 'crew',
    args: ['mcp'],
  });
  return removeMember(inserted, nextContainer.object!, findMember(nextContainer.object!, 'crewyard')!);
}

describe('jsonc editor', () => {
  test.each([
    ['multi-line with comments', '{\n  // servers\n  "mcp": {\n    "other": { "type": "local" } /* keep */\n  }\n}\n'],
    ['trailing comma', '{\n  "mcp": {\n    "other": { "type": "local" },\n  },\n}\n'],
    ['empty container', '{\n  "mcp": {}\n}\n'],
    ['single-line', '{ "mcp": { "a": 1 } }'],
    ['crlf', '{\r\n  "mcp": {\r\n    "a": 1\r\n  }\r\n}\r\n'],
    ['tabs', '{\n\t"mcp": {\n\t\t"a": "x\\"y"\n\t}\n}\n'],
  ])('insert then remove is byte-identical: %s', (_name, text) => {
    expect(roundTrip(text, 'mcp')).toBe(text);
  });

  test('inserted member matches the file indentation', () => {
    const text = '{\n    "mcp": {\n        "a": 1\n    }\n}\n';
    const root = parseJsoncObject(text)!;
    const out = insertMember(text, findMember(root, 'mcp')!.object!, 'crewyard', { x: 1 });
    expect(out).toBe(
      '{\n    "mcp": {\n        "a": 1,\n        "crewyard": {\n            "x": 1\n        }\n    }\n}\n',
    );
  });

  test('removing the first of several members keeps the others', () => {
    const text = '{\n  "crewyard": 1,\n  "b": 2\n}';
    const root = parseJsoncObject(text)!;
    expect(removeMember(text, root, findMember(root, 'crewyard')!)).toBe('{\n  "b": 2\n}');
  });

  test('replaces a value in place', () => {
    const text = '{\n  "a": { "old": true }, // note\n  "b": 2\n}';
    const root = parseJsoncObject(text)!;
    expect(replaceMemberValue(text, findMember(root, 'a')!, { new: 1 })).toBe(
      '{\n  "a": {\n    "new": 1\n  }, // note\n  "b": 2\n}',
    );
  });

  test.each(['[1, 2]', '{ "a": }', '{ "a": 1 } trailing', '{ /* open', ''])('rejects %p', (text) => {
    expect(parseJsoncObject(text)).toBeNull();
  });

  test('ignores braces and comment markers inside strings', () => {
    const root = parseJsoncObject('{ "a": "} // {", "b": { "c": "/* x */" } }')!;
    expect(root.members.map((m) => m.key)).toEqual(['a', 'b']);
    expect(root.members[1]!.object!.members[0]!.key).toBe('c');
  });
});
