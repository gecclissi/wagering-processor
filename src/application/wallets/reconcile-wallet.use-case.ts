import type { MoneyProps } from '../../domain/shared/money';
import { WalletNotFoundError } from '../errors';
import type { WalletReadRepository } from '../ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Quem é avisado quando saldo e ledger divergem (log + métrica). */
export interface ReconciliationAlert {
  divergenceDetected(report: ReconciliationReport): void;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger.
 * Divergência NUNCA é corrigida aqui: é sinalizada (resposta + alerta) para
 * investigação humana — corrigir em silêncio esconderia o bug que a causou.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly reads: WalletReadRepository,
    private readonly alert: ReconciliationAlert,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.reads.reconcile(walletId);
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const { storedBalance, calculatedBalance } = snapshot;
    const difference = storedBalance.subtract(calculatedBalance);
    const report: ReconciliationReport = {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent: difference.isZero(),
      checkedEntries: snapshot.checkedEntries,
    };

    if (!report.consistent) this.alert.divergenceDetected(report);
    return report;
  }
}
