import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  InvalidPayloadError,
} from '../shared/domain-error';
import { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dados que o chamador fornece para cada movimentação (ids e relógio vêm de fora). */
export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Usado só se initialBalance > 0: ids da transação OPENING e do lançamento. */
  opening: { transactionId: string; entryId: string };
}

export interface WalletOpening {
  wallet: Wallet;
  /** Presente apenas quando o saldo inicial é maior que zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate Root. Único lugar do sistema que altera saldo — e sempre devolve
 * o lançamento de ledger correspondente, então saldo e ledger andam juntos.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): WalletOpening {
    if (props.playerId.trim() === '') throw new InvalidPayloadError('playerId is required');
    if (props.initialBalance.isNegative()) {
      throw new InvalidAmountError('initial balance cannot be negative');
    }

    const { currency } = props.initialBalance;
    const zero = Money.zero(currency);

    if (props.initialBalance.isZero()) {
      return {
        wallet: new Wallet(props.id, props.playerId, currency, zero, 1, props.at, props.at),
        openingEntry: undefined,
      };
    }

    // O lançamento de abertura vai de 0 → saldo inicial. A version nasce em 1
    // (regra do desafio): abrir a wallet já com saldo é UM evento, não dois.
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: props.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: zero,
      balanceAfter: props.initialBalance,
      createdAt: props.at,
    });
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Consulta sem efeito: há saldo para debitar `money`? */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this._balance.amount, money.amount);
    }
    return this.move(LedgerDirection.Debit, money, ctx);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertSameCurrency(money);
    return this.move(LedgerDirection.Credit, money, ctx);
  }

  /** Atalho para quando a direção é calculada (ex.: ROLLBACK inverte a referência). */
  apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(money, ctx) : this.credit(money, ctx);
  }

  private move(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    if (!money.isPositive()) {
      throw new InvalidAmountError(`movement must be positive, got ${money.amount}`);
    }
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(money) : before.add(money);

    // Cria o lançamento ANTES de mudar o estado: se a validação falhar,
    // a wallet fica intacta.
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: ctx.at,
    });

    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
