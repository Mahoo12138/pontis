/** Typed API error from the Pontis error envelope. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly message: string,
    public readonly requestId: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`);
  }
}

/** Error envelope shape returned by all API endpoints. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: Record<string, unknown>;
  };
}
