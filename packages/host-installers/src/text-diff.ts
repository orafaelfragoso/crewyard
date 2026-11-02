const CONTEXT = 3;

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  return text.replace(/\r?\n$/, '').split(/\r?\n/);
}

export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const header = [
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
  ];
  if (prefix === a.length && prefix === b.length) return [...header, '(no textual change)'].join('\n');
  const from = Math.max(0, prefix - CONTEXT);
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const aTo = Math.min(a.length, aEnd + CONTEXT);
  const bTo = Math.min(b.length, bEnd + CONTEXT);
  const body = [
    ...a.slice(from, prefix).map((line) => ` ${line}`),
    ...a.slice(prefix, aEnd).map((line) => `-${line}`),
    ...b.slice(prefix, bEnd).map((line) => `+${line}`),
    ...a.slice(aEnd, aTo).map((line) => ` ${line}`),
  ];
  const range = (start: number, count: number) => `${count === 0 ? start : start + 1},${count}`;
  return [...header, `@@ -${range(from, aTo - from)} +${range(from, bTo - from)} @@`, ...body].join('\n');
}
