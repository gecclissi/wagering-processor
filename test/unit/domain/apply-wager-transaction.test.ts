import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { applyWagerTransaction, type ApplyWagerInput } from '../../../src/domain/wager/apply-wager-transaction';
import {
  REFERENCE_RETRY_POLICY,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from '../../../src/domain/wager/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { T0, id, openWallet, usd, wager } from './fixtures';

function apply(
  transaction: WagerTransaction,
  wallet: Wallet,
  extra: Partial<Omit<ApplyWagerInput, 'transaction' | 'wallet'>> = {},
) {
  return applyWagerTransaction({
    transaction,
    wallet,
    reference: undefined,
    referenceAlreadyReversed: false,
    entryId: id(),
    at: T0,
    ...extra,
  });
}

/** BET processada na wallet, pronta para ser referenciada. */
function placeBet(wallet: Wallet, amount: string, externalTransactionId = 'bet-1') {
  const bet = wager(Kind.Bet, amount, { externalTransactionId });
  apply(bet, wallet);
  expect(bet.status).toBe(Status.Processed);
  return bet;
}

describe('BET', () => {
  test('debita, gera 1 lançamento DEBIT e guarda o saldo resultante', () => {
    const wallet = openWallet('100.00');
    const bet = wager(Kind.Bet, '25.00');
    const entry = apply(bet, wallet);

    expect(bet.status).toBe(Status.Processed);
    expect(bet.resultingBalance?.amount).toBe('75.00');
    expect(wallet.balance.amount).toBe('75.00');
    expect(entry?.direction).toBe(LedgerDirection.Debit);
  });

  test('sem saldo → REJECTED / INSUFFICIENT_FUNDS, sem lançamento e saldo intacto', () => {
    const wallet = openWallet('10.00');
    const bet = wager(Kind.Bet, '25.00');
    const entry = apply(bet, wallet);

    expect(bet.status).toBe(Status.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(entry).toBeUndefined();
    expect(wallet.balance.amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('cenário obrigatório (lógica): 100.00 e duas BETs de 80.00', () => {
    const wallet = openWallet('100.00');
    const first = wager(Kind.Bet, '80.00');
    const second = wager(Kind.Bet, '80.00');
    const entries = [apply(first, wallet), apply(second, wallet)].filter(Boolean);

    expect(first.status).toBe(Status.Processed);
    expect(second.status).toBe(Status.Rejected);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe('20.00');
    expect(entries).toHaveLength(1);
  });

  test('player que não é dono da wallet → WALLET_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = wager(Kind.Bet, '10.00', { playerId: 'intruder' });
    apply(bet, wallet);
    expect(bet.failureCode).toBe(FailureCode.WalletMismatch);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('moeda diferente da wallet → CURRENCY_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = wager(Kind.Bet, '10.00', { money: usd('10.00') });
    apply(bet, wallet);
    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(wallet.balance.amount).toBe('100.00');
  });
});

describe('WIN', () => {
  test('credita sem referência', () => {
    const wallet = openWallet('100.00');
    const win = wager(Kind.Win, '50.00');
    const entry = apply(win, wallet);
    expect(win.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('150.00');
  });

  test('credita com referência à BET da rodada e grava o id interno dela', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '10.00');
    const win = wager(Kind.Win, '30.00', { referenceExternalTransactionId: 'bet-1' });
    apply(win, wallet, { reference: bet });
    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('120.00');
  });
});

describe('LOSS', () => {
  test('PROCESSED sem mexer no saldo e sem lançamento', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '10.00');
    const loss = wager(Kind.Loss, '0.00', { referenceExternalTransactionId: 'bet-1' });
    const entry = apply(loss, wallet, { reference: bet });

    expect(loss.status).toBe(Status.Processed);
    expect(entry).toBeUndefined();
    expect(wallet.balance.amount).toBe('90.00');
    expect(wallet.version).toBe(2); // só a BET mudou o saldo
    expect(loss.resultingBalance?.amount).toBe('90.00');
  });
});

describe('REFUND', () => {
  test('devolve o valor da BET processada', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00');
    const refund = wager(Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    const entry = apply(refund, wallet, { reference: bet });

    expect(refund.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('segunda vez sobre a mesma BET → ALREADY_REVERSED', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00');
    const refund = wager(Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    apply(refund, wallet, { reference: bet, referenceAlreadyReversed: true });

    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(wallet.balance.amount).toBe('60.00');
  });

  test('valor diferente da BET → AMOUNT_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00');
    const refund = wager(Kind.Refund, '39.99', { referenceExternalTransactionId: 'bet-1' });
    apply(refund, wallet, { reference: bet });
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });
});

describe('ROLLBACK', () => {
  test('de BET: credita de volta', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00');
    const rollback = wager(Kind.Rollback, '40.00', { referenceExternalTransactionId: 'bet-1' });
    const entry = apply(rollback, wallet, { reference: bet });

    expect(rollback.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('de WIN: debita o prêmio', () => {
    const wallet = openWallet('100.00');
    const win = wager(Kind.Win, '30.00', { externalTransactionId: 'win-1' });
    apply(win, wallet);
    const rollback = wager(Kind.Rollback, '30.00', { referenceExternalTransactionId: 'win-1' });
    const entry = apply(rollback, wallet, { reference: win });

    expect(rollback.status).toBe(Status.Processed);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS (código diferente da BET)', () => {
    const wallet = openWallet('0.00');
    const win = wager(Kind.Win, '30.00', { externalTransactionId: 'win-1' });
    apply(win, wallet);
    placeBet(wallet, '25.00', 'bet-2'); // jogador gastou o prêmio: sobra 5.00

    const rollback = wager(Kind.Rollback, '30.00', { referenceExternalTransactionId: 'win-1' });
    const entry = apply(rollback, wallet, { reference: win });

    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(entry).toBeUndefined();
    expect(wallet.balance.amount).toBe('5.00');
  });
});

describe('Referência fora de ordem', () => {
  test('referência ausente → PENDING_REFERENCE, sem tocar no saldo', () => {
    const wallet = openWallet('100.00');
    const refund = wager(Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-late' });
    const entry = apply(refund, wallet, { reference: undefined });

    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(1);
    expect(entry).toBeUndefined();
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('a referência chega depois → reprocessa e fica PROCESSED', () => {
    const wallet = openWallet('100.00');
    const rollback = wager(Kind.Rollback, '40.00', { referenceExternalTransactionId: 'bet-late' });
    apply(rollback, wallet, { reference: undefined });
    expect(rollback.status).toBe(Status.PendingReference);

    const bet = placeBet(wallet, '40.00', 'bet-late');
    apply(rollback, wallet, { reference: bet });
    expect(rollback.status).toBe(Status.Processed);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('tentativas esgotadas → REJECTED / REFERENCE_NOT_FOUND', () => {
    const wallet = openWallet('100.00');
    const refund = wager(Kind.Refund, '40.00', { referenceExternalTransactionId: 'never' });
    for (let i = 0; i < REFERENCE_RETRY_POLICY.maxAttempts; i++) apply(refund, wallet);
    expect(refund.status).toBe(Status.PendingReference);

    apply(refund, wallet);
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test('referência existe mas ainda está pendente → espera também', () => {
    const wallet = openWallet('100.00');
    const pendingBet = wager(Kind.Bet, '40.00', { externalTransactionId: 'bet-1' });
    const refund = wager(Kind.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    apply(refund, wallet, { reference: pendingBet });
    expect(refund.status).toBe(Status.PendingReference);
  });
});

describe('Guardas de programação', () => {
  test('aplicar transação já terminal é erro', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '10.00');
    expect(() => apply(bet, wallet)).toThrow();
  });

  test('wallet errada carregada para a transação é erro', () => {
    const wallet = openWallet('100.00', 'other-wallet');
    expect(() => apply(wager(Kind.Bet, '10.00'), wallet)).toThrow();
  });
});
