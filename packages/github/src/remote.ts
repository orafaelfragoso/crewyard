import { parseRemoteUrl, RailError } from '@agent-rail/core';
import type { RepositoryCoordinates } from './types.ts';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function assertRemoteMatches(expected: RepositoryCoordinates, remoteUrl: string | null): void {
  const observed = remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  if (!observed) {
    throw new RailError('POLICY_DENIED', 'The repository has no parseable GitHub remote', {
      retryable: false,
      details: { expected: `${expected.owner}/${expected.name}` },
      suggestion: 'Configure `origin` to point at the GitHub repository registered with Rail.',
    });
  }
  const hostMatches =
    same(observed.host, expected.host) || (same(expected.host, 'github.com') && same(observed.host, 'ssh.github.com'));
  if (!hostMatches || !same(observed.owner, expected.owner) || !same(observed.name, expected.name)) {
    throw new RailError(
      'POLICY_DENIED',
      `Remote ${observed.host}/${observed.owner}/${observed.name} does not match registered ${expected.host}/${expected.owner}/${expected.name}`,
      {
        retryable: false,
        details: {
          expected: `${expected.host}/${expected.owner}/${expected.name}`,
          observed: `${observed.host}/${observed.owner}/${observed.name}`,
        },
        suggestion:
          'Run `rail project sync` after confirming the remote change; Rail never posts to another repository.',
      },
    );
  }
}
