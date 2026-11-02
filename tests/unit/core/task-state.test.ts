import { describe, expect, test } from 'bun:test';
import { allowedNextStates, assertTransition, RailError, TASK_STATES } from '@agent-rail/core';

describe('task state machine', () => {
  test('follows the documented happy path', () => {
    const path = [
      'DRAFT',
      'READY',
      'CLAIMED',
      'RUNNING',
      'SUBMITTED',
      'REVIEWING',
      'QUEUED',
      'VALIDATING',
      'MERGED',
      'DONE',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) expect(() => assertTransition(path[i]!, path[i + 1]!)).not.toThrow();
  });

  test('rejects undefined transitions with allowed next states', () => {
    try {
      assertTransition('READY', 'MERGED', 'TASK-1');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RailError);
      const rail = error as RailError;
      expect(rail.code).toBe('INVALID_TRANSITION');
      expect(rail.exitCode).toBe(3);
      expect(rail.details?.allowed).toEqual(allowedNextStates('READY'));
    }
  });

  test('terminal states have no exits and every active state can be cancelled or escalated', () => {
    expect(allowedNextStates('DONE')).toEqual([]);
    expect(allowedNextStates('CANCELLED')).toEqual([]);
    for (const state of [
      'CLAIMED',
      'RUNNING',
      'SUBMITTED',
      'REVIEWING',
      'REVISION',
      'BLOCKED',
      'QUEUED',
      'VALIDATING',
    ] as const) {
      expect(allowedNextStates(state)).toContain('CANCEL_REQUESTED');
      expect(allowedNextStates(state)).toContain('ESCALATED');
    }
    expect(TASK_STATES.length).toBe(15);
  });
});
