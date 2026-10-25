import { InvariantViolationError } from '../shared/domain-error';
import { Money } from '../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento no ledger (livro-razão). Registro contábil IMUTÁVEL:
 * só campos readonly, nenhum método que altere estado e instância congelada.
 * Correções acontecem com um NOVO lançamento (ex.: ROLLBACK), nunca editando.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Cria um lançamento novo validando a aritmética: before ± money === after. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter } = entry;

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvariantViolationError('Ledger entry with mixed currencies');
    }
    if (!money.isPositive()) {
      throw new InvariantViolationError(`Ledger entry amount must be positive, got ${money}`);
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger entry would leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${balanceBefore} ${entry.direction} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir do banco — não revalida (o banco já tem CHECK). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** O valor com sinal: DEBIT é negativo, CREDIT é positivo. */
  signedMoney(): Money {
    return this.direction === LedgerDirection.Debit ? this.money.negate() : this.money;
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedMoney()).equals(this.balanceAfter);
  }
}
