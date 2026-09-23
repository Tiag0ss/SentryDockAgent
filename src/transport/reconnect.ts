/** Exponential backoff between reconnect attempts (capped). */
export function reconnectDelayMs(attempt: number): number {
  const exp = Math.min(Math.max(attempt, 1) - 1, 5);
  const base = 1000 * 2 ** exp;
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(30_000, base + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
