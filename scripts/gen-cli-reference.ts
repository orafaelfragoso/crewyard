import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildProgram, VERSION } from '../apps/cli/src/cli.ts';

type Command = ReturnType<typeof buildProgram>;

function usage(cmd: Command, parents: string[]): string {
  const args = cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`));
  return [...parents, cmd.name(), ...args].join(' ');
}

function render(cmd: Command, parents: string[], depth: number, out: string[]): void {
  const children = cmd.commands.filter((c) => c.name() !== 'help');
  if (depth > 0) {
    out.push(`${'#'.repeat(Math.min(depth + 2, 5))} \`${usage(cmd, parents)}\``, '', cmd.description(), '');
    const options = cmd.options.filter((o) => !['--help'].includes(o.long ?? ''));
    if (options.length > 0) {
      out.push('| Option | Description |', '|---|---|');
      for (const o of options)
        out.push(
          `| \`${o.flags.replaceAll('|', '\\|')}\` | ${o.description}${o.defaultValue !== undefined ? ` (default: \`${String(o.defaultValue)}\`)` : ''} |`,
        );
      out.push('');
    }
  }
  for (const child of children) render(child, depth > 0 ? [...parents, cmd.name()] : ['rail'], depth + 1, out);
}

const program = buildProgram();
const out = [
  '# CLI reference',
  '',
  `Generated from the \`rail\` ${VERSION} command tree by \`bun scripts/gen-cli-reference.ts\`. Do not edit by hand.`,
  '',
  '## Global conventions',
  '',
  '- `--json`: machine output; a single JSON object (`{ "ok": true, "data": … }` or `{ "ok": false, "error": … }`), or JSONL for `events follow`. Progress goes to stderr.',
  '- `--project NAME|ID`: select a project (default: the project of the current directory).',
  '- Mutating commands accept `--dry-run` where meaningful and `-y/--yes` to confirm destructive or authorization-gated actions; without a TTY they refuse instead of prompting.',
  '- Exit codes: 0 success, 2 invalid input, 3 conflict, 4 not authorized, 5 external failure, 6 unavailable/offline, 7 policy denied, 8 internal error. Errors carry a stable uppercase `code`, `message`, `retryable` and, when useful, `suggestion`.',
  '- Timestamps are RFC 3339 UTC. Secrets and claim tokens are never printed except the claim token returned once by `task claim`.',
  '',
  '## Commands',
  '',
];
render(program, [], 0, out);
writeFileSync(join(resolve(import.meta.dir, '..'), 'docs', 'reference', 'cli.md'), `${out.join('\n').trimEnd()}\n`);
console.log('wrote docs/reference/cli.md');
