import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/application/errors';
import { WagerTransactionStatus as Status } from '../../src/domain/wager/wager-transaction';
import { truncateAll } from '../support/database';
import {
  createTestApp,
  expectLedgerConsistent,
  ledgerEntries,
  wagerCommand,
  walletState,
  type TestApp,
} from '../support/app';

// Paralelismo REAL: Promise.all dispara as chamadas ao mesmo tempo, cada uma
// numa conexão própria do pool, disputando o mesmo PostgreSQL. Nada é mockado.

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll(app.sql);
});
afterEach(async () => {
  await expectLedgerConsistent(app.sql);
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(initial: string) {
  const playerId = crypto.randomUUID();
  const wallet = await app.openWallet.execute({ playerId, initialBalance: brl(initial) });
  return { walletId: wallet.id, playerId };
}

describe('Concorrência na mesma wallet', () => {
  test('cenário obrigatório: 100.00 e duas BETs de 80.00 simultâneas', async () => {
    const { walletId, playerId } = await newWallet('100.00');

    const results = await Promise.all([
      app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('80.00') })),
      app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('80.00') })),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([Status.Processed, Status.Rejected]);
    expect(results.find((r) => r.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletState(app.sql, walletId)).toEqual({ balance: '20.00', version: 2 });

    const debits = (await ledgerEntries(app.sql, walletId)).filter((e) => e.direction === 'DEBIT');
    expect(debits).toEqual([{ direction: 'DEBIT', amount: '80.00' }]);
  });

  test('a MESMA BET enviada 50 vezes em paralelo gera um único débito', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const command = wagerCommand(walletId, playerId, { money: brl('10.00') });

    const results = await Promise.all(Array.from({ length: 50 }, () => app.processWager.execute(command)));

    // Todas as respostas apontam para a mesma transação, com o mesmo resultado.
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === 'PROCESSED' && r.balance?.amount === '90.00')).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);

    expect(await walletState(app.sql, walletId)).toEqual({ balance: '90.00', version: 2 });
    const [{ n }] = await app.sql`select count(*)::int as n from wager_transactions where kind = 'BET'`;
    expect(n).toBe(1);
  });

  test('hot wallet: 30 BETs distintas de 10.00 sobre 100.00 → exatamente 10 passam', async () => {
    const { walletId, playerId } = await newWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('10.00') })),
      ),
    );

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((r) => r.status === 'REJECTED')).toHaveLength(20);
    expect(await walletState(app.sql, walletId)).toEqual({ balance: '0.00', version: 11 });
    expect(await ledgerEntries(app.sql, walletId)).toHaveLength(11); // abertura + 10 débitos
  });

  test('créditos e débitos misturados em paralelo não perdem atualização', async () => {
    const { walletId, playerId } = await newWallet('1000.00');
    const ops = [
      ...Array.from({ length: 20 }, () => wagerCommand(walletId, playerId, { kind: 'BET', money: brl('7.35') })),
      ...Array.from({ length: 20 }, () => wagerCommand(walletId, playerId, { kind: 'WIN', money: brl('2.10') })),
    ];

    const results = await Promise.all(ops.map((c) => app.processWager.execute(c)));

    expect(results.every((r) => r.status === 'PROCESSED')).toBe(true);
    // 1000 − 20 × 7.35 + 20 × 2.10 = 1000 − 147 + 42 = 895.00
    expect(await walletState(app.sql, walletId)).toEqual({ balance: '895.00', version: 41 });
  });

  test('REFUND e ROLLBACK simultâneos da mesma BET: só um reverte', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    await app.processWager.execute(
      wagerCommand(walletId, playerId, { externalTransactionId: 'bet-race', money: brl('40.00') }),
    );

    const results = await Promise.all(
      (['REFUND', 'ROLLBACK', 'REFUND', 'ROLLBACK'] as const).map((kind) =>
        app.processWager.execute(
          wagerCommand(walletId, playerId, { kind, referenceExternalTransactionId: 'bet-race', money: brl('40.00') }),
        ),
      ),
    );

    expect(results.filter((r) => r.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((r) => r.failureCode === 'ALREADY_REVERSED')).toHaveLength(3);
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
  });

  test('mesma key com payloads diferentes em paralelo: um vence, os outros são conflito', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const base = wagerCommand(walletId, playerId);

    const settled = await Promise.allSettled(
      ['1.00', '2.00', '3.00', '4.00', '5.00'].map((amount) =>
        app.processWager.execute({ ...base, money: brl(amount) }),
      ),
    );

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(rejected).toHaveLength(4);
    expect(rejected.every((s) => s.reason instanceof IdempotencyConflictError)).toBe(true);
    expect(await ledgerEntries(app.sql, walletId)).toHaveLength(2); // abertura + 1 débito
  });
});

describe('Concorrência entre wallets', () => {
  test('wallets distintas processadas em paralelo, cada uma com o saldo certo', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('50.00')));

    await Promise.all(
      wallets.flatMap(({ walletId, playerId }) =>
        Array.from({ length: 5 }, () =>
          app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('3.00') })),
        ),
      ),
    );

    for (const { walletId } of wallets) {
      expect(await walletState(app.sql, walletId)).toEqual({ balance: '35.00', version: 6 });
    }
  });

  test('o lock é por wallet: uma wallet travada não bloqueia as outras', async () => {
    const hot = await newWallet('100.00');
    const cold = await newWallet('100.00');

    // Segura o lock da wallet "hot" numa transação aberta, por fora da aplicação.
    const holder = await app.sql.reserve();
    await holder`begin`;
    await holder`select id from wallets where id = ${hot.walletId} for update`;
    try {
      const started = performance.now();
      const result = await app.processWager.execute(wagerCommand(cold.walletId, cold.playerId));
      const elapsed = performance.now() - started;

      expect(result.status).toBe(Status.Processed);
      expect(elapsed).toBeLessThan(1_000); // não esperou o lock da outra wallet
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });
});
