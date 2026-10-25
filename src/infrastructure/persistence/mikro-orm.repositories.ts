import {
  LockMode,
  LockWaitTimeoutException,
  DeadlockException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  DuplicateTransactionError,
  TransientError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import type {
  LedgerRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { LedgerEntryMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from './records';
import { isUuid } from './uuid';

// Repositórios sobre o EntityManager de UMA transação (o `em` vem do UnitOfWork).
// Escritas são comandos explícitos (insert / nativeUpdate) em ordem conhecida:
// o SQL dentro da seção crítica (com a wallet travada) é previsível e curto.

/** Nome da constraint violada (o MikroORM copia os campos do erro do driver). */
const constraintOf = (error: unknown) => (error as { constraint?: string }).constraint;

/** Lock/deadlock são falhas transitórias: seguro tentar de novo. */
export function translateTransient(error: unknown): never {
  if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException) {
    throw new TransientError('Database lock contention', { cause: error });
  }
  throw error;
}

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    if (!isUuid(id)) return undefined;
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // SELECT ... FOR UPDATE: a linha fica travada até o COMMIT/ROLLBACK.
    // Outra instância que pedir a mesma wallet espera; wallets diferentes não.
    if (!isUuid(id)) return undefined;
    const record = await this.em
      .findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
      .catch(translateTransient);
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        constraintOf(error) === 'wallets_player_currency_uq'
      ) {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async update(wallet: Wallet, previousVersion: number): Promise<void> {
    // Defesa em profundidade: além do lock, o UPDATE só vale se a version no
    // banco ainda for a que lemos (compare-and-set). 0 linhas = alguém mudou
    // a wallet sem respeitar o lock → aborta em vez de sobrescrever (lost update).
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: previousVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new TransientError(`Wallet ${wallet.id} changed concurrently (expected version ${previousVersion})`);
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    if (!isUuid(id)) return undefined;
    return this.findOne({ id });
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ idempotencyKey: key });
  }

  async findByExternalId(providerId: string, externalTransactionId: string) {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction));
    } catch (error) {
      const constraint = constraintOf(error);
      if (
        error instanceof UniqueConstraintViolationException &&
        (constraint === 'wager_tx_idempotency_key_uq' || constraint === 'wager_tx_provider_external_uq')
      ) {
        throw new DuplicateTransactionError();
      }
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      WagerTransactionMapper.toMutableFields(transaction),
    );
  }

  private async findOne(where: Partial<WagerTransactionRecord>) {
    // refresh: sempre lê do banco, nunca do identity map — depois de esperar
    // um lock, precisamos ver o que OUTRA transação acabou de commitar.
    const record = await this.em.findOne(WagerTransactionRecord, where, { refresh: true });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }
}
