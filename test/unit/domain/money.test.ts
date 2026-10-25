import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/shared/money';
import {
  CurrencyMismatchError,
  InvalidAmountError,
  InvalidCurrencyError,
} from '../../../src/domain/shared/domain-error';
import { FailureCode } from '../../../src/domain/shared/failure-code';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money.from — validação de entrada', () => {
  test.each([
    ['25.00', '25.00'],
    ['25.5', '25.50'],
    ['25', '25.00'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999.99', '999999999999.99'],
  ])('aceita "%s" e serializa com escala 2 como "%s"', (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test.each([
    ['', 'string vazia'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['1e3', 'notação científica'],
    ['1E-2', 'notação científica'],
    ['10.005', 'mais de 2 casas (não arredonda em silêncio)'],
    ['0.001', 'mais de 2 casas'],
    ['-5.00', 'negativo no contrato de entrada'],
    ['+5.00', 'sinal explícito'],
    [' 5.00', 'espaço'],
    ['5,00', 'vírgula'],
    ['05.00', 'zero à esquerda'],
    ['5.', 'ponto sem casas'],
    ['.50', 'sem parte inteira'],
    ['0x10', 'hexadecimal'],
  ])('rejeita "%s" (%s)', (input) => {
    expect(() => brl(input)).toThrow(InvalidAmountError);
  });

  test('rejeita amount que não é string (ex.: number vindo de JSON)', () => {
    const props = { amount: 25 as unknown as string, currency: 'BRL' };
    expect(() => Money.from(props)).toThrow(InvalidAmountError);
  });

  test.each(['', 'brl', 'BR', 'BRLX', 'R$'])('rejeita moeda inválida "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidCurrencyError);
  });

  test('o erro carrega um failureCode estável', () => {
    try {
      brl('abc');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as InvalidAmountError).code).toBe(FailureCode.InvalidAmount);
    }
  });
});

describe('Money — aritmética exata', () => {
  test('0.10 + 0.20 é exatamente 0.30 (com number seria 0.30000000000000004)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('somar 0.01 mil vezes dá exatamente 10.00', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('valores grandes não perdem precisão', () => {
    // 2^53 ≈ 9007199254740992: acima disso number perde centavos.
    expect(brl('9007199254740993.99').add(brl('0.01')).amount).toBe('9007199254740994.00');
  });

  test('subtract pode gerar valor negativo (o domínio decide se aceita)', () => {
    const result = brl('20.00').subtract(brl('80.00'));
    expect(result.amount).toBe('-60.00');
    expect(result.isNegative()).toBe(true);
  });

  test('negate inverte o sinal', () => {
    expect(brl('25.00').negate().amount).toBe('-25.00');
    expect(brl('25.00').negate().negate().amount).toBe('25.00');
  });

  test('negate de zero não vira "-0.00"', () => {
    expect(Money.zero('BRL').negate().amount).toBe('0.00');
    expect(brl('5.00').subtract(brl('5.00')).negate().amount).toBe('0.00');
  });
});

describe('Money — imutabilidade', () => {
  test('operações devolvem nova instância e não alteram a original', () => {
    const original = brl('100.00');
    const result = original.subtract(brl('80.00'));
    expect(original.amount).toBe('100.00');
    expect(result.amount).toBe('20.00');
    expect(result).not.toBe(original);
  });

  test('a instância é congelada', () => {
    const money = brl('1.00');
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = 'USD';
    }).toThrow();
  });
});

describe('Money — consultas', () => {
  test('isZero / isPositive / isNegative', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
  });

  test('isLessThan', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('100.00').isLessThan(brl('80.00'))).toBe(false);
  });

  test('equals compara valor e moeda, independente da escala de entrada', () => {
    expect(brl('25').equals(brl('25.00'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
    expect(brl('25.00').equals(usd('25.00'))).toBe(false);
  });
});

describe('Money — conflito de moeda', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s entre BRL e USD lança CurrencyMismatchError', (_name, operation) => {
    expect(() => operation(brl('10.00'), usd('10.00'))).toThrow(CurrencyMismatchError);
  });

  test('o erro de moeda carrega CURRENCY_MISMATCH', () => {
    try {
      brl('1.00').add(usd('1.00'));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as CurrencyMismatchError).code).toBe(FailureCode.CurrencyMismatch);
    }
  });
});

describe('Money — serialização', () => {
  test('toJSON devolve o contrato com string decimal de 2 casas', () => {
    expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test('ida e volta pelo contrato preserva o valor', () => {
    const original = brl('1234.56');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });

  test('toString é legível', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
