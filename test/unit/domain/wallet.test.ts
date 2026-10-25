import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
} from '../../../src/domain/shared/domain-error';
import { Money } from '../../../src/domain/shared/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { PLAYER, T0, brl, id, openWallet, usd } from './fixtures';

const ctx = () => ({ entryId: id(), transactionId: id(), at: T0 });

/** Reconstrói o saldo somando os lançamentos — a invariante final do desafio. */
function balanceFromLedger(entries: WalletLedgerEntry[]): Money {
  return entries.reduce((sum, e) => sum.add(e.signedMoney()), Money.zero('BRL'));
}

describe('Wallet.open', () => {
  test('com saldo inicial: version 1 e lançamento CREDIT de abertura', () => {
    const opening = { transactionId: id(), entryId: id() };
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: PLAYER,
      initialBalance: brl('1000.00'),
      at: T0,
      opening,
    });

    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.balanceBefore.amount).toBe('0.00');
    expect(openingEntry!.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry!.transactionId).toBe(opening.transactionId);
  });

  test('com saldo zero: version 1 e nenhum lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: PLAYER,
      initialBalance: brl('0.00'),
      at: T0,
      opening: { transactionId: id(), entryId: id() },
    });
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('rejeita saldo inicial negativo', () => {
    expect(() =>
      Wallet.open({
        id: 'w1',
        playerId: PLAYER,
        initialBalance: brl('10.00').negate(),
        at: T0,
        opening: { transactionId: id(), entryId: id() },
      }),
    ).toThrow(InvalidAmountError);
  });
});

describe('Wallet.debit / credit', () => {
  test('debit reduz saldo, incrementa version e devolve o lançamento', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('25.00'), ctx());

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('75.00');
  });

  test('credit aumenta saldo e incrementa version', () => {
    const wallet = openWallet('100.00');
    wallet.credit(brl('50.00'), ctx());
    expect(wallet.balance.amount).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  test('pode debitar exatamente o saldo inteiro (fica 0.00)', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('100.00'), ctx());
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('saldo nunca negativo: debit acima do saldo lança e não altera nada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), ctx())).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('canDebit responde sem efeito colateral', () => {
    const wallet = openWallet('100.00');
    expect(wallet.canDebit(brl('100.00'))).toBe(true);
    expect(wallet.canDebit(brl('100.01'))).toBe(false);
    expect(wallet.version).toBe(1);
  });

  test('movimentação de valor zero é rejeitada (version só muda se saldo muda)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(brl('0.00'), ctx())).toThrow(InvalidAmountError);
    expect(wallet.version).toBe(1);
  });

  test('moeda diferente da wallet lança CurrencyMismatchError', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(usd('10.00'), ctx())).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd('10.00'), ctx())).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  test('apply escolhe debit ou credit pela direção', () => {
    const wallet = openWallet('100.00');
    wallet.apply(LedgerDirection.Debit, brl('30.00'), ctx());
    wallet.apply(LedgerDirection.Credit, brl('10.00'), ctx());
    expect(wallet.balance.amount).toBe('80.00');
  });

  test('cenário 100 → 80 + 80 (sequencial): só a primeira passa', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('80.00'), ctx());
    expect(() => wallet.debit(brl('80.00'), ctx())).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
  });
});

describe('Wallet — saldo == ledger reconstruído', () => {
  test('após uma sequência de movimentações', () => {
    const opening = { transactionId: id(), entryId: id() };
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: PLAYER,
      initialBalance: brl('100.00'),
      at: T0,
      opening,
    });
    const entries = [openingEntry!];
    entries.push(wallet.debit(brl('25.00'), ctx()));
    entries.push(wallet.credit(brl('60.50'), ctx()));
    entries.push(wallet.debit(brl('0.50'), ctx()));
    expect(() => wallet.debit(brl('1000.00'), ctx())).toThrow();

    expect(balanceFromLedger(entries).equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe('135.00');
    expect(wallet.version).toBe(4); // 1 + 3 movimentações bem-sucedidas
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado persistido como está', () => {
    const updatedAt = new Date('2026-02-01T00:00:00Z');
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: PLAYER,
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: T0,
      updatedAt,
    });
    expect(wallet.balance.amount).toBe('42.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toBe(updatedAt);
  });
});
