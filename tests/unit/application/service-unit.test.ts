import { afterEach, describe, expect, test } from 'bun:test';
import { planServiceUnit } from '@crewyard/application';
import { createTestContext, type TestContext } from '../../helpers/index.ts';

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

describe('planServiceUnit', () => {
  test.skipIf(process.platform !== 'linux')(
    'the systemd unit keeps the installing PATH so agents can find their tools',
    () => {
      ctx = createTestContext();
      const original = process.env.PATH;
      process.env.PATH = '/opt/my tools/bin:/usr/bin';
      try {
        expect(planServiceUnit(ctx, ctx.root).content).toContain('Environment="PATH=/opt/my tools/bin:/usr/bin"');
      } finally {
        process.env.PATH = original;
      }
    },
  );
});
