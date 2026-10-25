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
  InboxRegistration,
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { LedgerEntryMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from './mappers';
import { LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './records';
import { isUuid } from './uuid';

// Repositórios sobre o EntityManager de UMA transação (o `em` vem do UnitOfWork).
// Escritas são comandos explícitos (insert / nativeUpdate) em ordem conhecida:
// o SQL dentro da seção crítica (com a wallet travada) é previsível e curto.

/** Nome da constraint violada (o MikroORM copia os campos do erro do driver). */
const constraintOf = (error: unknown) => (error as { constraint?: string }).constraint;

/** Lock/deadlock são falhas transitórias: seguro tentar de novo. */
export function translateTransient(error: unknown): never {
  if (error instanceof LockWaitTimeoutException) {
    throw new TransientError('Timed out waiting for wallet lock', 'lock_timeout', { cause: error });
  }
  if (error instanceof DeadlockException) {
    throw new TransientError('Deadlock detected', 'deadlock', { cause: error });
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
      throw new TransientError(
        `Wallet ${wallet.id} changed concurrently (expected version ${previousVersion})`,
        'version_conflict',
      );
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

  async findDuePendingReferences(now: Date, limit: number) {
    // Usa o índice parcial wager_tx_pending_reference_idx. Sem lock aqui: quem
    // processa trava a WALLET depois (mesma ordem de locks do fluxo principal).
    const records = await this.em.find(
      WagerTransactionRecord,
      { status: 'PENDING_REFERENCE', nextReferenceAttemptAt: { $lte: now } },
      { orderBy: { nextReferenceAttemptAt: 'asc' }, limit, fields: ['id', 'walletId'] },
    );
    return records.map((r) => ({ id: r.id, walletId: r.walletId }));
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

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async register(message: InboxMessage): Promise<InboxRegistration> {
    // ON CONFLICT DO NOTHING em vez de capturar erro de UNIQUE: no PostgreSQL um
    // erro aborta a transação inteira; assim ela continua utilizável.
    // Se outra transação estiver inserindo a mesma chave AGORA, este INSERT
    // espera ela terminar — por isso duas entregas simultâneas não passam juntas.
    const inserted = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt ?? null],
    );
    if (inserted.length > 0) return { status: 'registered' };

    const [row] = await this.em.execute<
      { payload_hash: string; received_at: Date; processed_at: Date | null }[]
    >(
      `select payload_hash, received_at, processed_at from inbox_messages
        where consumer_name = ? and message_id = ?`,
      [message.consumerName, message.messageId],
    );
    if (!row) throw new Error(`Inbox conflict for ${message.messageId} but row not found`);
    return {
      status: 'duplicate',
      existing: InboxMessage.rehydrate({
        messageId: message.messageId,
        consumerName: message.consumerName,
        payloadHash: row.payload_hash,
        receivedAt: row.received_at,
        processedAt: row.processed_at ?? undefined,
      }),
    };
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxRecord, messages.map(OutboxMapper.toRecord));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    // SELECT ... FOR UPDATE SKIP LOCKED: cada publisher trava o SEU lote e
    // PULA as linhas já travadas por outro — N instâncias publicam em paralelo
    // sem pegar o mesmo evento e sem esperar umas pelas outras.
    const records = await this.em.find(
      OutboxRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return records.map(OutboxMapper.toDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxRecord,
      { id: message.id },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
        publishedAt: message.publishedAt ?? null,
      },
    );
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }
}
