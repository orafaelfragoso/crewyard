import { describe, expect, test } from 'bun:test';
import { redactObject, redactSecrets } from '@agent-rail/core';

describe('secret redaction', () => {
  test('redacts provider tokens, private keys and secret assignments', () => {
    const input = [
      'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
      'AWS AKIAABCDEFGHIJKLMNOP',
      'API_KEY="supersecretvalue123"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { text, redactions } = redactSecrets(input);
    expect(redactions).toBe(4);
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('AKIA');
    expect(text).not.toContain('supersecretvalue123');
    expect(text).not.toContain('MIIE');
  });

  test('redacts secret-named fields but keeps references', () => {
    expect(redactObject({ claimToken: 'abc', authRef: 'rail/codex/personal', n: 1 })).toEqual({
      claimToken: '[REDACTED]',
      authRef: 'rail/codex/personal',
      n: 1,
    });
  });
});
