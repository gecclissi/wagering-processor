import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { TransientError } from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import {
  SqsWagerConsumer,
  type SqsWagerConsumerConfig,
} from '../../src/interface/messaging/sqs-wager-consumer';
import { createTestApp, expectLedgerConsistent, walletState, type TestApp } from '../support/app';
import { truncateAll } from '../support/database';
import { createTestQueues, peek, sendMessage, sqs, wagerEnvelope, type TestQueues } from '../support/sqs';

let app: TestApp;
let queues: TestQueues;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await truncateAll(app.sql);
  queues = await createTestQueues(3);
});
afterEach(async () => {
  await expectLedgerConsistent(app.sql);
  await queues.destroy();
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

function consumer(processWager = app.processWager, overrides: Partial<SqsWagerConsumerConfig> = {}) {
  return new SqsWagerConsumer(sqs, processWager, app.clock, {
    queueUrl: queues.queueUrl,
    dlqUrl: queues.dlqUrl,
    consumerName: 'wager-transactions-consumer',
    waitTimeSeconds: 1,
    maxMessages: 10,
    retryBaseSeconds: 0, // retry imediato nos testes
    retryMaxSeconds: 0,
    shutdownTimeoutMs: 5_000,
    ...overrides,
  });
}

/** UnitOfWork que falha com erro transitório nas primeiras `failures` chamadas (banco "fora"). */
function flakyUow(failures: number): UnitOfWork {
  let calls = 0;
  return {
    run: (work) => {
      calls += 1;
      if (calls <= failures) return Promise.reject(new TransientError('database unavailable (simulated)'));
      return app.uow.run(work);
    },
  };
}

/** UnitOfWork lento: segura a transação aberta por `ms` (mensagem "em andamento"). */
function slowUow(ms: number): UnitOfWork {
  return { run: (work) => app.uow.run(async (ctx) => { await Bun.sleep(ms); return work(ctx); }) };
}

async function newWallet(initial = '100.00') {
  const playerId = crypto.randomUUID();
  const wallet = await app.openWallet.execute({ playerId, initialBalance: brl(initial) });
  return { walletId: wallet.id, playerId };
}

let seq = 0;
function betData(walletId: string, playerId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const externalTransactionId = `sqs-tx-${Date.now()}-${seq}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('10.00'),
    ...overrides,
  };
}

const count = async (table: string) =>
  (await app.sql.unsafe(`select count(*)::int as n from ${table}`))[0].n as number;

describe('SQS consumer — caminho feliz', () => {
  test('processa a mensagem, grava inbox e faz ack', async () => {
    const { walletId, playerId } = await newWallet();
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);

    expect(await consumer().pollOnce()).toBe(1);

    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
    expect(await count('inbox_messages')).toBe(1);
    expect(await peek(queues.queueUrl)).toHaveLength(0); // ack = apagada
    expect(await peek(queues.dlqUrl)).toHaveLength(0);
  });

  test('rejeição de negócio fica gravada e é ack (não vai para a DLQ)', async () => {
    const { walletId, playerId } = await newWallet('5.00');
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);

    await consumer().pollOnce();

    const [tx] = await app.sql`select status, failure_code from wager_transactions where kind = 'BET'`;
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await peek(queues.queueUrl)).toHaveLength(0);
    expect(await peek(queues.dlqUrl)).toHaveLength(0);
  });
});

describe('SQS consumer — inbox e redelivery', () => {
  test('a mesma mensagem entregue duas vezes debita uma vez só', async () => {
    const { walletId, playerId } = await newWallet();
    const envelope = wagerEnvelope(betData(walletId, playerId));
    // DeduplicationIds diferentes: o SQS NÃO deduplica — quem garante é a inbox.
    await sendMessage(queues.queueUrl, envelope, walletId);
    await sendMessage(queues.queueUrl, envelope, walletId);

    const c = consumer();
    while ((await c.pollOnce()) > 0);

    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
    expect(await count('inbox_messages')).toBe(1);
    expect(await count(`wager_transactions where kind = 'BET'`)).toBe(1);
    expect(await peek(queues.queueUrl)).toHaveLength(0);
  });

  test('worker morre DEPOIS do commit e ANTES do ack: a redelivery não duplica', async () => {
    const { walletId, playerId } = await newWallet();
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);

    // 1ª instância: recebe e processa (commit)... e "morre" sem apagar a mensagem.
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, MessageSystemAttributeNames: ['All'], WaitTimeSeconds: 1 }),
    );
    expect(Messages).toHaveLength(1);
    const first = await consumer().decide(Messages[0]!); // processa, mas não faz ack
    expect(first).toEqual({ action: 'ack', outcome: 'PROCESSED' });
    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');

    // A visibilidade expira (aqui: forçada para 0) e outra instância recebe de novo.
    const { ChangeMessageVisibilityCommand } = await import('@aws-sdk/client-sqs');
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queues.queueUrl,
        ReceiptHandle: Messages[0]!.ReceiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    expect(await consumer().pollOnce()).toBe(1);

    expect((await walletState(app.sql, walletId)).balance).toBe('90.00'); // nada duplicado
    expect(await peek(queues.queueUrl)).toHaveLength(0); // agora sim, ack
  });

  test('messageId reaproveitado com outro conteúdo vai para a DLQ', async () => {
    const { walletId, playerId } = await newWallet();
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId), 'msg-reused'), walletId);
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId), 'msg-reused'), walletId);

    const c = consumer();
    while ((await c.pollOnce()) > 0);

    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
    const dlq = await peek(queues.dlqUrl);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.MessageAttributes?.failureReason?.StringValue).toStartWith('MESSAGE_ID_CONFLICT');
  });
});

describe('SQS consumer — erros permanentes vão direto para a DLQ', () => {
  test.each([
    ['JSON malformado', () => '{"messageId": ', 'INVALID_PAYLOAD'],
    ['tipo desconhecido', () => ({ ...wagerEnvelope({}), type: 'Other' }), 'INVALID_PAYLOAD'],
    ['valor inválido', (w: string, p: string) => wagerEnvelope(betData(w, p, { money: brl('1e3') })), 'INVALID_AMOUNT'],
    ['wallet inexistente', (_w: string, p: string) => wagerEnvelope(betData(crypto.randomUUID(), p)), 'WALLET_NOT_FOUND'],
  ])('%s', async (_name, build, code) => {
    const { walletId, playerId } = await newWallet();
    await sendMessage(queues.queueUrl, build(walletId, playerId), walletId);

    await consumer().pollOnce();

    expect(await peek(queues.queueUrl)).toHaveLength(0);
    const dlq = await peek(queues.dlqUrl);
    expect(dlq).toHaveLength(1);
    expect(dlq[0]!.MessageAttributes?.failureReason?.StringValue).toStartWith(code);
    expect(await count('inbox_messages')).toBe(0); // nada foi commitado
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
  });
});

describe('SQS consumer — retry transitório', () => {
  test('banco fora 2 vezes, depois volta: processa uma única vez', async () => {
    const { walletId, playerId } = await newWallet();
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);
    const flaky = new ProcessWagerTransactionUseCase(flakyUow(2), app.ids, app.clock);
    const c = consumer(flaky);

    await c.pollOnce(); // falha 1 → volta para a fila
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
    await c.pollOnce(); // falha 2
    await c.pollOnce(); // sucesso

    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
    expect(await peek(queues.queueUrl)).toHaveLength(0);
    expect(await peek(queues.dlqUrl)).toHaveLength(0);
  });

  test('falha transitória que não passa: após maxReceiveCount o SQS move para a DLQ', async () => {
    const { walletId, playerId } = await newWallet();
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);
    const broken = new ProcessWagerTransactionUseCase(flakyUow(Infinity), app.ids, app.clock);
    const c = consumer(broken);

    for (let i = 0; i < 3; i++) await c.pollOnce(); // 3 recebimentos = maxReceiveCount
    expect(await c.pollOnce()).toBe(0); // no 4º, a redrive policy já tirou da fila

    expect(await peek(queues.queueUrl)).toHaveLength(0);
    expect(await peek(queues.dlqUrl)).toHaveLength(1);
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
  });
});

describe('SQS consumer — SIGTERM (graceful shutdown)', () => {
  test('stop() espera a mensagem em andamento terminar e fazer ack', async () => {
    const { walletId, playerId } = await newWallet();
    const slow = new ProcessWagerTransactionUseCase(slowUow(800), app.ids, app.clock);
    const c = consumer(slow);
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);

    c.start();
    // espera a mensagem começar a ser processada (inbox ainda vazia: transação aberta)
    for (let i = 0; i < 50 && (c as unknown as { inFlight: Map<string, unknown> }).inFlight.size === 0; i++) {
      await Bun.sleep(100);
    }
    await c.stop();

    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
    expect(await peek(queues.queueUrl)).toHaveLength(0);
  });

  test('prazo de shutdown estourado: devolve a mensagem para a fila e sai', async () => {
    const { walletId, playerId } = await newWallet();
    const slow = new ProcessWagerTransactionUseCase(slowUow(2_500), app.ids, app.clock);
    const c = consumer(slow, { shutdownTimeoutMs: 200 });
    await sendMessage(queues.queueUrl, wagerEnvelope(betData(walletId, playerId)), walletId);

    c.start();
    for (let i = 0; i < 50 && (c as unknown as { inFlight: Map<string, unknown> }).inFlight.size === 0; i++) {
      await Bun.sleep(100);
    }
    const started = performance.now();
    await c.stop();
    expect(performance.now() - started).toBeLessThan(1_500); // não esperou os 2,5 s

    // Mensagem visível de novo: outra instância pode pegar imediatamente.
    expect(await peek(queues.queueUrl)).toHaveLength(1);

    // A transação lenta ainda commita; a redelivery é deduplicada pela inbox.
    await Bun.sleep(2_800);
    await consumer().pollOnce();
    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
    expect(await count(`wager_transactions where kind = 'BET'`)).toBe(1);
  });
});
