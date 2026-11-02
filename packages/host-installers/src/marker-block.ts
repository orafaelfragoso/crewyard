export interface MarkerStyle {
  start: string;
  end: string;
}

export const HASH_MARKERS: MarkerStyle = { start: '# >>> crewyard >>>', end: '# <<< crewyard <<<' };
export const HTML_MARKERS: MarkerStyle = { start: '<!-- >>> crewyard >>> -->', end: '<!-- <<< crewyard <<< -->' };

export interface MarkerSpan {
  start: number;
  end: number;
}

interface Line {
  text: string;
  start: number;
  end: number;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({ text: text.slice(start, end).replace(/\r?\n$/, ''), start, end });
    start = end;
  }
  return out;
}

export function findMarkerBlock(text: string, style: MarkerStyle): MarkerSpan | null | 'malformed' {
  const all = lines(text);
  const starts = all.filter((line) => line.text.trim() === style.start);
  const ends = all.filter((line) => line.text.trim() === style.end);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) return 'malformed';
  const [open] = starts as [Line];
  const [close] = ends as [Line];
  return open.start < close.start ? { start: open.start, end: close.end } : 'malformed';
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

export function renderMarkerBlock(style: MarkerStyle, body: string, eol = '\n'): string {
  const content = body
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .join(eol);
  return `${style.start}${eol}${content}${eol}${style.end}${eol}`;
}

export function upsertMarkerBlock(text: string, style: MarkerStyle, body: string): string {
  const eol = eolOf(text);
  const block = renderMarkerBlock(style, body, eol);
  const span = findMarkerBlock(text, style);
  if (span === 'malformed') throw new Error('Malformed crewyard marker block');
  if (span) return text.slice(0, span.start) + block + text.slice(span.end);
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '' : eol}${eol}${block}`;
}

export function removeMarkerBlock(text: string, style: MarkerStyle): string {
  const span = findMarkerBlock(text, style);
  if (span === 'malformed') throw new Error('Malformed crewyard marker block');
  if (!span) return text;
  let before = text.slice(0, span.start);
  const after = text.slice(span.end);
  if (before.endsWith('\r\n\r\n')) before = before.slice(0, -2);
  else if (before.endsWith('\n\n')) before = before.slice(0, -1);
  return before + after;
}
