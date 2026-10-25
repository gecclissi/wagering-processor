import { WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import type { Clock, IdGenerator, UnitOfWork } from '../ports';
import { settleTransaction } from './settle-transaction';

export interface RetryPendingResult {
  examined: number;
  processed: number;
  rejected: number;
  stillPending: number;
  /** Transações que saíram de PENDING_REFERENCE nesta rodada. */
  settled: { transactionId: string; walletId: string; kind: string; status: string }[];
  errors: { transactionId: string; error: unknown }[];
}

/**
 * Worker agendado: reprocessa transações PENDING_REFERENCE cuja próxima
 * tentativa venceu (backoff exponencial; esgotado → REJECTED/REFERENCE_NOT_FOUND).
 *
 * Cada transação numa transação SQL própria, travando a WALLET primeiro —
 * a mesma ordem de locks do fluxo principal, então não há deadlock. Duas
 * instâncias que pegarem a mesma pendente se serializam no lock da wallet;
 * a segunda relê, vê que já não está pendente e pula.
 */
export class RetryPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly batchSize = 50,
  ) {}

  async execute(): Promise<RetryPendingResult> {
    const due = await this.uow.run((ctx) => ctx.transactions.findDuePendingReferences(this.clock.now(), this.batchSize));
    const result: RetryPendingResult = {
      examined: due.length,
      processed: 0,
      rejected: 0,
      stillPending: 0,
      settled: [],
      errors: [],
    };

    for (const { id, walletId } of due) {
      // Uma pendente com erro (ex.: lock_timeout) não trava as demais: fica
      // como está e volta no próximo ciclo.
      const outcome = await this.uow.run(async (ctx) => {
        const wallet = await ctx.wallets.findByIdForUpdate(walletId);
        // Relê DEPOIS do lock: outra instância pode ter resolvido nesse meio-tempo.
        const tx = await ctx.transactions.findById(id);
        if (!wallet || !tx || !tx.isDueForReferenceRetry(this.clock.now())) return undefined;

        await settleTransaction(
          ctx,
          tx,
          wallet,
          { ids: this.ids, clock: this.clock },
          { correlationId: tx.id, causationId: tx.id },
          'update',
        );
        return { status: tx.status, kind: tx.kind };
      }).catch((error: unknown) => {
        result.errors.push({ transactionId: id, error });
        return undefined;
      });

      if (!outcome) continue;
      if (outcome.status === WagerTransactionStatus.PendingReference) {
        result.stillPending += 1;
        continue;
      }
      if (outcome.status === WagerTransactionStatus.Processed) result.processed += 1;
      if (outcome.status === WagerTransactionStatus.Rejected) result.rejected += 1;
      result.settled.push({ transactionId: id, walletId, kind: outcome.kind, status: outcome.status });
    }
    return result;
  }
}
