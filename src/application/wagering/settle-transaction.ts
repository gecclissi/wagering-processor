import type { EventContext } from '../../domain/events/wagering-events';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { applyWagerTransaction } from '../../domain/wager/apply-wager-transaction';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { Clock, IdGenerator, TransactionContext } from '../ports';

/** Rastreabilidade dos eventos: de onde veio a operação. */
export interface EventMeta {
  correlationId: string;
  causationId?: string | undefined;
}

export interface SettleDeps {
  ids: IdGenerator;
  clock: Clock;
}

/**
 * Aplica e PERSISTE uma transação — usado pela entrada nova (HTTP/SQS) e pelo
 * worker de PENDING_REFERENCE. Pré-condição: a wallet já está travada.
 *
 * Tudo no mesmo `ctx` (= mesma transação SQL): transação, saldo, ledger e
 * eventos na outbox. Ou tudo é commitado junto, ou nada.
 */
export async function settleTransaction(
  ctx: TransactionContext,
  tx: WagerTransaction,
  wallet: Wallet,
  deps: SettleDeps,
  meta: EventMeta,
  persist: 'insert' | 'update',
): Promise<void> {
  const wasAlreadyPending = tx.status === WagerTransactionStatus.PendingReference;
  const at = deps.clock.now();

  // Referência (por id do PROVEDOR) e se ela já foi revertida.
  const reference = tx.referenceExternalTransactionId
    ? await ctx.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId)
    : undefined;
  const referenceAlreadyReversed =
    reference !== undefined && tx.isReversal() ? await ctx.transactions.hasProcessedReversal(reference.id) : false;

  // Regras de negócio (puras, em memória).
  const previousVersion = wallet.version;
  const entry = applyWagerTransaction({
    transaction: tx,
    wallet,
    reference,
    referenceAlreadyReversed,
    entryId: deps.ids.next(),
    at,
  });

  // Persistência — na ordem exigida pelas FKs.
  if (persist === 'insert') await ctx.transactions.insert(tx);
  else await ctx.transactions.update(tx);
  if (entry) {
    await ctx.wallets.update(wallet, previousVersion);
    await ctx.ledger.append(entry);
  }

  const eventContext = (): EventContext => ({ eventId: deps.ids.next(), ...meta, occurredAt: at });
  const events = eventsFor(tx, wallet, entry, wasAlreadyPending, eventContext);
  await ctx.outbox.add(events.map((event) => OutboxMessage.enqueue(event)));
}

/** Quais eventos cada desfecho produz. */
export function eventsFor(
  tx: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  wasAlreadyPending: boolean,
  context: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (tx.status) {
    case WagerTransactionStatus.Processed:
      return [
        WagerTransactionProcessed.from(tx, context()),
        // WalletBalanceChanged SOMENTE quando o saldo muda (LOSS não gera).
        ...(entry ? [WalletBalanceChanged.from(wallet, entry, context())] : []),
      ];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(tx, context())];
    case WagerTransactionStatus.PendingReference:
      // Só na primeira vez: novas tentativas do worker não são novidade para ninguém.
      return wasAlreadyPending ? [] : [WagerTransactionPendingReference.from(tx, context())];
    default:
      return [];
  }
}
