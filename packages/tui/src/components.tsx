import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { stateColor, type Theme } from './theme.ts';

export interface Column<T> {
  header: string;
  width: number;
  value(row: T): string;
  color?(row: T): string | undefined;
}

function fit(text: string, width: number): string {
  const clean = text.replace(/\s+/g, ' ');
  if (clean.length <= width) return clean.padEnd(width);
  return `${clean.slice(0, Math.max(0, width - 1))}…`;
}

export function Table<T>(props: {
  theme: Theme;
  columns: Column<T>[];
  rows: T[];
  selected: number;
  height: number;
  empty: string;
}) {
  const { theme, columns, rows, selected, height } = props;
  const visible = Math.max(1, height - 1);
  const start = Math.min(Math.max(0, selected - Math.floor(visible / 2)), Math.max(0, rows.length - visible));
  const window = rows.slice(start, start + visible);
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {columns.map((c) => fit(c.header, c.width)).join(' ')}
      </Text>
      {rows.length === 0 ? <Text color={theme.muted}>{props.empty}</Text> : null}
      {window.map((row, i) => {
        const index = start + i;
        const isSelected = index === selected;
        return (
          <Box key={index}>
            {columns.map((c, ci) => (
              <Text
                key={c.header}
                {...(isSelected
                  ? {
                      backgroundColor: theme.selectionBg,
                      color: theme.selectionFg,
                      inverse: theme.selectionBg === undefined,
                    }
                  : { color: c.color?.(row) })}
              >
                {fit(c.value(row), c.width)}
                {ci < columns.length - 1 ? ' ' : ''}
              </Text>
            ))}
          </Box>
        );
      })}
      {rows.length > visible ? (
        <Text color={theme.muted}>
          {start + 1}-{Math.min(rows.length, start + visible)} of {rows.length}
        </Text>
      ) : null}
    </Box>
  );
}

export function StateText(props: { theme: Theme; state: string; children?: ReactNode }) {
  return <Text color={stateColor(props.theme, props.state)}>{props.children ?? props.state}</Text>;
}

export function Panel(props: { theme: Theme; title: string; children: ReactNode; width?: number | string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.theme.muted}
      paddingX={1}
      {...(props.width === undefined ? { flexGrow: 1 } : { width: props.width })}
    >
      <Text bold color={props.theme.accent}>
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

export function KeyValue(props: { theme: Theme; label: string; value: string | number; color?: string | undefined }) {
  return (
    <Box>
      <Text color={props.theme.muted}>{props.label.padEnd(20)}</Text>
      <Text color={props.color}>{String(props.value)}</Text>
    </Box>
  );
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : '—';
}

export function localTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}
