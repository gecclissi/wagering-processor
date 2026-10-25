import { InvariantViolationError } from '../shared/domain-error';
import { FailureCode } from '../shared/failure-code';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction';

export interface ApplyWagerInput {
  transaction: WagerTransaction;
  /** Wallet já travada (SELECT ... FOR UPDATE) pelo chamador. */
  wallet: Wallet;
  /** Referência buscada por (providerId, referenceExternalTransactionId); undefined se não existe. */
  reference: WagerTransaction | undefined;
  /** A referência já foi revertida por uma operação do mesmo kind? (fato vindo do banco) */
  referenceAlreadyReversed: boolean;
  /** Id para o lançamento de ledger, se houver. */
  entryId: string;
  at: Date;
}

/**
 * Serviço de domínio: aplica as regras de BET / WIN / LOSS / REFUND / ROLLBACK.
 *
 * Função pura sobre objetos em memória — não sabe de banco, lock ou fila.
 * Sai daqui com a transação em PROCESSED, REJECTED ou PENDING_REFERENCE e,
 * se o saldo mudou, com o lançamento de ledger a ser gravado.
 */
export function applyWagerTransaction(input: ApplyWagerInput): WalletLedgerEntry | undefined {
  const { transaction: tx, wallet, reference, at } = input;

  if (tx.isTerminal()) {
    throw new InvariantViolationError(`Transaction ${tx.id} is already ${tx.status}`);
  }
  if (wallet.id !== tx.walletId) {
    throw new InvariantViolationError(`Wallet ${wallet.id} loaded for transaction of ${tx.walletId}`);
  }

  const reject = (code: FailureCode) => {
    tx.reject(code, at, wallet.balance);
    return undefined;
  };

  // 1) A wallet é deste player e desta moeda?
  if (wallet.playerId !== tx.playerId) return reject(FailureCode.WalletMismatch);
  if (wallet.currency !== tx.money.currency) return reject(FailureCode.CurrencyMismatch);

  // 2) Referência (obrigatória para REFUND/ROLLBACK, opcional para WIN/LOSS).
  if (tx.referenceExternalTransactionId !== undefined) {
    if (reference === undefined) {
      // Fora de ordem: espera, até esgotar as tentativas.
      if (tx.hasExhaustedReferenceAttempts()) return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(at);
      return undefined;
    }
    const check = tx.checkReference(reference);
    if (check.kind === 'invalid') return reject(check.code);
    if (check.kind === 'wait') {
      if (tx.hasExhaustedReferenceAttempts()) return reject(FailureCode.ReferenceNotProcessed);
      tx.markPendingReference(at);
      return undefined;
    }
    if (tx.isReversal() && input.referenceAlreadyReversed) return reject(FailureCode.AlreadyReversed);
  }

  // 3) LOSS: registra o resultado sem mexer no saldo e sem ledger.
  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, wallet.balance, at);
    return undefined;
  }

  // 4) Movimenta o saldo. Sem saldo → rejeição, com código diferente para reversões.
  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(
      tx.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalInsufficientFunds,
    );
  }

  const entry = wallet.apply(direction, tx.money, {
    entryId: input.entryId,
    transactionId: tx.id,
    at,
  });
  tx.markProcessed(reference?.id, wallet.balance, at);
  return entry;
}
