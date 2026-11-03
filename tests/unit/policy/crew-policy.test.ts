import { describe, expect, test } from 'bun:test';
import { classifyPaths } from '@crewyard/reviews';
import { classifyRisk } from '@crewyard/tasks';
import { testConfig } from '../tasks/fixtures.ts';

describe('changes to Crewyard policy always need approval', () => {
  const config = testConfig({ security: { require_approval_for: [], sensitive_paths: {} } });

  test('a task that touches .crewyard requires crew-policy approval even with an empty config', () => {
    const risk = classifyRisk({ risk: 'low', changedPaths: ['.crewyard/config.yaml'] }, config);
    expect(risk.requiredClasses).toEqual(['crew-policy']);
  });

  test('a review of a diff that touches .crewyard requires crew-policy approval', () => {
    const result = classifyPaths(config.security, ['src/app.ts', '.crewyard/config.yaml']);
    expect(result.approvalClasses).toContain('crew-policy');
  });

  test('other paths are unaffected', () => {
    expect(classifyRisk({ risk: 'low', changedPaths: ['src/app.ts'] }, config).requiredClasses).toEqual([]);
  });
});
