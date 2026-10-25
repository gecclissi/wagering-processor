import { FailureCode } from './failure-code';

/**
 * Erro de regra de domínio. Carrega um `code` estável, que as camadas de fora
 * traduzem para status HTTP / ack da fila sem precisar ler a mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly code: FailureCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidPayloadError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(reason: string) {
    super(`Invalid payload: ${reason}`);
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = FailureCode.InvalidAmount;

  constructor(reason: string) {
    super(`Invalid amount: ${reason}`);
  }
}

export class InvalidCurrencyError extends DomainError {
  readonly code = FailureCode.InvalidCurrency;

  constructor(currency: string) {
    super(`Invalid currency: "${currency}" is not an ISO-4217 code`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InvalidKindError extends DomainError {
  readonly code = FailureCode.InvalidKind;

  constructor(kind: string) {
    super(`Transaction kind "${kind}" cannot be submitted externally`);
  }
}

export class MissingReferenceError extends DomainError {
  readonly code = FailureCode.MissingReference;

  constructor(kind: string) {
    super(`${kind} requires referenceExternalTransactionId`);
  }
}

export class UnexpectedReferenceError extends DomainError {
  readonly code = FailureCode.UnexpectedReference;

  constructor(kind: string) {
    super(`${kind} must not carry referenceExternalTransactionId`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = FailureCode.InsufficientFunds;

  constructor(balance: string, requested: string) {
    super(`Insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

/**
 * Erro de PROGRAMAÇÃO, não de negócio: algo que o código nunca deveria tentar
 * (ex.: lançamento desbalanceado). Não tem failureCode porque não é resposta
 * para o provedor — indica bug e deve aparecer como 500.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Transição a partir de um estado terminal (PROCESSED/REJECTED/FAILED). */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(transactionId: string, from: string, to: string) {
    super(`Transaction ${transactionId} cannot go from ${from} to ${to}`);
  }
}
