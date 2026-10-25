import { describe, expect, test } from 'bun:test';
import { InvariantViolationError } from '../../../src/domain/shared/domain-error';
import {
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import { T0, brl, id, usd } from './fixtures';

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: id(),
  walletId: 'wallet-1',
  transactionId: id(),
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  createdAt: T0,
  ...overrides,
});

describe('WalletLedgerEntry.create — aritmética verificada', () => {
  test('DEBIT: 100.00 − 80.00 = 20.00', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedMoney().amount).toBe('-80.00');
  });

  test('CREDIT: 20.00 + 80.00 = 100.00', () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl('20.00'), balanceAfter: brl('100.00') }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedMoney().amount).toBe('80.00');
  });

  test('rejeita lançamento desbalanceado', () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl('21.00') }))).toThrow(
      InvariantViolationError,
    );
  });

  test('rejeita direção trocada (DEBIT que aumenta saldo)', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceBefore: brl('20.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvariantViolationError);
  });

  test('rejeita valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl('0'), balanceAfter: brl('100.00') })),
    ).toThrow(InvariantViolationError);
  });

  test('rejeita saldo resultante negativo', () => {
    const before = brl('10.00');
    expect(() =>
      WalletLedgerEntry.create(props({ balanceBefore: before, balanceAfter: before.subtract(brl('80.00')) })),
    ).toThrow(InvariantViolationError);
  });

  test('rejeita moedas misturadas', () => {
    expect(() => WalletLedgerEntry.create(props({ money: usd('80.00') }))).toThrow(InvariantViolationError);
  });
});

describe('WalletLedgerEntry — imutabilidade estrutural', () => {
  test('instância congelada: nenhuma propriedade pode ser alterada', () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: unknown }).balanceAfter = brl('999.00');
    }).toThrow();
    expect(entry.balanceAfter.amount).toBe('20.00');
  });

  test('rehydrate reconstrói sem revalidar', () => {
    const state = props();
    const entry = WalletLedgerEntry.rehydrate(state);
    expect(entry.id).toBe(state.id);
    expect(entry.balanceAfter.equals(state.balanceAfter)).toBe(true);
  });
});
