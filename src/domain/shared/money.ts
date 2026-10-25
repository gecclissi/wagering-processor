import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidAmountError, InvalidCurrencyError } from './domain-error';

/** Formato de contrato (JSON/DTO). `amount` é sempre string decimal com 2 casas. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;

// Cópia isolada do Decimal: não altera a configuração global da biblioteca.
// Precisão de sobra para somas de valores com 2 casas; nunca há arredondamento
// porque soma/subtração de valores com 2 casas resulta sempre em 2 casas.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

// Contrato de entrada: só dígitos, sem sinal, sem zeros à esquerda,
// no máximo 2 casas. Rejeita "", "NaN", "Infinity", "1e3", "-5", " 5", "05".
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value Object de dinheiro: imutável, exato (sem `number`) e com moeda.
 * Toda operação devolve uma nova instância.
 */
export class Money {
  private readonly value: Decimal;

  private constructor(
    value: Decimal,
    public readonly currency: string,
  ) {
    // Normaliza -0 para 0: senão "0.00".negate() viraria "-0.00".
    this.value = value.isZero() ? new D(0) : value;
    Object.freeze(this);
  }

  /** Cria a partir do contrato externo. Valores negativos não são aceitos aqui. */
  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidAmountError(
        `"${String(props.amount)}" must be a non-negative decimal string with at most ${SCALE} decimal places`,
      );
    }
    return new Money(new D(props.amount), Money.validCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new D(0), Money.validCurrency(currency));
  }

  // ---- aritmética (sempre retorna nova instância)

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  // ---- consultas

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Moedas diferentes não são "iguais" — comparar não é erro, operar é. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  // ---- serialização

  /** String decimal com escala fixa de 2 casas, ex.: "25.00", "-80.00". */
  get amount(): string {
    return this.value.toFixed(SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  // ---- internos

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validCurrency(currency: string): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidCurrencyError(String(currency));
    }
    return currency;
  }
}
