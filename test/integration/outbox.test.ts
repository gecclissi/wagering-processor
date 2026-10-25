import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RelayOutboxUseCase } from '../../src/application/outbox/relay-outbox.use-case';
import type { EventPublisher, UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createTestApp, expectLedgerConsistent, wagerCommand, walletState, type TestApp } from '../support/app';
import { truncateAll } from '../support/database';
import { createFifoQueue, drain, sqs } from '../support/sqs';

let app: TestApp;
let events: { url: string; destroy: () => Promise<unknown> };

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll(app.sql);
  events = await createFifoQueue('test-events');
});
afterEach(async () => {
  await expectLedgerConsistent(app.sql);
  await events.destroy();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(initial = '100.00') {
  const playerId = crypto.randomUUID();
  const wallet = await app.openWallet.execute({ playerId, initialBalance: brl(initial) });
  return { walletId: wallet.id, playerId };
}

async function outboxRows() {
  return (await app.sql`
    select id, aggregate_id, event_type, payload, attempts, next_attempt_at, published_at
    from outbox_messages order by occurred_at, id`) as {
    id: string;
    aggregate_id: string;
    event_type: string;
    payload: Record<string, any>;
    attempts: number;
    next_attempt_at: Date;
    published_at: Date | null;
  }[];
}

const eventTypes = async () => (await outboxRows()).map((r) => r.event_type);

/** Publisher real que também conta quantas vezes cada evento foi enviado. */
function countingPublisher(inner: EventPublisher) {
  const sent = new Map<string, number>();
  const publisher: EventPublisher = {
    async publish(messages: OutboxMessage[]) {
      for (const m of messages) sent.set(m.id, (sent.get(m.id) ?? 0) + 1);
      return inner.publish(messages);
    },
  };
  return { publisher, sent };
}

const relayFor = (publisher: EventPublisher, uow: UnitOfWork = app.uow) =>
  new RelayOutboxUseCase(uow, publisher, app.clock, 10);

async function relayUntilEmpty(relay: RelayOutboxUseCase) {
  while ((await relay.execute()).published > 0);
}

describe('Eventos gravados na MESMA transação do efeito', () => {
  test('abertura com saldo: Processed (OPENING) + WalletBalanceChanged', async () => {
    await newWallet('100.00');
    expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('BET processada: Processed + WalletBalanceChanged, com envelope completo', async () => {
    const { walletId, playerId } = await newWallet();
    await app.sql`truncate outbox_messages`;
    const result = await app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('30.00') }), {
      correlationId: 'corr-123',
    });

    const rows = await outboxRows();
    expect(rows.map((r) => r.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows.every((r) => r.aggregate_id === walletId)).toBe(true);

    const changed = rows[1]!.payload;
    expect(changed).toMatchObject({
      eventId: rows[1]!.id,
      eventType: 'WalletBalanceChanged',
      aggregateId: walletId,
      correlationId: 'corr-123',
      version: 1,
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      data: {
        walletId,
        transactionId: result.transactionId,
        direction: 'DEBIT',
        money: brl('30.00'), // string decimal, nunca number
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
        walletVersion: 2,
      },
    });
  });

  test('LOSS: só Processed (saldo não muda → sem WalletBalanceChanged)', async () => {
    const { walletId, playerId } = await newWallet();
    await app.sql`truncate outbox_messages`;
    await app.processWager.execute(wagerCommand(walletId, playerId, { kind: 'LOSS', money: brl('0.00') }));
    expect(await eventTypes()).toEqual(['WagerTransactionProcessed']);
  });

  test('rejeição: só Rejected, com failureCode', async () => {
    const { walletId, playerId } = await newWallet('5.00');
    await app.sql`truncate outbox_messages`;
    await app.processWager.execute(wagerCommand(walletId, playerId));
    const rows = await outboxRows();
    expect(rows.map((r) => r.event_type)).toEqual(['WagerTransactionRejected']);
    expect(rows[0]!.payload.data.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('referência ausente: PendingReference', async () => {
    const { walletId, playerId } = await newWallet();
    await app.sql`truncate outbox_messages`;
    await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'nope' }),
    );
    expect(await eventTypes()).toEqual(['WagerTransactionPendingReference']);
  });

  test('replay não gera eventos novos', async () => {
    const { walletId, playerId } = await newWallet();
    const command = wagerCommand(walletId, playerId);
    await app.processWager.execute(command);
    const before = (await outboxRows()).length;
    await app.processWager.execute(command);
    expect((await outboxRows()).length).toBe(before);
  });

  test('atomicidade: se gravar a outbox falha, NADA do efeito financeiro fica', async () => {
    const { walletId, playerId } = await newWallet();
    const before = await outboxRows();
    const failingOutbox: UnitOfWork = {
      run: (work) =>
        app.uow.run((ctx) =>
          work({ ...ctx, outbox: { ...ctx.outbox, add: () => Promise.reject(new Error('outbox write failed')) } }),
        ),
    };
    const useCase = new ProcessWagerTransactionUseCase(failingOutbox, app.ids, app.clock);

    await expect(useCase.execute(wagerCommand(walletId, playerId))).rejects.toThrow('outbox write failed');

    expect(await walletState(app.sql, walletId)).toEqual({ balance: '100.00', version: 1 });
    const [{ n }] = await app.sql`select count(*)::int as n from wager_transactions where kind = 'BET'`;
    expect(n).toBe(0);
    expect(await outboxRows()).toEqual(before);
  });
});

describe('Relay da outbox', () => {
  test('publica os pendentes no SQS, marca published_at e não republica', async () => {
    const { walletId, playerId } = await newWallet();
    await app.processWager.execute(wagerCommand(walletId, playerId));
    const relay = relayFor(new SqsEventPublisher(sqs, { url: events.url }));

    expect(await relay.execute()).toEqual({ published: 4, failed: 0 });
    expect(await relay.execute()).toEqual({ published: 0, failed: 0 });

    expect((await outboxRows()).every((r) => r.published_at !== null && r.attempts === 1)).toBe(true);
    const received = await drain(events.url);
    expect(received.map((m) => m.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(received.every((m) => typeof m.body.eventId === 'string')).toBe(true);
  });

  test('3 publishers concorrentes: cada evento publicado exatamente uma vez (SKIP LOCKED)', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet('100.00')));
    await Promise.all(
      wallets.flatMap(({ walletId, playerId }) =>
        Array.from({ length: 5 }, () => app.processWager.execute(wagerCommand(walletId, playerId))),
      ),
    );
    const total = (await outboxRows()).length; // 5 aberturas × 2 + 25 BETs × 2 = 60
    expect(total).toBe(60);

    const { publisher, sent } = countingPublisher(new SqsEventPublisher(sqs, { url: events.url }));
    await Promise.all([1, 2, 3].map(() => relayUntilEmpty(relayFor(publisher))));

    expect(sent.size).toBe(total);
    expect([...sent.values()].every((count) => count === 1)).toBe(true);
    expect((await outboxRows()).every((r) => r.published_at !== null)).toBe(true);
    expect(await drain(events.url)).toHaveLength(total);
  });

  test('morre DEPOIS de publicar e ANTES do commit: outra instância republica, sem duplicar no destino', async () => {
    const { walletId, playerId } = await newWallet();
    await app.processWager.execute(wagerCommand(walletId, playerId));
    const realPublisher = new SqsEventPublisher(sqs, { url: events.url });

    // Instância 1: publica e "morre" antes do COMMIT → rollback, nada marcado.
    const dyingUow: UnitOfWork = {
      run: (work) =>
        app.uow.run(async (ctx) => {
          await work(ctx);
          throw new Error('process killed before commit');
        }),
    };
    await expect(relayFor(realPublisher, dyingUow).execute()).rejects.toThrow('process killed');
    expect((await outboxRows()).every((r) => r.published_at === null)).toBe(true);

    // Instância 2 assume e publica de novo.
    expect((await relayFor(realPublisher).execute()).published).toBe(4);

    // Publicado 2× pelo relay, mas o SQS FIFO deduplica pelo eventId
    // (MessageDeduplicationId) — e o consumidor também pode deduplicar por ele.
    const received = await drain(events.url);
    expect(received).toHaveLength(4);
    expect(new Set(received.map((m) => m.body.eventId)).size).toBe(4);
  });

  test('broker fora do ar: agenda retry com backoff e não marca como publicado', async () => {
    await newWallet();
    const broken: EventPublisher = { publish: () => Promise.reject(new Error('SQS unavailable')) };
    const before = Date.now();

    expect(await relayFor(broken).execute()).toEqual({ published: 0, failed: 2 });

    const rows = await outboxRows();
    expect(rows.every((r) => r.published_at === null && r.attempts === 1)).toBe(true);
    expect(rows.every((r) => r.next_attempt_at.getTime() >= before + 900)).toBe(true); // ~1s depois
    // Ainda não venceu: a próxima rodada não pega nada.
    expect(await relayFor(broken).execute()).toEqual({ published: 0, failed: 0 });
  });
});
