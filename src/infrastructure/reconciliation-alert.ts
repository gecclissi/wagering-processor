import { Logger } from '@nestjs/common';
import type {
  ReconciliationAlert,
  ReconciliationReport,
} from '../application/wallets/reconcile-wallet.use-case';
import { runWithLogContext } from './observability/log-context';
import type { Metrics } from './observability/metrics';

/** Divergência saldo × ledger: log de erro + métrica (para alertar). Nunca corrige. */
export class ObservableReconciliationAlert implements ReconciliationAlert {
  private readonly logger = new Logger('Reconciliation');

  constructor(private readonly metrics: Metrics) {}

  divergenceDetected(report: ReconciliationReport): void {
    this.metrics.reconciliationDivergences.inc();
    runWithLogContext({ walletId: report.walletId }, () =>
      this.logger.error({
        msg: 'wallet balance diverges from its ledger',
        difference: `${report.difference.amount} ${report.difference.currency}`,
        checkedEntries: report.checkedEntries,
      }),
    );
  }
}
