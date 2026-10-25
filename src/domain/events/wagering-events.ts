import type { FailureCode } from '../shared/failure-code';
import type { MoneyProps } from '../shared/money';
import type { WagerTransaction } from '../wager/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { IntegrationEvent } from './integration-event';

/**
 * Contexto de quem emite: ids e rastreabilidade vêm de fora (o domínio não gera ids).
 * aggregateId = walletId em TODOS os eventos: a wallet é a fronteira de
 * consistência, e na fila FIFO vira o MessageGroupId (ordem por wallet).
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string | undefined;
  occurredAt: Date;
}

// `data` carrega MoneyProps (string decimal), nunca a instância de Money.

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): TransactionData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId ? { referenceExternalTransactionId: tx.referenceExternalTransactionId } : {}),
  };
}

const props = <T>(walletId: string, ctx: EventContext, data: T) => ({ ...ctx, aggregateId: walletId, data });

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
}

/** Qualquer transação aplicada — inclusive LOSS, que não mexe no saldo. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      props(tx.walletId, ctx, {
        ...transactionData(tx),
        ...(tx.referenceTransactionId ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balance: tx.resultingBalance!.toJSON(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      props(tx.walletId, ctx, { ...transactionData(tx), failureCode: tx.failureCode! }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      props(tx.walletId, ctx, {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** Consumidor que recebe fora de ordem usa a version para descartar o antigo. */
  walletVersion: number;
}

/** SOMENTE quando o saldo muda (há lançamento de ledger). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      props(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}
