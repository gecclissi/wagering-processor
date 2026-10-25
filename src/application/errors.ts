import { DomainError } from '../domain/shared/domain-error';
import { FailureCode } from '../domain/shared/failure-code';

export class WalletNotFoundError extends DomainError {
  readonly code = FailureCode.WalletNotFound;

  constructor(walletId: string) {
    super(`Wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends DomainError {
  readonly code = FailureCode.TransactionNotFound;

  constructor(reference: string) {
    super(`Transaction ${reference} not found`);
  }
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = FailureCode.WalletAlreadyExists;

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

/** Mesma idempotency key (ou mesmo id externo do provedor) com payload diferente. NÃO é replay. */
export class IdempotencyConflictError extends DomainError {
  readonly code = FailureCode.IdempotencyConflict;

  constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

/**
 * Sinal interno dos repositórios: o INSERT bateu numa UNIQUE de idempotência
 * (idempotency_key ou provider + id externo). Uma requisição gêmea venceu a corrida.
 * O use case trata relendo a transação vencedora.
 */
export class DuplicateTransactionError extends Error {
  constructor() {
    super('A transaction with the same idempotency key or external id already exists');
    this.name = new.target.name;
  }
}

/**
 * Falha transitória: o banco recusou por concorrência/indisponibilidade
 * (lock_timeout, version divergente, conexão). Seguro tentar de novo.
 */
export class TransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
