import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { expectLedgerConsistent } from '../support/app';
import { truncateAll } from '../support/database';
import { startHttpApp, type HttpApp } from '../support/http';

let http: HttpApp;

beforeAll(async () => {
  http = await startHttpApp();
});
afterAll(async () => {
  await http.close();
});
beforeEach(async () => {
  await truncateAll(http.sql);
});
afterEach(async () => {
  await expectLedgerConsistent(http.sql);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(initial = '1000.00') {
  const playerId = crypto.randomUUID();
  const res = await http.post('/wallets', { playerId, initialBalance: brl(initial) });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

let seq = 0;
function wager(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `tx-${Date.now()}-${seq}`;
  const body = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
  return { body, key: `provider-a:${externalTransactionId}` };
}

const submit = (body: unknown, key?: string) =>
  http.post('/wagering/transactions', body, key === undefined ? {} : { 'Idempotency-Key': key });

describe('POST /wallets', () => {
  test('201 com o formato do contrato', async () => {
    const playerId = crypto.randomUUID();
    const res = await http.post('/wallets', { playerId, initialBalance: brl('1000.00') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });
  });

  test('409 WALLET_ALREADY_EXISTS para o mesmo player + moeda', async () => {
    const { playerId } = await createWallet();
    const res = await http.post('/wallets', { playerId, initialBalance: brl('5.00') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    ['amount como number', { amount: 10, currency: 'BRL' }, 'INVALID_PAYLOAD'],
    ['notação científica', { amount: '1e3', currency: 'BRL' }, 'INVALID_AMOUNT'],
    ['negativo', { amount: '-1.00', currency: 'BRL' }, 'INVALID_AMOUNT'],
    ['moeda inválida', { amount: '1.00', currency: 'real' }, 'INVALID_CURRENCY'],
  ])('400 para %s', async (_name, initialBalance, code) => {
    const res = await http.post('/wallets', { playerId: 'p', initialBalance });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('400 INVALID_PAYLOAD para JSON malformado', async () => {
    const res = await http.post('/wallets', '{"playerId": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId', () => {
  test('200 com saldo e version', async () => {
    const { walletId } = await createWallet('50.00');
    const res = await http.get(`/wallets/${walletId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: walletId, balance: brl('50.00'), version: 1 });
  });

  test.each([crypto.randomUUID(), 'not-a-uuid'])('404 WALLET_NOT_FOUND para "%s"', async (id) => {
    const res = await http.get(`/wallets/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('POST /wagering/transactions — status por situação', () => {
  test('200 PROCESSED com o formato do contrato', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const { body, key } = wager(walletId, playerId);
    const res = await submit(body, key);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
  });

  test('replay: mesmo status e mesmo corpo, com idempotentReplay = true', async () => {
    const { walletId, playerId } = await createWallet();
    const { body, key } = wager(walletId, playerId);
    const first = await submit(body, key);
    // Ordem das chaves diferente: o hash usa JSON canônico.
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const replay = await submit(reordered, key);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('409 IDEMPOTENCY_CONFLICT: mesma key com payload diferente', async () => {
    const { walletId, playerId } = await createWallet();
    const { body, key } = wager(walletId, playerId);
    await submit(body, key);
    const res = await submit({ ...body, money: brl('26.00') }, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('422 REJECTED por regra de negócio, com transactionId e failureCode', async () => {
    const { walletId, playerId } = await createWallet('10.00');
    const { body, key } = wager(walletId, playerId, { money: brl('25.00') });
    const res = await submit(body, key);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: brl('10.00'),
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    });
  });

  test('202 PENDING_REFERENCE quando a referência ainda não chegou', async () => {
    const { walletId, playerId } = await createWallet();
    const { body, key } = wager(walletId, playerId, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-not-yet',
    });
    const res = await submit(body, key);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
  });

  test('400 MISSING_IDEMPOTENCY_KEY sem o header', async () => {
    const { walletId, playerId } = await createWallet();
    const res = await submit(wager(walletId, playerId).body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test.each([
    ['OPENING vindo de fora', { kind: 'OPENING' }, 'INVALID_KIND'],
    ['kind desconhecido', { kind: 'JACKPOT' }, 'INVALID_KIND'],
    ['REFUND sem referência', { kind: 'REFUND' }, 'MISSING_REFERENCE'],
    ['3 casas decimais', { money: brl('1.005') }, 'INVALID_AMOUNT'],
    ['campo obrigatório ausente', { roundId: undefined }, 'INVALID_PAYLOAD'],
  ])('400 para %s', async (_name, overrides, code) => {
    const { walletId, playerId } = await createWallet();
    const { body, key } = wager(walletId, playerId, overrides);
    const res = await submit(body, key);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('404 WALLET_NOT_FOUND', async () => {
    const { body, key } = wager(crypto.randomUUID(), 'p1');
    const res = await submit(body, key);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  test('erros têm sempre o mesmo formato { error: { code, message } }', async () => {
    const res = await submit({}, 'k');
    expect(res.body).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
  });
});

describe('GET de transações', () => {
  test('por id interno e por (provider, id externo)', async () => {
    const { walletId, playerId } = await createWallet();
    const { body, key } = wager(walletId, playerId, { externalTransactionId: 'ext-get-1' });
    const created = await submit(body, key);

    const byId = await http.get(`/wagering/transactions/${created.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      id: created.body.transactionId,
      externalTransactionId: 'ext-get-1',
      kind: 'BET',
      money: brl('25.00'),
      status: 'PROCESSED',
      balance: brl('975.00'),
    });

    const byExternal = await http.get('/providers/provider-a/wagering/transactions/ext-get-1');
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
  });

  test('404 TRANSACTION_NOT_FOUND', async () => {
    expect((await http.get(`/wagering/transactions/${crypto.randomUUID()}`)).body.error.code).toBe(
      'TRANSACTION_NOT_FOUND',
    );
    expect((await http.get('/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
  });
});

describe('GET /wallets/:walletId/ledger — cursor', () => {
  test('pagina tudo, em ordem, sem repetir nem pular', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    for (let i = 0; i < 5; i++) {
      const { body, key } = wager(walletId, playerId, { money: brl('1.00') });
      await submit(body, key);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await http.get(`/wallets/${walletId}/ledger?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.entries.map((e: { id: string }) => e.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3); // 6 lançamentos (abertura + 5) em páginas de 2
    expect(new Set(seen).size).toBe(6);

    const all = await http.get(`/wallets/${walletId}/ledger`);
    expect(all.body.entries.map((e: { id: string }) => e.id)).toEqual(seen);
    expect(all.body.entries[0]).toMatchObject({ direction: 'CREDIT', balanceAfter: brl('100.00') });
    expect(all.body.entries.at(-1)).toMatchObject({ direction: 'DEBIT', balanceAfter: brl('95.00') });
  });

  test('400 para cursor adulterado ou limit fora da faixa', async () => {
    const { walletId } = await createWallet();
    expect((await http.get(`/wallets/${walletId}/ledger?cursor=bogus`)).body.error.code).toBe('INVALID_CURSOR');
    expect((await http.get(`/wallets/${walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await http.get(`/wallets/${walletId}/ledger?limit=500`)).status).toBe(400);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente', async () => {
    const { walletId, playerId } = await createWallet('1000.00');
    const { body, key } = wager(walletId, playerId);
    await submit(body, key);

    const res = await http.post(`/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId,
      storedBalance: brl('975.00'),
      calculatedBalance: brl('975.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada, NÃO corrigida', async () => {
    const { walletId } = await createWallet('100.00');
    // Simula corrupção: alguém mexeu no saldo sem lançamento.
    await http.sql`update wallets set balance = 150 where id = ${walletId}`;

    const res = await http.post(`/wallets/${walletId}/reconciliation`);
    expect(res.body).toMatchObject({
      storedBalance: brl('150.00'),
      calculatedBalance: brl('100.00'),
      difference: brl('50.00'),
      consistent: false,
    });
    // Continua divergente: nada foi "consertado" em silêncio.
    const [row] = await http.sql`select balance::text as balance from wallets where id = ${walletId}`;
    expect(row.balance).toBe('150.00');

    // Desfaz para a checagem de invariante do afterEach.
    await http.sql`update wallets set balance = 100 where id = ${walletId}`;
  });
});

describe('Health', () => {
  test('/health/live sem autenticação', async () => {
    expect((await http.get('/health/live')).status).toBe(200);
  });
});
