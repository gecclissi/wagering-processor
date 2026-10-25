import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TEST_DATABASE_URL, createTestDatabase, runMigrations } from '../support/database';

const APP_TABLES = ['inbox_messages', 'outbox_messages', 'wager_transactions', 'wallet_ledger_entries', 'wallets'];

let sql: SQL;

async function appTables(): Promise<string[]> {
  const rows = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
    order by table_name`;
  return rows.map((r: { table_name: string }) => r.table_name);
}

beforeAll(async () => {
  await createTestDatabase();
  sql = new SQL(TEST_DATABASE_URL);
});
afterAll(async () => {
  await sql?.close();
});

describe('migrations', () => {
  test('up cria todas as tabelas', async () => {
    expect(await appTables()).toEqual(APP_TABLES);
  });

  test('são reversíveis: down remove tudo e up recria', async () => {
    await runMigrations('down');
    expect(await appTables()).toEqual([]);
    const [fn] = await sql`select count(*)::int as n from pg_proc where proname in ('ledger_forbid_mutation', 'wager_tx_guard_update')`;
    expect(fn.n).toBe(0);

    await runMigrations('up');
    expect(await appTables()).toEqual(APP_TABLES);
  });
});
