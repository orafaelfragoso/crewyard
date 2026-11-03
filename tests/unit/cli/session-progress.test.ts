import { expect, test } from 'bun:test';
import { describeSessionEvent } from '../../../apps/cli/src/session-progress.ts';

const event = (type: string, payload: Record<string, unknown>) => ({ seq: 1, type, payload, at: 'x' });

test('shows tool starts, failures, assistant messages and errors, and hides the rest', () => {
  expect(describeSessionEvent(event('agent.tool', { name: 'Read', status: 'started' }))).toBe('→ Read');
  expect(describeSessionEvent(event('agent.tool', { name: 'Bash', status: 'failed' }))).toBe('✗ Bash failed');
  expect(describeSessionEvent(event('agent.tool', { name: 'Read', status: 'completed' }))).toBeNull();
  expect(describeSessionEvent(event('agent.message', { role: 'assistant', text: '\nPlanning the change\nmore' }))).toBe(
    '· Planning the change',
  );
  expect(describeSessionEvent(event('agent.message', { role: 'user', text: 'prompt' }))).toBeNull();
  expect(describeSessionEvent(event('agent.error', { message: 'rate limited' }))).toBe('✗ rate limited');
  expect(describeSessionEvent(event('agent.log', { text: 'noise' }))).toBeNull();
});
