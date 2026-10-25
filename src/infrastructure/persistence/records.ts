import { defineEntity, p, type InferEntity } from '@mikro-orm/core';

// "Records": o formato das LINHAS do banco, conhecido só pela infraestrutura.
// O domínio (Wallet, Money, ...) não depende do ORM; os repositórios convertem.
// O schema em si é das migrations — estes mapeamentos servem para consultar.
// Colunas monetárias são `numeric` lidas como STRING: nunca passam por number.

const money = () => p.decimal('string').precision(20).scale(2);
const timestamp = () => p.datetime().columnType('timestamptz');

export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.string().columnType('char(3)'),
    balance: money(),
    version: p.integer(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  },
});
export type WalletRecord = InferEntity<typeof WalletRecord>;

export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text(),
    walletId: p.uuid(),
    playerId: p.text(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: money(),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    resultingBalance: money().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceAttemptAt: timestamp().nullable(),
    createdAt: timestamp(),
    processedAt: timestamp().nullable(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionRecord>;

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    // Gerada pelo banco (identity). Base do cursor de paginação.
    seq: p.bigint('string').persist(false),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: money(),
    currency: p.string().columnType('char(3)'),
    balanceBefore: money(),
    balanceAfter: money(),
    createdAt: timestamp(),
  },
});
export type LedgerEntryRecord = InferEntity<typeof LedgerEntryRecord>;

export const OutboxRecord = defineEntity({
  name: 'OutboxRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>().columnType('jsonb'),
    occurredAt: timestamp(),
    attempts: p.integer(),
    nextAttemptAt: timestamp(),
    publishedAt: timestamp().nullable(),
  },
});
export type OutboxRecord = InferEntity<typeof OutboxRecord>;

export const persistenceEntities = [WalletRecord, WagerTransactionRecord, LedgerEntryRecord, OutboxRecord];
