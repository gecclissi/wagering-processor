import { describe, expect, test } from 'bun:test';
import {
  InvalidAmountError,
  InvalidKindError,
  InvalidPayloadError,
  InvalidTransactionStateError,
  MissingReferenceError,
  UnexpectedReferenceError,
} from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import {
  REFERENCE_RETRY_POLICY,
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../../src/domain/wager/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { T0, brl, id, usd, wager } from './fixtures';

const ref = (externalTransactionId: string) => ({ referenceExternalTransactionId: externalTransactionId });

describe('WagerTransaction.create — validação de entrada', () => {
  test('nasce em PENDING', () => {
    const tx = wager(Kind.Bet, '25.00');
    expect(tx.status).toBe(Status.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING não pode ser submetido de fora', () => {
    expect(() => wager(Kind.Opening, '10.00')).toThrow(InvalidKindError);
  });

  test('kind desconhecido é rejeitado', () => {
    expect(() => wager('JACKPOT' as Kind, '10.00')).toThrow(InvalidKindError);
  });

  test.each([Kind.Refund, Kind.Rollback])('%s sem referência → MissingReferenceError', (kind) => {
    expect(() => wager(kind, '10.00')).toThrow(MissingReferenceError);
    expect(() => wager(kind, '10.00', ref('   '))).toThrow(MissingReferenceError);
  });

  test('BET com referência → UnexpectedReferenceError', () => {
    expect(() => wager(Kind.Bet, '10.00', ref('bet-0'))).toThrow(UnexpectedReferenceError);
  });

  test('WIN e LOSS aceitam referência opcional', () => {
    expect(wager(Kind.Win, '10.00').referenceExternalTransactionId).toBeUndefined();
    expect(wager(Kind.Win, '10.00', ref('bet-1')).referenceExternalTransactionId).toBe('bet-1');
    expect(wager(Kind.Loss, '0.00', ref('bet-1')).referenceExternalTransactionId).toBe('bet-1');
  });

  test('LOSS aceita 0.00; os demais precisam de valor positivo', () => {
    expect(wager(Kind.Loss, '0.00').status).toBe(Status.Pending);
    expect(() => wager(Kind.Bet, '0.00')).toThrow(InvalidAmountError);
    expect(() => wager(Kind.Win, '0.00')).toThrow(InvalidAmountError);
  });

  test.each(['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'])(
    'campo obrigatório vazio: %s',
    (field) => {
      expect(() => wager(Kind.Bet, '10.00', { [field]: '' })).toThrow(InvalidPayloadError);
    },
  );
});

describe('WagerTransaction — consultas de domínio', () => {
  test('affectsBalance é false só para LOSS', () => {
    expect(wager(Kind.Loss, '0.00').affectsBalance()).toBe(false);
    expect(wager(Kind.Bet, '1.00').affectsBalance()).toBe(true);
    expect(wager(Kind.Win, '1.00').affectsBalance()).toBe(true);
  });

  test('requiresReference é true só para REFUND e ROLLBACK', () => {
    expect(wager(Kind.Refund, '1.00', ref('b')).requiresReference()).toBe(true);
    expect(wager(Kind.Rollback, '1.00', ref('b')).requiresReference()).toBe(true);
    expect(wager(Kind.Bet, '1.00').requiresReference()).toBe(false);
    expect(wager(Kind.Win, '1.00').requiresReference()).toBe(false);
  });

  test('matchesPayload: mesma key com payload diferente NÃO casa (é conflito)', () => {
    const tx = wager(Kind.Bet, '10.00', { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });

  test('ledgerDirectionFor: BET debita; WIN/REFUND creditam', () => {
    expect(wager(Kind.Bet, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(wager(Kind.Win, '1.00').ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wager(Kind.Refund, '1.00', ref('b')).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('ledgerDirectionFor: ROLLBACK inverte a referência', () => {
    const rollback = wager(Kind.Rollback, '1.00', ref('x'));
    expect(rollback.ledgerDirectionFor(wager(Kind.Bet, '1.00'))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(wager(Kind.Win, '1.00'))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(wager(Kind.Refund, '1.00', ref('b')))).toBe(LedgerDirection.Debit);
  });

  test('ledgerDirectionFor: LOSS não tem direção', () => {
    expect(() => wager(Kind.Loss, '0.00').ledgerDirectionFor()).toThrow();
  });
});

describe('WagerTransaction — máquina de estados', () => {
  test('PENDING → PROCESSED guarda referência, saldo resultante e data', () => {
    const tx = wager(Kind.Bet, '10.00');
    tx.markProcessed(undefined, brl('90.00'), T0);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultingBalance?.amount).toBe('90.00');
    expect(tx.processedAt).toBe(T0);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED guarda o failureCode', () => {
    const tx = wager(Kind.Bet, '10.00');
    tx.reject(FailureCode.InsufficientFunds, T0, brl('5.00'));
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test('PENDING → FAILED', () => {
    const tx = wager(Kind.Bet, '10.00');
    tx.fail(FailureCode.ProcessingFailed, T0);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('estados terminais não mudam mais (erro de programação)', () => {
    const processed = wager(Kind.Bet, '10.00');
    processed.markProcessed(undefined, brl('0.00'), T0);
    expect(() => processed.reject(FailureCode.InsufficientFunds, T0)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markPendingReference(T0)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markProcessed(undefined, brl('0.00'), T0)).toThrow(InvalidTransactionStateError);

    const rejected = wager(Kind.Bet, '10.00');
    rejected.reject(FailureCode.InsufficientFunds, T0);
    expect(() => rejected.markProcessed(undefined, brl('0.00'), T0)).toThrow(InvalidTransactionStateError);

    const failed = wager(Kind.Bet, '10.00');
    failed.fail(FailureCode.ProcessingFailed, T0);
    expect(() => failed.fail(FailureCode.ProcessingFailed, T0)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE agenda tentativas com backoff exponencial (1s, 2s, 4s...)', () => {
    const tx = wager(Kind.Refund, '10.00', ref('bet-x'));

    tx.markPendingReference(T0);
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt!.getTime() - T0.getTime()).toBe(1_000);

    tx.markPendingReference(T0);
    expect(tx.nextReferenceAttemptAt!.getTime() - T0.getTime()).toBe(2_000);

    tx.markPendingReference(T0);
    expect(tx.nextReferenceAttemptAt!.getTime() - T0.getTime()).toBe(4_000);

    expect(tx.isDueForReferenceRetry(new Date(T0.getTime() + 3_999))).toBe(false);
    expect(tx.isDueForReferenceRetry(new Date(T0.getTime() + 4_000))).toBe(true);
  });

  test('backoff é limitado a maxMs e as tentativas se esgotam', () => {
    const tx = wager(Kind.Refund, '10.00', ref('bet-x'));
    for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) tx.markPendingReference(T0);
    expect(tx.hasExhaustedReferenceAttempts()).toBe(true);
    expect(tx.nextReferenceAttemptAt!.getTime() - T0.getTime()).toBe(REFERENCE_RETRY_POLICY.maxMs);
  });

  test('PENDING_REFERENCE → PROCESSED quando a referência chega', () => {
    const tx = wager(Kind.Refund, '10.00', ref('bet-x'));
    tx.markPendingReference(T0);
    tx.markProcessed('internal-bet-id', brl('110.00'), T0);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.referenceTransactionId).toBe('internal-bet-id');
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });
});

describe('WagerTransaction.checkReference', () => {
  const processedBet = (overrides = {}) => {
    const bet = wager(Kind.Bet, '10.00', { externalTransactionId: 'bet-1', ...overrides });
    bet.markProcessed(undefined, brl('90.00'), T0);
    return bet;
  };

  test('REFUND de BET processada da mesma rodada → valid', () => {
    expect(wager(Kind.Refund, '10.00', ref('bet-1')).checkReference(processedBet())).toEqual({ kind: 'valid' });
  });

  test('REFUND só referencia BET', () => {
    const win = wager(Kind.Win, '10.00');
    win.markProcessed(undefined, brl('0.00'), T0);
    expect(wager(Kind.Refund, '10.00', ref('w')).checkReference(win)).toEqual({
      kind: 'invalid',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test('ROLLBACK não referencia ROLLBACK nem LOSS', () => {
    const loss = wager(Kind.Loss, '0.00');
    loss.markProcessed(undefined, brl('0.00'), T0);
    expect(wager(Kind.Rollback, '10.00', ref('l')).checkReference(loss)).toMatchObject({
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
  ])('referência com %s diferente → REFERENCE_MISMATCH', (_field, overrides) => {
    expect(wager(Kind.Refund, '10.00', ref('bet-1')).checkReference(processedBet(overrides))).toEqual({
      kind: 'invalid',
      code: FailureCode.ReferenceMismatch,
    });
  });

  test('referência em outra moeda → CURRENCY_MISMATCH', () => {
    const bet = WagerTransaction.create({
      id: id(),
      providerId: 'provider-a',
      externalTransactionId: 'bet-usd',
      idempotencyKey: 'k',
      payloadHash: 'h',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'g',
      kind: Kind.Bet,
      money: usd('10.00'),
      createdAt: T0,
    });
    bet.markProcessed(undefined, usd('0.00'), T0);
    expect(wager(Kind.Refund, '10.00', ref('bet-usd')).checkReference(bet)).toMatchObject({
      code: FailureCode.CurrencyMismatch,
    });
  });

  test('reversão com valor diferente → AMOUNT_MISMATCH (sem reversão parcial)', () => {
    expect(wager(Kind.Refund, '5.00', ref('bet-1')).checkReference(processedBet())).toMatchObject({
      code: FailureCode.AmountMismatch,
    });
  });

  test('WIN pode ter valor diferente da BET referenciada', () => {
    expect(wager(Kind.Win, '50.00', ref('bet-1')).checkReference(processedBet())).toEqual({ kind: 'valid' });
  });

  test('referência ainda pendente → wait', () => {
    const bet = wager(Kind.Bet, '10.00');
    expect(wager(Kind.Refund, '10.00', ref('b')).checkReference(bet)).toEqual({ kind: 'wait' });
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const bet = wager(Kind.Bet, '10.00');
    bet.reject(FailureCode.InsufficientFunds, T0);
    expect(wager(Kind.Refund, '10.00', ref('b')).checkReference(bet)).toMatchObject({
      code: FailureCode.ReferenceNotProcessed,
    });
  });
});

describe('WagerTransaction.opening', () => {
  test('transação interna já nasce PROCESSED', () => {
    const tx = WagerTransaction.opening({
      id: id(),
      walletId: 'w1',
      playerId: 'p1',
      money: brl('1000.00'),
      at: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Processed);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});
