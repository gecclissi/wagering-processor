import type { WagerTransactionResult } from '../../application/wagering/process-wager-transaction.use-case';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

// Formato JSON das respostas. Dinheiro sempre como { amount: "25.00", currency }.

export function presentWagerResult(result: WagerTransactionResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.balance ? { balance: result.balance } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    idempotentReplay: result.idempotentReplay,
  };
}

export function presentTransaction(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultingBalance?.toJSON() ?? null,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString() ?? null,
  };
}

export function presentLedgerEntry(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}
