export interface Theme {
  name: 'default' | 'high-contrast' | 'monochrome';
  accent: string | undefined;
  muted: string | undefined;
  ok: string | undefined;
  warn: string | undefined;
  error: string | undefined;
  selectionBg: string | undefined;
  selectionFg: string | undefined;
  bold: boolean;
}

export const THEMES: readonly Theme[] = [
  {
    name: 'default',
    accent: 'cyan',
    muted: 'gray',
    ok: 'green',
    warn: 'yellow',
    error: 'red',
    selectionBg: 'blue',
    selectionFg: 'white',
    bold: false,
  },
  {
    name: 'high-contrast',
    accent: 'whiteBright',
    muted: 'white',
    ok: 'greenBright',
    warn: 'yellowBright',
    error: 'redBright',
    selectionBg: 'white',
    selectionFg: 'black',
    bold: true,
  },
  {
    name: 'monochrome',
    accent: undefined,
    muted: undefined,
    ok: undefined,
    warn: undefined,
    error: undefined,
    selectionBg: undefined,
    selectionFg: undefined,
    bold: true,
  },
];

export function initialTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return THEMES[2]!;
  const requested = env.CREW_THEME;
  return THEMES.find((t) => t.name === requested) ?? THEMES[0]!;
}

export function stateColor(theme: Theme, state: string): string | undefined {
  if (
    ['DONE', 'MERGED', 'merged', 'passed', 'completed', 'healthy', 'eligible', 'SUCCESS', 'success'].includes(state)
  ) {
    return theme.ok;
  }
  if (
    ['BLOCKED', 'ESCALATED', 'failed', 'quarantined', 'escalated', 'blocked', 'FAILURE', 'failure', 'lost'].includes(
      state,
    )
  ) {
    return theme.error;
  }
  if (['REVISION', 'CANCEL_REQUESTED', 'waiting', 'pending', 'rate_limited', 'PENDING', 'orphaned'].includes(state)) {
    return theme.warn;
  }
  if (
    ['RUNNING', 'CLAIMED', 'VALIDATING', 'REVIEWING', 'running', 'validating', 'merging', 'candidate'].includes(state)
  ) {
    return theme.accent;
  }
  return undefined;
}
