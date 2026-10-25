import { SQL } from 'bun';
import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

// Testes de integração usam um banco PRÓPRIO, recriado do zero: nunca o de desenvolvimento.
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering';
const TEST_DB = 'wagering_test';
export const TEST_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

/** Recria o banco de teste e aplica as migrations reais. */
export async function createTestDatabase(): Promise<void> {
  const admin = new SQL(ADMIN_URL);
  try {
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
  } finally {
    await admin.close();
  }
  await runMigrations('up');
}

export async function runMigrations(direction: 'up' | 'down'): Promise<void> {
  const orm = await MikroORM.init(createMikroOrmConfig(TEST_DATABASE_URL));
  try {
    await (direction === 'up' ? orm.migrator.up() : orm.migrator.down());
  } finally {
    await orm.close();
  }
}

/** Limpa os dados entre testes. TRUNCATE não dispara os triggers por linha do ledger. */
export async function truncateAll(sql: SQL): Promise<void> {
  await sql.unsafe(
    'truncate wallets, wager_transactions, wallet_ledger_entries, inbox_messages, outbox_messages cascade',
  );
}

export const PgError = {
  UniqueViolation: '23505',
  CheckViolation: '23514',
  ForeignKeyViolation: '23503',
  IntegrityViolation: '23000', // lançado pelos nossos triggers
} as const;

/** Espera que a operação falhe com o SQLSTATE (e, se informado, a constraint) esperados. */
export async function expectPgError(
  operation: Promise<unknown>,
  sqlstate: string,
  constraint?: string,
): Promise<void> {
  let caught: { errno?: string; constraint?: string; message?: string } | undefined;
  try {
    await operation;
  } catch (error) {
    caught = error as typeof caught;
  }
  expect(caught, 'expected the database to reject the operation').toBeDefined();
  expect(caught!.errno).toBe(sqlstate);
  if (constraint !== undefined) expect(caught!.constraint).toBe(constraint);
}
