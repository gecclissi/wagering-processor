import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, expectLedgerConsistent, walletState, type TestApp } from '../support/app';
import { TEST_DATABASE_URL, truncateAll } from '../support/database';
import { startInstances, stopAll, waitFor, type Instance, type InstanceEnv } from '../support/instances';
import { createFifoQueue, createTestQueues, drain, peek, sendMessage, wagerEnvelope, type TestQueues } from '../support/sqs';

// ≥ 3 PROCESSOS reais da aplicação contra o mesmo PostgreSQL e o mesmo SQS.
// Se a correção dependesse de algo em memória (lock, cache, fila interna),
// estes testes quebrariam: cada processo tem a sua própria memória.

const LONG = 180_000;

let app: TestApp; // acesso direto ao banco de teste, para preparar e conferir
let instances: Instance[] = [];
let queues: TestQueues;
let events: Awaited<ReturnType<typeof createFifoQueue>>;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll(app.sql);
  // Visibility curta: mensagem de uma instância morta volta logo para as outras.
  queues = await createTestQueues(10, 5);
  events = await createFifoQueue('test-events');
});
afterEach(async () => {
  await stopAll(instances);
  instances = [];
  await expectLedgerConsistent(app.sql);
  await queues.destroy();
  await events.destroy();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function env(overrides: Partial<InstanceEnv> = {}): InstanceEnv {
  return {
    databaseUrl: TEST_DATABASE_URL,
    wagerQueue: queues.queueName,
    wagerDlq: queues.dlqName,
    eventsQueue: events.name,
    consumerEnabled: false,
    workersEnabled: true,
    ...overrides,
  };
}

async function newWallet(initial: string) {
  const playerId = crypto.randomUUID();
  const wallet = await app.openWallet.execute({ playerId, initialBalance: brl(initial) });
  return { walletId: wallet.id, playerId };
}

let seq = 0;
function bet(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `mi-${Date.now()}-${seq}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('10.00'),
      ...overrides,
    },
  };
}

async function submit(instance: Instance, op: { key: string; body: unknown }) {
  const res = await fetch(`${instance.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': op.key },
    body: JSON.stringify(op.body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/**
 * Cliente "bem-comportado": se a instância cai (conexão recusada/resetada) ou
 * responde 503, reenvia a MESMA requisição, com a MESMA Idempotency-Key, para
 * a próxima instância. É exatamente o que o contrato da API orienta.
 */
async function submitWithFailover(all: Instance[], op: { key: string; body: unknown }, start: number) {
  for (let attempt = 0; attempt < all.length * 3; attempt++) {
    const instance = all[(start + attempt) % all.length]!;
    try {
      const res = await submit(instance, op);
      if (res.status !== 503) return { ...res, attempts: attempt + 1 };
    } catch {
      // instância morta: tenta a próxima
    }
    await Bun.sleep(50);
  }
  throw new Error(`No instance answered ${op.key}`);
}

const count = async (sqlFragment: string) =>
  (await app.sql.unsafe(`select count(*)::int as n from ${sqlFragment}`))[0].n as number;

describe('3 instâncias via HTTP', () => {
  test(
    'hot wallet: 90 BETs de 10.00 sobre 300.00, espalhadas em 3 processos → exatamente 30 passam',
    async () => {
      instances = await startInstances(3, env());
      const { walletId, playerId } = await newWallet('300.00');

      const results = await Promise.all(
        Array.from({ length: 90 }, (_, i) => submit(instances[i % 3]!, bet(walletId, playerId))),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(30);
      expect(results.filter((r) => r.status === 422)).toHaveLength(60);
      expect(results.filter((r) => r.status === 422).every((r) => r.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
      expect(await walletState(app.sql, walletId)).toEqual({ balance: '0.00', version: 31 });
    },
    LONG,
  );

  test(
    'a MESMA BET 30× em 3 processos → um único débito',
    async () => {
      instances = await startInstances(3, env());
      const { walletId, playerId } = await newWallet('100.00');
      const op = bet(walletId, playerId);

      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(instances[i % 3]!, op)));

      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
      expect(results.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
      expect(await walletState(app.sql, walletId)).toEqual({ balance: '90.00', version: 2 });
    },
    LONG,
  );

  test(
    'cenário 100.00 → 80 + 80 com cada aposta numa instância diferente',
    async () => {
      instances = await startInstances(3, env());
      const { walletId, playerId } = await newWallet('100.00');

      const results = await Promise.all([
        submit(instances[0]!, bet(walletId, playerId, { money: brl('80.00') })),
        submit(instances[1]!, bet(walletId, playerId, { money: brl('80.00') })),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect((await walletState(app.sql, walletId)).balance).toBe('20.00');
      expect(await count(`wallet_ledger_entries where wallet_id = '${walletId}' and direction = 'DEBIT'`)).toBe(1);
    },
    LONG,
  );
});

describe('3 consumidores SQS, um morto no meio', () => {
  test(
    '200 operações (cada uma entregue 2×), SIGKILL numa instância: todas aplicadas exatamente uma vez',
    async () => {
      const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('1000.00')));

      // 10 wallets × 20 BETs de 1.00, cada mensagem enviada DUAS vezes (dedup ids distintos).
      const sends: Promise<void>[] = [];
      for (const { walletId, playerId } of wallets) {
        for (let i = 0; i < 20; i++) {
          const op = bet(walletId, playerId, { money: brl('1.00') });
          const envelope = wagerEnvelope({ ...op.body, idempotencyKey: op.key });
          sends.push(sendMessage(queues.queueUrl, envelope, walletId), sendMessage(queues.queueUrl, envelope, walletId));
        }
      }
      await Promise.all(sends);

      instances = await startInstances(3, env({ consumerEnabled: true }));

      // Deixa o trabalho começar e mata uma instância no meio, sem aviso.
      await waitFor(async () => (await count('inbox_messages')) >= 30, 60_000, 'processing to start');
      await instances[0]!.crash();

      // As outras duas terminam — inclusive as mensagens que estavam com a morta
      // (voltam a ficar visíveis após o visibility timeout de 5 s).
      await waitFor(async () => (await count('inbox_messages')) === 200, 120_000, 'all 200 messages');
      await waitFor(async () => (await peek(queues.queueUrl)).length === 0, 60_000, 'queue to drain');

      expect(await count(`wager_transactions where kind = 'BET'`)).toBe(200);
      for (const { walletId } of wallets) {
        expect(await walletState(app.sql, walletId)).toEqual({ balance: '980.00', version: 21 });
      }
      expect(await peek(queues.dlqUrl)).toHaveLength(0);

      // Outbox: os relays das instâncias vivas publicam tudo, sem duplicar no destino.
      await waitFor(async () => (await count('outbox_messages where published_at is null')) === 0, 60_000, 'outbox');
      const total = await count('outbox_messages');
      expect(total).toBe(420); // 10 aberturas × 2 + 200 BETs × 2
      const received = await drain(events.url);
      expect(new Set(received.map((m) => m.body.eventId)).size).toBe(total);
    },
    LONG,
  );
});

describe('Reinício do serviço', () => {
  test(
    'queda de instância durante a carga + reinício total: consistência final comprovada',
    async () => {
      // ---- Fase 1: 3 instâncias SEM workers → outbox e pendências acumulam.
      instances = await startInstances(3, env({ workersEnabled: false }), 'phase1');
      const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet('100.00')));

      // REFUND chega ANTES da BET que ele referencia → PENDING_REFERENCE.
      for (const [i, { walletId, playerId }] of wallets.entries()) {
        const refund = bet(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: `w${i}-bet-1` });
        expect((await submit(instances[0]!, refund)).status).toBe(202);
      }

      // Rajada: 3 BETs por wallet (uma delas é a referenciada), espalhadas nas 3
      // instâncias. No meio, a instância 2 morre; o cliente reenvia para outra.
      const ops = wallets.flatMap(({ walletId, playerId }, i) =>
        [1, 2, 3].map((n) => bet(walletId, playerId, { externalTransactionId: `w${i}-bet-${n}` })),
      );
      const burst = Promise.all(ops.map((op, i) => submitWithFailover(instances, op, i)));
      await instances[1]!.crash(); // com requisições em voo para ela
      const results = await burst;
      expect(results.every((r) => r.status === 200)).toBe(true);
      // Prova de que a queda aconteceu no meio: houve reenvio para outra instância.
      expect(results.some((r) => r.attempts > 1)).toBe(true);

      // Reenviar TUDO de novo (cliente sem saber o que entrou) não muda nada.
      const replays = await Promise.all(ops.map((op, i) => submitWithFailover(instances, op, i)));
      expect(replays.every((r) => r.body.idempotentReplay === true)).toBe(true);

      // Derruba o resto, sem aviso.
      await stopAll(instances);
      expect(await count(`wager_transactions where status = 'PENDING_REFERENCE'`)).toBe(5);
      expect(await count('outbox_messages where published_at is null')).toBeGreaterThan(0);

      // ---- Fase 2: 3 instâncias NOVAS, com workers.
      instances = await startInstances(3, env(), 'phase2');

      await waitFor(
        async () => (await count(`wager_transactions where status = 'PENDING_REFERENCE'`)) === 0,
        60_000,
        'pending references to resolve',
      );
      await waitFor(async () => (await count('outbox_messages where published_at is null')) === 0, 60_000, 'outbox');

      // Consistência final: 100 − 3 × 10 + 10 (refund) = 80.00 em cada wallet,
      // confirmada pelo endpoint de reconciliação de uma instância nova.
      for (const { walletId } of wallets) {
        expect((await walletState(app.sql, walletId)).balance).toBe('80.00');
        const res = await fetch(`${instances[2]!.url}/wallets/${walletId}/reconciliation`, { method: 'POST' });
        const report = (await res.json()) as Record<string, unknown>;
        expect(report).toMatchObject({ consistent: true, storedBalance: brl('80.00'), checkedEntries: 5 });
      }
      expect(await count(`wager_transactions where kind = 'BET'`)).toBe(15);
      expect(await count(`wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`)).toBe(5);

      // Cada evento confirmado chegou ao destino, nenhum perdido.
      const total = await count('outbox_messages');
      const received = await drain(events.url);
      expect(new Set(received.map((m) => m.body.eventId)).size).toBe(total);
    },
    LONG,
  );
});
