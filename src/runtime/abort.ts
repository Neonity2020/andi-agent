export class OperationCancelledError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError(signal);
}

export function cancellationError(signal?: AbortSignal): OperationCancelledError {
  const reason = signal?.reason;
  const message = reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Operation cancelled";
  return new OperationCancelledError(message);
}

export function isCancellationError(error: unknown): boolean {
  return (
    error instanceof OperationCancelledError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}
