import type { WagerTransactionResult } from '../../application/wagering/process-wager-transaction.use-case';
import type { Metrics, Source } from './metrics';

/**
 * Contabiliza o resultado de uma submissão. Replay conta como DUPLICATA, não
 * como transação de novo — senão o mesmo débito apareceria duas vezes no gráfico.
 */
export function recordWagerOutcome(
  metrics: Metrics,
  result: WagerTransactionResult,
  kind: string,
  source: Source,
  startedAt: number,
): void {
  metrics.processingDuration.observe({ source }, (performance.now() - startedAt) / 1_000);
  if (result.idempotentReplay) metrics.duplicates.inc({ source });
  else metrics.transactions.inc({ status: result.status, kind, source });
}
