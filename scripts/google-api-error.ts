export class GoogleApiResponseError extends Error {
  readonly retryable: boolean;

  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GoogleApiResponseError";
    this.retryable = status === 429 || status === 503;
  }
}

export function shouldRetryGoogleApiError(error: unknown): boolean {
  if (error instanceof GoogleApiResponseError) return error.retryable;
  if (error instanceof Error) return error.name !== "AbortError";
  return true;
}
