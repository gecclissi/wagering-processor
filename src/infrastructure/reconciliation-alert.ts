import { Logger } from '@nestjs/common';
import type {
  ReconciliationAlert,
  ReconciliationReport,
} from '../application/wallets/reconcile-wallet.use-case';

/** Divergência saldo × ledger: log de erro. (Métrica entra na etapa de observabilidade.) */
export class LoggingReconciliationAlert implements ReconciliationAlert {
  private readonly logger = new Logger('Reconciliation');

  divergenceDetected(report: ReconciliationReport): void {
    this.logger.error(
      `Wallet ${report.walletId} diverges from its ledger: ` +
        `stored=${report.storedBalance.amount} calculated=${report.calculatedBalance.amount} ` +
        `difference=${report.difference.amount} ${report.difference.currency}`,
    );
  }
}
