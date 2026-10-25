import type { FailureCode } from '../../domain/shared/failure-code';
import { Money } from '../../domain/shared/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry, type LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import type { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';

// Conversão linha ⇄ domínio. Leitura usa sempre `rehydrate` (não revalida transições).

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const nullable = <T>(value: T | null | undefined): T | undefined => value ?? undefined;

export const WalletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet) {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: nullable(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: nullable(r.referenceTransactionId),
      failureCode: nullable(r.failureCode) as FailureCode | undefined,
      processedAt: nullable(r.processedAt),
      resultingBalance: r.resultingBalance == null ? undefined : money(r.resultingBalance, r.currency),
      referenceAttempts: r.referenceAttempts,
      nextReferenceAttemptAt: nullable(r.nextReferenceAttemptAt),
    });
  },
  /** Campos que mudam ao longo da vida da transação (os de negócio são imutáveis). */
  toMutableFields(t: WagerTransaction) {
    return {
      status: t.status,
      referenceTransactionId: t.referenceTransactionId ?? null,
      failureCode: t.failureCode ?? null,
      resultingBalance: t.resultingBalance?.amount ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
      processedAt: t.processedAt ?? null,
    };
  },
  toRecord(t: WagerTransaction) {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      createdAt: t.createdAt,
      ...WagerTransactionMapper.toMutableFields(t),
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry) {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      createdAt: e.createdAt,
    };
  },
};
