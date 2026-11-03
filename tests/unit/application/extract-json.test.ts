import { describe, expect, test } from 'bun:test';
import { extractJson } from '@crewyard/application';

describe('extractJson', () => {
  test('reads a fenced object, or the bare object when the fence is unterminated', () => {
    expect(extractJson('Plan:\n```json\n{"tasks": []}\n```\ndone')).toEqual({ tasks: [] });
    expect(extractJson('```\n{"ok": true}')).toEqual({ ok: true });
  });

  test('scans hostile output in linear time', () => {
    const hostile = `\`\`\`${' '.repeat(200_000)}{"ok": true}`;
    const started = performance.now();
    expect(extractJson(hostile)).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
