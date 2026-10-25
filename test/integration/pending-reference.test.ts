import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { RetryPendingReferencesUseCase } from '../../src/application/wagering/retry-pending-references.use-case';
import { WagerTransactionStatus as Status } from '../../src/domain/wager/wager-transaction';
import { createTestApp, expectLedgerConsistent, ledgerEntries, wagerCommand, walletState, type TestApp } from '../support/app';
import { truncateAll } from '../support/database';

let app: TestApp;
let worker: RetryPendingReferencesUseCase;

beforeAll(async () => {
  app = await createTestApp();
  worker = new RetryPendingReferencesUseCase(app.uow, app.ids, app.clock);
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

async function newWallet(initial = '100.00') {
  const playerId = crypto.randomUUID();
  const wallet = await app.openWallet.execute({ playerId, initialBalance: brl(initial) });
  return { walletId: wallet.id, playerId };
}

/** Em vez de esperar o backoff real, adianta o relógio da tentativa no banco. */
const makeDue = () =>
  app.sql`update wager_transactions set next_reference_attempt_at = now() - interval '1 second'
          where status = 'PENDING_REFERENCE'`;

async function txRow(id: string) {
  const [row] = await app.sql`
    select status, failure_code, reference_attempts, reference_transaction_id
    from wager_transactions where id = ${id}`;
  return row;
}

const eventTypes = async () =>
  ((await app.sql`select event_type from outbox_messages order by occurred_at, id`) as { event_type: string }[]).map(
    (r) => r.event_type,
  );

describe('Worker de PENDING_REFERENCE', () => {
  test('REFUND chega antes da BET; quando a BET chega, o worker aplica o REFUND', async () => {
    const { walletId, playerId } = await newWallet();
    const refundCommand = wagerCommand(walletId, playerId, {
      kind: 'REFUND',
      referenceExternalTransactionId: 'bet-late',
      money: brl('40.00'),
    });
    const refund = await app.processWager.execute(refundCommand);
    expect(refund.status).toBe(Status.PendingReference);

    const bet = await app.processWager.execute(
      wagerCommand(walletId, playerId, { externalTransactionId: 'bet-late', money: brl('40.00') }),
    );
    expect((await walletState(app.sql, walletId)).balance).toBe('60.00');

    await app.sql`truncate outbox_messages`;
    await makeDue();
    expect(await worker.execute()).toMatchObject({ examined: 1, processed: 1 });

    expect(await txRow(refund.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: bet.transactionId,
    });
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
    expect(await eventTypes()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);

    // O provedor reenviando o REFUND agora recebe o resultado final.
    const replay = await app.processWager.execute(refundCommand);
    expect(replay).toMatchObject({ status: Status.Processed, balance: brl('100.00'), idempotentReplay: true });
  });

  test('ainda não venceu o backoff: o worker não toca', async () => {
    const { walletId, playerId } = await newWallet();
    const refund = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'x' }),
    );
    expect(await worker.execute()).toMatchObject({ examined: 0 });
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 1 });
  });

  test('referência continua ausente: nova tentativa agendada, sem evento repetido', async () => {
    const { walletId, playerId } = await newWallet();
    const refund = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'x' }),
    );
    await app.sql`truncate outbox_messages`;
    await makeDue();

    expect(await worker.execute()).toMatchObject({ stillPending: 1 });
    expect(await txRow(refund.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', reference_attempts: 2 });
    expect(await eventTypes()).toEqual([]);
  });

  test('tentativas esgotadas: REJECTED / REFERENCE_NOT_FOUND + evento Rejected', async () => {
    const { walletId, playerId } = await newWallet();
    const refund = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'never' }),
    );
    await app.sql`update wager_transactions set reference_attempts = 10 where id = ${refund.transactionId}`;
    await app.sql`truncate outbox_messages`;
    await makeDue();

    expect(await worker.execute()).toMatchObject({ rejected: 1 });
    expect(await txRow(refund.transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });
    expect(await eventTypes()).toEqual(['WagerTransactionRejected']);
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
  });

  test('3 workers concorrentes sobre as mesmas pendentes: cada uma aplicada uma vez', async () => {
    const { walletId, playerId } = await newWallet();
    for (let i = 0; i < 5; i++) {
      await app.processWager.execute(
        wagerCommand(walletId, playerId, { kind: 'ROLLBACK', referenceExternalTransactionId: `late-${i}`, money: brl('10.00') }),
      );
    }
    for (let i = 0; i < 5; i++) {
      await app.processWager.execute(
        wagerCommand(walletId, playerId, { externalTransactionId: `late-${i}`, money: brl('10.00') }),
      );
    }
    expect((await walletState(app.sql, walletId)).balance).toBe('50.00');
    await makeDue();

    const results = await Promise.all([1, 2, 3].map(() => worker.execute()));

    expect(results.reduce((sum, r) => sum + r.processed, 0)).toBe(5);
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
    const credits = (await ledgerEntries(app.sql, walletId)).filter((e) => e.direction === 'CREDIT');
    expect(credits).toHaveLength(6); // abertura + 5 rollbacks, nenhum duplicado
  });
});
