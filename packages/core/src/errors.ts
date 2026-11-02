export const ERROR_EXIT_CODES = {
  INVALID_INPUT: 2,
  NOT_FOUND: 2,
  CYCLE_DETECTED: 2,
  UNSUPPORTED_CAPABILITY: 2,
  CONFIG_INVALID: 2,
  CONFLICT: 3,
  LEASE_CONFLICT: 3,
  STALE_LEASE: 3,
  INVALID_TRANSITION: 3,
  RESERVATION_CONFLICT: 3,
  HEAD_MISMATCH: 3,
  NOT_AUTHORIZED: 4,
  UNAUTHENTICATED: 4,
  EXTERNAL_FAILURE: 5,
  RATE_LIMITED: 5,
  AMBIGUOUS_REMOTE_OUTCOME: 5,
  OFFLINE: 6,
  UNAVAILABLE: 6,
  INDEX_STALE: 6,
  BUSY: 6,
  POLICY_DENIED: 7,
  APPROVAL_REQUIRED: 7,
  INTERNAL: 8,
  SCHEMA_TOO_NEW: 8,
  MIGRATION_FAILED: 8,
} as const;

export type ErrorCode = keyof typeof ERROR_EXIT_CODES;

export const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'LEASE_CONFLICT',
  'EXTERNAL_FAILURE',
  'RATE_LIMITED',
  'OFFLINE',
  'UNAVAILABLE',
  'BUSY',
  'INDEX_STALE',
]);

export interface CrewErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  suggestion?: string;
  cause?: unknown;
}

export interface SerializedCrewError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  suggestion?: string;
  details?: Record<string, unknown>;
}

export class CrewError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly suggestion: string | undefined;

  constructor(code: ErrorCode, message: string, options: CrewErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CrewError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.details = options.details;
    this.suggestion = options.suggestion;
  }

  get exitCode(): number {
    return ERROR_EXIT_CODES[this.code];
  }

  toJSON(): SerializedCrewError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.suggestion === undefined ? {} : { suggestion: this.suggestion }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isCrewError(error: unknown): error is CrewError {
  return error instanceof CrewError;
}

export function toCrewError(error: unknown): CrewError {
  if (error instanceof CrewError) return error;
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (errno === 'ENOENT') return new CrewError('NOT_FOUND', (error as Error).message, { cause: error });
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new CrewError('NOT_AUTHORIZED', (error as Error).message, { cause: error, retryable: false });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CrewError('INTERNAL', message, { cause: error, retryable: false });
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CrewError('INTERNAL', `Invariant violated: ${message}`);
}
