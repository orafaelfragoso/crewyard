export type IdPrefix =
  | 'op'
  | 'evt'
  | 'prj'
  | 'repo'
  | 'snap'
  | 'ctx'
  | 'agt'
  | 'team'
  | 'prof'
  | 'pol'
  | 'ses'
  | 'ws'
  | 'wsa'
  | 'pr'
  | 'rev'
  | 'fnd'
  | 'val'
  | 'q'
  | 'qe'
  | 'cand'
  | 'lease'
  | 'res'
  | 'wrk'
  | 'rop'
  | 'bud'
  | 'ntf'
  | 'apr'
  | 'org'
  | 'corr';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${Bun.randomUUIDv7().replaceAll('-', '')}`;
}

export function newSecretToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `crew_${Buffer.from(bytes).toString('base64url')}`;
}
