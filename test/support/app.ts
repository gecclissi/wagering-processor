import { SQL } from 'bun';
import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case';
import {
  ProcessWagerTransactionUseCase,
  type SubmitWagerTransactionCommand,
} from '../../src/application/wagering/process-wager-transaction.use-case';
import { createMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { TEST_DATABASE_URL, createTestDatabase } from './database';

/** Use cases reais ligados ao PostgreSQL real do banco de teste. */
export async function createTestApp() {
  await createTestDatabase();
  const orm = await MikroORM.init({
    ...createMikroOrmConfig(TEST_DATABASE_URL),
    pool: { min: 2, max: 20 },
  });
  const sql = new SQL(TEST_DATABASE_URL);
  const uow = new MikroOrmUnitOfWork(orm.em);
  const ids = new UuidV7Generator();
  const clock = new SystemClock();

  return {
    orm,
    sql,
    uow,
    ids,
    clock,
    openWallet: new OpenWalletUseCase(uow, ids, clock),
    processWager: new ProcessWagerTransactionUseCase(uow, ids, clock),
    async close() {
      await orm.close();
      await sql.close();
    },
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;

let seq = 0;

/** Comando de transação válido; sobrescreva só o que o teste precisa. */
export function wagerCommand(
  walletId: string,
  playerId: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  seq += 1;
  const providerId = overrides.providerId ?? 'provider-a';
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Date.now()}-${seq}`;
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

export async function walletState(sql: SQL, walletId: string) {
  const [row] = await sql`select balance::text as balance, version from wallets where id = ${walletId}`;
  return row as { balance: string; version: number };
}

export async function ledgerEntries(sql: SQL, walletId: string) {
  return (await sql`
    select direction, amount::text as amount from wallet_ledger_entries
    where wallet_id = ${walletId} order by seq`) as { direction: string; amount: string }[];
}

/**
 * Invariante final de TODOS os testes:  wallet.balance == saldo reconstruído pelo ledger.
 * Calculado no próprio banco com numeric (exato).
 */
export async function expectLedgerConsistent(sql: SQL): Promise<void> {
  const divergent = await sql`
    select w.id, w.balance::text as stored,
           coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated
    from wallets w
    left join wallet_ledger_entries l on l.wallet_id = w.id
    group by w.id, w.balance
    having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`;
  expect(divergent).toEqual([]);
}
