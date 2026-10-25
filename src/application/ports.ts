import type { Money } from '../domain/shared/money';
import type { WagerTransaction } from '../domain/wager/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

// Portas: o que a aplicação precisa do mundo de fora, sem saber COMO é feito.
// As implementações (MikroORM/PostgreSQL) ficam em infrastructure/.

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: trava a linha da wallet até o fim da transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  /** Lança WalletAlreadyExistsError se já houver wallet para player + moeda. */
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo/version novos SE a version no banco ainda for `previousVersion`. */
  update(wallet: Wallet, previousVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Lança DuplicateTransactionError se bater nas UNIQUE de idempotência. */
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
}

/** Repositórios que compartilham UMA transação SQL. */
export interface TransactionContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
}

/** Executa `work` dentro de uma transação: commit se terminar, rollback se lançar. */
export interface UnitOfWork {
  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}

// ---- Lado de leitura (consultas da API). Não trava nada.

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** Posição (seq) do último lançamento da página; ausente se não há mais. */
  nextSeq: string | undefined;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  checkedEntries: number;
}

export interface WalletReadRepository {
  findWallet(id: string): Promise<Wallet | undefined>;
  /** Lançamentos em ordem cronológica (seq crescente), a partir de `afterSeq` (exclusivo). */
  listLedger(walletId: string, afterSeq: string | undefined, limit: number): Promise<LedgerPage>;
  findTransaction(id: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Saldo gravado e saldo recalculado do ledger, lidos do MESMO snapshot. */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
