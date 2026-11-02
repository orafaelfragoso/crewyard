export interface JsonMemberSpan {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  commaIndex: number | null;
  object: JsonObjectSpan | null;
}

export interface JsonObjectSpan {
  start: number;
  end: number;
  members: JsonMemberSpan[];
}

class JsoncSyntaxError extends Error {}

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  fail(message: string): never {
    throw new JsoncSyntaxError(`${message} at offset ${this.pos}`);
  }

  skipTrivia(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
        this.pos++;
      } else if (c === '/' && t[this.pos + 1] === '/') {
        const nl = t.indexOf('\n', this.pos);
        this.pos = nl === -1 ? t.length : nl + 1;
      } else if (c === '/' && t[this.pos + 1] === '*') {
        const close = t.indexOf('*/', this.pos + 2);
        if (close === -1) this.fail('Unterminated block comment');
        this.pos = close + 2;
      } else {
        return;
      }
    }
  }

  string(): string {
    const start = this.pos;
    if (this.text[this.pos] !== '"') this.fail('Expected string');
    this.pos++;
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === '\\') this.pos += 2;
      else if (c === '"') {
        this.pos++;
        return JSON.parse(this.text.slice(start, this.pos)) as string;
      } else this.pos++;
    }
    return this.fail('Unterminated string');
  }

  value(): JsonObjectSpan | null {
    const c = this.text[this.pos];
    if (c === '{') return this.object();
    if (c === '[') {
      this.array();
      return null;
    }
    if (c === '"') {
      this.string();
      return null;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.pos));
    if (!match) this.fail('Unexpected token');
    this.pos += match[0].length;
    return null;
  }

  array(): void {
    this.pos++;
    this.skipTrivia();
    while (this.text[this.pos] !== ']') {
      this.value();
      this.skipTrivia();
      if (this.text[this.pos] === ',') {
        this.pos++;
        this.skipTrivia();
      } else if (this.text[this.pos] !== ']') this.fail('Expected , or ]');
    }
    this.pos++;
  }

  object(): JsonObjectSpan {
    const start = this.pos;
    const members: JsonMemberSpan[] = [];
    this.pos++;
    this.skipTrivia();
    while (this.text[this.pos] !== '}') {
      const keyStart = this.pos;
      const key = this.string();
      this.skipTrivia();
      if (this.text[this.pos] !== ':') this.fail('Expected :');
      this.pos++;
      this.skipTrivia();
      const valueStart = this.pos;
      const object = this.value();
      const member: JsonMemberSpan = { key, keyStart, valueStart, valueEnd: this.pos, commaIndex: null, object };
      members.push(member);
      this.skipTrivia();
      if (this.text[this.pos] === ',') {
        member.commaIndex = this.pos;
        this.pos++;
        this.skipTrivia();
      } else if (this.text[this.pos] !== '}') this.fail('Expected , or }');
    }
    return { start, end: this.pos++, members };
  }
}

export function parseJsoncObject(text: string): JsonObjectSpan | null {
  const scanner = new Scanner(text);
  try {
    scanner.skipTrivia();
    if (text[scanner.pos] !== '{') return null;
    const root = scanner.object();
    scanner.skipTrivia();
    return scanner.pos === text.length ? root : null;
  } catch (error) {
    if (error instanceof JsoncSyntaxError) return null;
    throw error;
  }
}

export function findMember(object: JsonObjectSpan, key: string): JsonMemberSpan | undefined {
  return object.members.findLast((member) => member.key === key);
}

export function detectIndentUnit(text: string): string {
  const match = /^([ \t]+)["/]/m.exec(text);
  return match?.[1] ?? '  ';
}

function lineIndentAt(text: string, index: number): { indent: string; ownLine: boolean } {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  return { indent: /^[ \t]*/.exec(prefix)?.[0] ?? '', ownLine: /^[ \t]*$/.test(prefix) };
}

function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function serialize(key: string, value: unknown, indent: string, unit: string, eol: string): string {
  const body = JSON.stringify(value, null, unit).split('\n').join(`${eol}${indent}`);
  return `${JSON.stringify(key)}: ${body}`;
}

export function insertMember(text: string, object: JsonObjectSpan, key: string, value: unknown): string {
  const unit = detectIndentUnit(text);
  const eol = eolOf(text);
  const last = object.members.at(-1);
  if (!last) {
    const parentIndent = lineIndentAt(text, object.start).indent;
    const indent = parentIndent + unit;
    const inner = text.slice(object.start + 1, object.end);
    const member = `${eol}${indent}${serialize(key, value, indent, unit, eol)}`;
    if (inner.trim() === '') {
      return `${text.slice(0, object.start + 1)}${member}${eol}${parentIndent}${text.slice(object.end)}`;
    }
    return `${text.slice(0, object.start + 1)}${member}${text.slice(object.start + 1)}`;
  }
  const first = object.members[0]!;
  const { indent, ownLine } = lineIndentAt(text, first.keyStart);
  const member = ownLine
    ? `,${eol}${indent}${serialize(key, value, indent, unit, eol)}`
    : `, ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  return `${text.slice(0, last.valueEnd)}${member}${text.slice(last.valueEnd)}`;
}

export function replaceMemberValue(text: string, member: JsonMemberSpan, value: unknown): string {
  const unit = detectIndentUnit(text);
  const { indent } = lineIndentAt(text, member.keyStart);
  const body = JSON.stringify(value, null, unit)
    .split('\n')
    .join(`${eolOf(text)}${indent}`);
  return `${text.slice(0, member.valueStart)}${body}${text.slice(member.valueEnd)}`;
}

export function removeMember(text: string, object: JsonObjectSpan, member: JsonMemberSpan): string {
  const index = object.members.indexOf(member);
  if (index > 0) {
    const previous = object.members[index - 1]!;
    return text.slice(0, previous.commaIndex ?? previous.valueEnd) + text.slice(member.valueEnd);
  }
  const next = object.members[index + 1];
  if (next) return text.slice(0, member.keyStart) + text.slice(next.keyStart);
  const memberEnd = member.commaIndex === null ? member.valueEnd : member.commaIndex + 1;
  const before = text.slice(object.start + 1, member.keyStart);
  const after = text.slice(memberEnd, object.end);
  if (before.trim() === '' && after.trim() === '') return text.slice(0, object.start + 1) + text.slice(object.end);
  return text.slice(0, member.keyStart) + text.slice(memberEnd);
}

export function readMemberValue(text: string, member: JsonMemberSpan): unknown {
  return Bun.JSONC.parse(text.slice(member.valueStart, member.valueEnd));
}
