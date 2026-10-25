import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTestApp, type TestApp } from '../support/app';
import { truncateAll } from '../support/database';
import { startHttpApp, type HttpApp } from '../support/http';
import { createTestQueues, peek, sendMessage, sqs, wagerEnvelope } from '../support/sqs';
import { Metrics } from '../../src/infrastructure/observability/metrics';
import { SqsWagerConsumer } from '../../src/interface/messaging/sqs-wager-consumer';

let http: HttpApp;
const logs: Record<string, any>[] = [];

beforeAll(async () => {
  http = await startHttpApp({ logSink: (line) => logs.push(JSON.parse(line)) });
});
afterAll(async () => {
  await http.close();
});
beforeEach(async () => {
  await truncateAll(http.sql);
  logs.length = 0;
});

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function createWallet(initial = '100.00') {
  const playerId = crypto.randomUUID();
  const res = await http.post('/wallets', { playerId, initialBalance: brl(initial) });
  return { walletId: res.body.id as string, playerId };
}

function bet(walletId: string, playerId: string, amount = '25.00') {
  const externalTransactionId = `obs-${crypto.randomUUID()}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: brl(amount),
    },
  };
}

/** Valor de uma série no texto do /metrics (0 se ausente). */
function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  const line = text
    .split('\n')
    .find((l) => l.startsWith(name) && !l.startsWith('#') && wanted.every((w) => l.includes(w)));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

describe('Logs estruturados', () => {
  test('correlationId do header é devolvido e aparece em todos os logs da requisição', async () => {
    const { walletId, playerId } = await createWallet();
    logs.length = 0;
    const op = bet(walletId, playerId);
    const res = await http.post('/wagering/transactions', op.body, {
      'Idempotency-Key': op.key,
      'X-Correlation-Id': 'trace-abc-123',
    });
    expect(res.headers.get('x-correlation-id')).toBe('trace-abc-123');

    const requestLogs = logs.filter((l) => l.correlationId === 'trace-abc-123');
    expect(requestLogs.map((l) => l.msg)).toEqual(['wager transaction submitted', 'http request']);
    for (const line of requestLogs) {
      expect(line).toMatchObject({
        correlationId: 'trace-abc-123',
        providerId: 'provider-a',
        walletId,
        transactionId: res.body.transactionId,
      });
    }
    expect(requestLogs[1]).toMatchObject({
      method: 'POST',
      route: '/wagering/transactions',
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  test('sem header: um correlationId é gerado e devolvido', async () => {
    const res = await http.get('/health/live');
    const generated = res.headers.get('x-correlation-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(logs.some((l) => l.correlationId === generated && l.msg === 'http request')).toBe(true);
  });

  test('header com caracteres inseguros é ignorado (sem log injection)', async () => {
    const res = await http.request('GET', '/health/live', undefined, { 'X-Correlation-Id': 'a"b\\nfake' });
    expect(res.headers.get('x-correlation-id')).not.toContain('"');
  });

  test('nenhum valor financeiro vai para o log', async () => {
    const { walletId, playerId } = await createWallet('100.00');
    const op = bet(walletId, playerId, '37.91');
    await http.post('/wagering/transactions', op.body, { 'Idempotency-Key': op.key });
    const raw = JSON.stringify(logs);
    expect(raw).not.toContain('37.91');
    expect(raw).not.toContain('62.09'); // saldo resultante
  });
});

describe('Métricas (/metrics)', () => {
  test('transações por status, duplicatas, erros, latência e outbox', async () => {
    const { walletId, playerId } = await createWallet('30.00');
    const ok = bet(walletId, playerId, '25.00');
    await http.post('/wagering/transactions', ok.body, { 'Idempotency-Key': ok.key }); // PROCESSED
    await http.post('/wagering/transactions', ok.body, { 'Idempotency-Key': ok.key }); // replay
    const broke = bet(walletId, playerId, '25.00');
    await http.post('/wagering/transactions', broke.body, { 'Idempotency-Key': broke.key }); // REJECTED
    await http.post('/wagering/transactions', { ...ok.body, money: brl('1.00') }, { 'Idempotency-Key': ok.key }); // 409

    const res = await http.get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = res.body as string;

    const tx = 'wagering_transactions_total';
    expect(metricValue(text, tx, { status: 'PROCESSED', kind: 'BET', source: 'http' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, tx, { status: 'REJECTED', kind: 'BET', source: 'http' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, 'wagering_duplicates_total', { source: 'http' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, 'wagering_errors_total', { code: 'IDEMPOTENCY_CONFLICT' })).toBeGreaterThanOrEqual(1);
    expect(metricValue(text, 'wagering_processing_duration_seconds_count', { source: 'http' })).toBeGreaterThanOrEqual(3);
    expect(metricValue(text, 'http_request_duration_seconds_count', { route: '/wagering/transactions' })).toBeGreaterThanOrEqual(4);

    // Workers desligados neste app: a outbox acumula e o lag aparece.
    expect(metricValue(text, 'wagering_outbox_pending')).toBeGreaterThanOrEqual(4);
    expect(text).toContain('wagering_outbox_lag_seconds');
  });

  test('divergência de reconciliação incrementa a métrica e gera log de erro', async () => {
    const { walletId } = await createWallet('10.00');
    await http.sql`update wallets set balance = 11 where id = ${walletId}`;
    await http.post(`/wallets/${walletId}/reconciliation`);
    await http.sql`update wallets set balance = 10 where id = ${walletId}`;

    const text = (await http.get('/metrics')).body as string;
    expect(metricValue(text, 'wagering_reconciliation_divergences_total')).toBeGreaterThanOrEqual(1);
    expect(logs.find((l) => l.msg === 'wallet balance diverges from its ledger')).toMatchObject({
      level: 'error',
      walletId,
      difference: '1.00 BRL',
    });
  });
});

describe('Métricas do consumer SQS', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp({ recreate: false }); // o app HTTP deste arquivo já criou o banco
  });
  afterAll(async () => {
    await app.close();
  });

  test('ack, duplicata e DLQ são contados', async () => {
    const queues = await createTestQueues(3);
    const metrics = new Metrics();
    const consumer = new SqsWagerConsumer(sqs, app.processWager, app.clock, {
      queueUrl: queues.queueUrl,
      dlqUrl: queues.dlqUrl,
      consumerName: 'wager-transactions-consumer',
      waitTimeSeconds: 1,
      maxMessages: 10,
      retryBaseSeconds: 0,
      retryMaxSeconds: 0,
      shutdownTimeoutMs: 1_000,
    }, metrics);
    try {
      const playerId = crypto.randomUUID();
      const { id: walletId } = await app.openWallet.execute({ playerId, initialBalance: brl('100.00') });
      const op = bet(walletId, playerId, '5.00');
      const envelope = wagerEnvelope({ ...op.body, idempotencyKey: op.key });
      await sendMessage(queues.queueUrl, envelope, walletId);
      await sendMessage(queues.queueUrl, envelope, walletId); // duplicata
      await sendMessage(queues.queueUrl, '{not json', walletId); // DLQ

      while ((await consumer.pollOnce()) > 0);

      const text = await metrics.registry.metrics();
      expect(metricValue(text, 'wagering_transactions_total', { status: 'PROCESSED', source: 'sqs' })).toBe(1);
      expect(metricValue(text, 'wagering_duplicates_total', { source: 'sqs' })).toBe(1);
      expect(metricValue(text, 'wagering_dlq_messages_total', { code: 'INVALID_PAYLOAD' })).toBe(1);
      expect(await peek(queues.dlqUrl)).toHaveLength(1);
    } finally {
      await queues.destroy();
    }
  });
});
