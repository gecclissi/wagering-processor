import { SQL } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  PgError,
  TEST_DATABASE_URL,
  createTestDatabase,
  expectPgError,
  truncateAll,
} from '../support/database';

// Estes testes falam SQL direto com o banco, sem passar pelo domínio:
// provam que as garantias valem mesmo se o código da aplicação tiver um bug.

let sql: SQL;

beforeAll(async () => {
  await createTestDatabase();
  sql = new SQL(TEST_DATABASE_URL);
});
afterAll(async () => {
  await sql?.close();
});
beforeEach(async () => {
  await truncateAll(sql);
});

const uuid = () => crypto.randomUUID();
const now = () => new Date();

async function insertWallet(overrides: Record<string, unknown> = {}) {
  const row = {
    id: uuid(),
    player_id: `player-${uuid()}`,
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: now(),
    updated_at: now(),
    ...overrides,
  };
  await sql`insert into wallets ${sql(row)}`;
  return row;
}

async function insertTx(walletId: string, overrides: Record<string, unknown> = {}) {
  const external = `ext-${uuid()}`;
  const row = {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: external,
    idempotency_key: `provider-a:${external}`,
    payload_hash: 'hash',
    wallet_id: walletId,
    player_id: 'player-1',
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: now(),
    ...overrides,
  };
  await sql`insert into wager_transactions ${sql(row)}`;
  return row;
}

const processed = (extra: Record<string, unknown> = {}) => ({
  status: 'PROCESSED',
  processed_at: now(),
  resulting_balance: '90.00',
  ...extra,
});

async function insertLedger(walletId: string, transactionId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: uuid(),
    wallet_id: walletId,
    transaction_id: transactionId,
    direction: 'DEBIT',
    amount: '10.00',
    currency: 'BRL',
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: now(),
    ...overrides,
  };
  await sql`insert into wallet_ledger_entries ${sql(row)}`;
  return row;
}

describe('wallets', () => {
  test('uma wallet por player + moeda', async () => {
    await insertWallet({ player_id: 'p1', currency: 'BRL' });
    await insertWallet({ player_id: 'p1', currency: 'USD' }); // outra moeda: ok
    await expectPgError(
      insertWallet({ player_id: 'p1', currency: 'BRL' }),
      PgError.UniqueViolation,
      'wallets_player_currency_uq',
    );
  });

  test('saldo nunca negativo', async () => {
    await expectPgError(insertWallet({ balance: '-0.01' }), PgError.CheckViolation, 'wallets_balance_check');
    const wallet = await insertWallet({ balance: '10.00' });
    await expectPgError(
      sql`update wallets set balance = balance - 10.01 where id = ${wallet.id}`,
      PgError.CheckViolation,
      'wallets_balance_check',
    );
  });

  test('moeda precisa ser ISO-4217 (3 letras maiúsculas)', async () => {
    await expectPgError(insertWallet({ currency: 'brl' }), PgError.CheckViolation, 'wallets_currency_check');
  });

  test('numeric é exato: 0.10 + 0.20 = 0.30', async () => {
    const wallet = await insertWallet({ balance: '0.10' });
    await sql`update wallets set balance = balance + 0.20 where id = ${wallet.id}`;
    const [row] = await sql`select balance::text as balance from wallets where id = ${wallet.id}`;
    expect(row.balance).toBe('0.30');
  });
});

describe('wager_transactions — unicidade e idempotência', () => {
  test('idempotency_key é única', async () => {
    const wallet = await insertWallet();
    await insertTx(wallet.id, { idempotency_key: 'k-1' });
    await expectPgError(
      insertTx(wallet.id, { idempotency_key: 'k-1' }),
      PgError.UniqueViolation,
      'wager_tx_idempotency_key_uq',
    );
  });

  test('provider + external_transaction_id é único', async () => {
    const wallet = await insertWallet();
    await insertTx(wallet.id, { external_transaction_id: 'tx-1', idempotency_key: 'a' });
    await expectPgError(
      insertTx(wallet.id, { external_transaction_id: 'tx-1', idempotency_key: 'b' }),
      PgError.UniqueViolation,
      'wager_tx_provider_external_uq',
    );
    // Mesmo id externo em OUTRO provider é permitido.
    await insertTx(wallet.id, { provider_id: 'provider-b', external_transaction_id: 'tx-1', idempotency_key: 'c' });
  });

  test('no máximo uma OPENING por wallet', async () => {
    const wallet = await insertWallet();
    await insertTx(wallet.id, { kind: 'OPENING', ...processed() });
    await expectPgError(
      insertTx(wallet.id, { kind: 'OPENING', ...processed() }),
      PgError.UniqueViolation,
      'wager_tx_single_opening_uq',
    );
  });

  test('wallet precisa existir', async () => {
    await expectPgError(insertTx(uuid()), PgError.ForeignKeyViolation);
  });
});

describe('wager_transactions — regras por kind e estado', () => {
  test('só LOSS pode ter valor zero', async () => {
    const wallet = await insertWallet();
    await insertTx(wallet.id, { kind: 'LOSS', amount: '0.00' });
    await expectPgError(
      insertTx(wallet.id, { kind: 'BET', amount: '0.00' }),
      PgError.CheckViolation,
      'wager_tx_amount_positive_ck',
    );
  });

  test('REFUND e ROLLBACK exigem referência', async () => {
    const wallet = await insertWallet();
    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expectPgError(insertTx(wallet.id, { kind }), PgError.CheckViolation, 'wager_tx_reference_required_ck');
    }
  });

  test('BET não aceita referência', async () => {
    const wallet = await insertWallet();
    await expectPgError(
      insertTx(wallet.id, { kind: 'BET', reference_external_transaction_id: 'x' }),
      PgError.CheckViolation,
      'wager_tx_reference_forbidden_ck',
    );
  });

  test('estado terminal exige processed_at', async () => {
    const wallet = await insertWallet();
    await expectPgError(
      insertTx(wallet.id, { status: 'PROCESSED' }),
      PgError.CheckViolation,
      'wager_tx_terminal_processed_at_ck',
    );
  });

  test('REJECTED exige failure_code', async () => {
    const wallet = await insertWallet();
    await expectPgError(
      insertTx(wallet.id, { status: 'REJECTED', processed_at: now() }),
      PgError.CheckViolation,
      'wager_tx_failure_code_ck',
    );
  });

  test('PENDING_REFERENCE exige próxima tentativa agendada', async () => {
    const wallet = await insertWallet();
    await expectPgError(
      insertTx(wallet.id, { kind: 'REFUND', reference_external_transaction_id: 'x', status: 'PENDING_REFERENCE' }),
      PgError.CheckViolation,
      'wager_tx_pending_reference_ck',
    );
  });
});

describe('wager_transactions — imutabilidade (trigger)', () => {
  test('PENDING → PROCESSED é permitido', async () => {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id);
    await sql`update wager_transactions
              set status = 'PROCESSED', processed_at = now(), resulting_balance = 90
              where id = ${tx.id}`;
  });

  test('transação terminal não muda mais', async () => {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id, processed());
    await expectPgError(
      sql`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = ${tx.id}`,
      PgError.IntegrityViolation,
    );
  });

  test('campos de negócio nunca mudam, nem em PENDING', async () => {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id);
    await expectPgError(
      sql`update wager_transactions set amount = 999 where id = ${tx.id}`,
      PgError.IntegrityViolation,
    );
  });
});

describe('wager_transactions — reversão única (DESIGN.md §8.1)', () => {
  async function processedBet() {
    const wallet = await insertWallet();
    const bet = await insertTx(wallet.id, processed());
    const reversal = (kind: string, extra: Record<string, unknown> = {}) =>
      insertTx(wallet.id, {
        kind,
        reference_external_transaction_id: bet.external_transaction_id,
        reference_transaction_id: bet.id,
        ...processed({ resulting_balance: '100.00' }),
        ...extra,
      });
    return { wallet, bet, reversal };
  }

  test('REFUND + REFUND da mesma BET: o segundo é barrado', async () => {
    const { reversal } = await processedBet();
    await reversal('REFUND');
    await expectPgError(reversal('REFUND'), PgError.UniqueViolation, 'wager_tx_single_reversal_uq');
  });

  test('REFUND + ROLLBACK da mesma BET: o segundo é barrado (crédito duplicado)', async () => {
    const { reversal } = await processedBet();
    await reversal('REFUND');
    await expectPgError(reversal('ROLLBACK'), PgError.UniqueViolation, 'wager_tx_single_reversal_uq');
  });

  test('reversão REJECTED não bloqueia a reversão válida', async () => {
    const { reversal } = await processedBet();
    await reversal('REFUND', { status: 'REJECTED', failure_code: 'AMOUNT_MISMATCH', resulting_balance: null });
    await reversal('REFUND');
  });

  test('ROLLBACK de um REFUND é permitido (reverte o refund, não a BET)', async () => {
    const { wallet, reversal } = await processedBet();
    const refund = await reversal('REFUND');
    await insertTx(wallet.id, {
      kind: 'ROLLBACK',
      reference_external_transaction_id: refund.external_transaction_id,
      reference_transaction_id: refund.id,
      ...processed(),
    });
  });

  test('WIN referenciando a BET não conta como reversão', async () => {
    const { wallet, bet, reversal } = await processedBet();
    await insertTx(wallet.id, {
      kind: 'WIN',
      reference_external_transaction_id: bet.external_transaction_id,
      reference_transaction_id: bet.id,
      ...processed(),
    });
    await reversal('REFUND');
  });
});

describe('wallet_ledger_entries', () => {
  async function walletWithTx() {
    const wallet = await insertWallet();
    const tx = await insertTx(wallet.id, processed());
    return { wallet, tx };
  }

  test('lançamento válido é aceito e ganha seq crescente', async () => {
    const { wallet, tx } = await walletWithTx();
    const tx2 = await insertTx(wallet.id, processed({ resulting_balance: '80.00' }));
    await insertLedger(wallet.id, tx.id);
    await insertLedger(wallet.id, tx2.id, { balance_before: '90.00', balance_after: '80.00' });
    const rows = await sql`select seq from wallet_ledger_entries order by seq`;
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
  });

  test('aritmética desbalanceada é rejeitada', async () => {
    const { wallet, tx } = await walletWithTx();
    await expectPgError(
      insertLedger(wallet.id, tx.id, { balance_after: '91.00' }),
      PgError.CheckViolation,
      'ledger_balanced_ck',
    );
    await expectPgError(
      insertLedger(wallet.id, tx.id, { direction: 'CREDIT' }), // CREDIT que diminui saldo
      PgError.CheckViolation,
      'ledger_balanced_ck',
    );
  });

  test('saldo resultante negativo é rejeitado', async () => {
    const { wallet, tx } = await walletWithTx();
    await expectPgError(
      insertLedger(wallet.id, tx.id, { balance_before: '5.00', balance_after: '-5.00' }),
      PgError.CheckViolation,
      'wallet_ledger_entries_balance_after_check',
    );
  });

  test('no máximo um lançamento por transação', async () => {
    const { wallet, tx } = await walletWithTx();
    await insertLedger(wallet.id, tx.id);
    await expectPgError(
      insertLedger(wallet.id, tx.id, { balance_before: '90.00', balance_after: '80.00' }),
      PgError.UniqueViolation,
      'ledger_transaction_uq',
    );
  });

  test('moeda do lançamento precisa ser a da wallet', async () => {
    const { wallet, tx } = await walletWithTx();
    await expectPgError(
      insertLedger(wallet.id, tx.id, { currency: 'USD' }),
      PgError.ForeignKeyViolation,
      'ledger_wallet_currency_fk',
    );
  });

  test('wallet do lançamento precisa ser a da transação', async () => {
    const { tx } = await walletWithTx();
    const other = await insertWallet();
    await expectPgError(
      insertLedger(other.id, tx.id),
      PgError.ForeignKeyViolation,
      'ledger_transaction_wallet_fk',
    );
  });

  test('append-only: UPDATE é proibido', async () => {
    const { wallet, tx } = await walletWithTx();
    const entry = await insertLedger(wallet.id, tx.id);
    await expectPgError(
      sql`update wallet_ledger_entries set created_at = now() where id = ${entry.id}`,
      PgError.IntegrityViolation,
    );
  });

  test('append-only: DELETE é proibido', async () => {
    const { wallet, tx } = await walletWithTx();
    const entry = await insertLedger(wallet.id, tx.id);
    await expectPgError(
      sql`delete from wallet_ledger_entries where id = ${entry.id}`,
      PgError.IntegrityViolation,
    );
    const [row] = await sql`select count(*)::int as n from wallet_ledger_entries`;
    expect(row.n).toBe(1);
  });
});

describe('inbox_messages', () => {
  const insertInbox = (consumer: string, messageId: string) =>
    sql`insert into inbox_messages ${sql({
      consumer_name: consumer,
      message_id: messageId,
      payload_hash: 'h',
      received_at: now(),
    })}`;

  test('mesma mensagem para o mesmo consumer é barrada', async () => {
    await insertInbox('wager-consumer', 'msg-1');
    await expectPgError(insertInbox('wager-consumer', 'msg-1'), PgError.UniqueViolation, 'inbox_messages_pk');
  });

  test('mesma mensagem para outro consumer é permitida', async () => {
    await insertInbox('wager-consumer', 'msg-1');
    await insertInbox('audit-consumer', 'msg-1');
  });
});
