import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { InvalidAmountError, MissingReferenceError } from '../../src/domain/shared/domain-error';
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

async function newWallet(initial = '100.00') {
  const playerId = crypto.randomUUID();
  const wallet = await app.openWallet.execute({ playerId, initialBalance: brl(initial) });
  return { walletId: wallet.id, playerId };
}

describe('OpenWallet', () => {
  test('saldo inicial gera OPENING + CREDIT na mesma transação', async () => {
    const view = await app.openWallet.execute({ playerId: 'p-open', initialBalance: brl('1000.00') });
    expect(view).toMatchObject({ playerId: 'p-open', balance: brl('1000.00'), version: 1 });

    const [opening] = await app.sql`select kind, status from wager_transactions where wallet_id = ${view.id}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
    expect(await ledgerEntries(app.sql, view.id)).toEqual([{ direction: 'CREDIT', amount: '1000.00' }]);
  });

  test('saldo zero: sem OPENING e sem lançamento', async () => {
    const view = await app.openWallet.execute({ playerId: 'p-zero', initialBalance: brl('0.00') });
    expect(await ledgerEntries(app.sql, view.id)).toEqual([]);
  });

  test('wallet duplicada para player + moeda é conflito, e nada fica pela metade', async () => {
    await app.openWallet.execute({ playerId: 'p-dup', initialBalance: brl('10.00') });
    await expect(
      app.openWallet.execute({ playerId: 'p-dup', initialBalance: brl('20.00') }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    const [{ n }] = await app.sql`select count(*)::int as n from wager_transactions`;
    expect(n).toBe(1); // só a OPENING da primeira wallet
  });
});

describe('ProcessWagerTransaction — fluxo', () => {
  test('BET processada: saldo, ledger e resposta', async () => {
    const { walletId, playerId } = await newWallet('1000.00');
    const result = await app.processWager.execute(
      wagerCommand(walletId, playerId, { money: brl('25.00') }),
    );

    expect(result).toMatchObject({ status: 'PROCESSED', balance: brl('975.00'), idempotentReplay: false });
    expect(await walletState(app.sql, walletId)).toEqual({ balance: '975.00', version: 2 });
  });

  test('BET sem saldo: REJECTED persistida, saldo e ledger intactos', async () => {
    const { walletId, playerId } = await newWallet('10.00');
    const result = await app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('25.00') }));

    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: brl('10.00') });
    expect(await walletState(app.sql, walletId)).toEqual({ balance: '10.00', version: 1 });
    expect(await ledgerEntries(app.sql, walletId)).toHaveLength(1); // só a abertura
  });

  test('LOSS: PROCESSED sem lançamento', async () => {
    const { walletId, playerId } = await newWallet();
    const result = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'LOSS', money: brl('0.00') }),
    );
    expect(result.status).toBe(Status.Processed);
    expect(await walletState(app.sql, walletId)).toEqual({ balance: '100.00', version: 1 });
  });

  test('BET → REFUND devolve o valor; segundo REFUND/ROLLBACK é ALREADY_REVERSED', async () => {
    const { walletId, playerId } = await newWallet();
    await app.processWager.execute(
      wagerCommand(walletId, playerId, { externalTransactionId: 'bet-1', money: brl('40.00') }),
    );
    const refund = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'bet-1', money: brl('40.00') }),
    );
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: brl('100.00') });

    const rollback = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-1', money: brl('40.00') }),
    );
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
  });

  test('REFUND antes da BET: PENDING_REFERENCE, sem tocar no saldo', async () => {
    const { walletId, playerId } = await newWallet();
    const refund = await app.processWager.execute(
      wagerCommand(walletId, playerId, { kind: 'REFUND', referenceExternalTransactionId: 'bet-late', money: brl('40.00') }),
    );
    expect(refund).toMatchObject({ status: 'PENDING_REFERENCE', balance: undefined });

    const [row] = await app.sql`select reference_attempts, next_reference_attempt_at is not null as scheduled
                                from wager_transactions where id = ${refund.transactionId}`;
    expect(row).toEqual({ reference_attempts: 1, scheduled: true });
    expect((await walletState(app.sql, walletId)).balance).toBe('100.00');
  });

  test('wallet inexistente → WalletNotFoundError e nada é gravado', async () => {
    await expect(
      app.processWager.execute(wagerCommand(crypto.randomUUID(), 'p1')),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    const [{ n }] = await app.sql`select count(*)::int as n from wager_transactions`;
    expect(n).toBe(0);
  });

  test('payload inválido falha antes de tocar no banco', async () => {
    const { walletId, playerId } = await newWallet();
    await expect(
      app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('1e3') })),
    ).rejects.toBeInstanceOf(InvalidAmountError);
    await expect(
      app.processWager.execute(wagerCommand(walletId, playerId, { kind: 'REFUND' })),
    ).rejects.toBeInstanceOf(MissingReferenceError);
  });
});

describe('ProcessWagerTransaction — idempotência', () => {
  test('requisição idêntica devolve o resultado ORIGINAL com idempotentReplay', async () => {
    const { walletId, playerId } = await newWallet();
    const command = wagerCommand(walletId, playerId, { money: brl('30.00') });
    const first = await app.processWager.execute(command);

    // Saldo muda depois, mas o replay devolve o saldo daquele momento.
    await app.processWager.execute(wagerCommand(walletId, playerId, { money: brl('5.00') }));
    const replay = await app.processWager.execute(command);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual(brl('70.00'));
    expect((await walletState(app.sql, walletId)).balance).toBe('65.00');
  });

  test('replay de uma REJECTED devolve a mesma rejeição', async () => {
    const { walletId, playerId } = await newWallet('10.00');
    const command = wagerCommand(walletId, playerId, { money: brl('50.00') });
    const first = await app.processWager.execute(command);
    expect(await app.processWager.execute(command)).toEqual({ ...first, idempotentReplay: true });
  });

  test('"25" e "25.00" são o mesmo payload (money normalizado no hash)', async () => {
    const { walletId, playerId } = await newWallet();
    const command = wagerCommand(walletId, playerId, { money: brl('25.00') });
    await app.processWager.execute(command);
    const replay = await app.processWager.execute({ ...command, money: brl('25') });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mesma key com payload diferente → conflito, não replay', async () => {
    const { walletId, playerId } = await newWallet();
    const command = wagerCommand(walletId, playerId, { money: brl('10.00') });
    await app.processWager.execute(command);
    await expect(
      app.processWager.execute({ ...command, money: brl('11.00') }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await walletState(app.sql, walletId)).balance).toBe('90.00');
  });

  test('mesmo id externo com outra key e payload diferente → conflito', async () => {
    const { walletId, playerId } = await newWallet();
    const command = wagerCommand(walletId, playerId);
    await app.processWager.execute(command);
    await expect(
      app.processWager.execute({ ...command, idempotencyKey: 'other-key', roundId: 'round-2' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
