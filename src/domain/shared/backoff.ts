export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
}

/**
 * Backoff exponencial: base, 2×base, 4×base, ... limitado a maxMs.
 * `attempt` começa em 1. Determinístico (sem jitter) para ser testável;
 * jitter, se necessário, entra na infraestrutura.
 */
export function exponentialBackoffMs(attempt: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
}
