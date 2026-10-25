import { HttpStatus } from '@nestjs/common';
import { FailureCode } from '../../domain/shared/failure-code';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction';

/**
 * UMA tabela decide o status HTTP de cada failureCode — usada por TODOS os
 * endpoints. O provedor decide pelo status (pode reenviar?) e pelo code (o quê
 * corrigir), sem interpretar mensagens.
 *
 *   400  payload inválido          → corrija antes de reenviar
 *   404  recurso não existe        → corrija a referência
 *   409  conflito                  → não reenvie igual (key já usada com outro payload)
 *   422  rejeição por regra        → terminal; reenviar devolve a mesma rejeição
 *   202  aceita, pendente          → aguarde (referência ainda não chegou)
 *   503  falha transitória         → reenvie depois, com o MESMO Idempotency-Key
 *   500  bug                       → nosso problema
 */
const STATUS_BY_CODE: Record<FailureCode, HttpStatus> = {
  [FailureCode.InvalidPayload]: HttpStatus.BAD_REQUEST,
  [FailureCode.InvalidAmount]: HttpStatus.BAD_REQUEST,
  [FailureCode.InvalidCurrency]: HttpStatus.BAD_REQUEST,
  [FailureCode.InvalidKind]: HttpStatus.BAD_REQUEST,
  [FailureCode.MissingReference]: HttpStatus.BAD_REQUEST,
  [FailureCode.UnexpectedReference]: HttpStatus.BAD_REQUEST,
  [FailureCode.MissingIdempotencyKey]: HttpStatus.BAD_REQUEST,
  [FailureCode.InvalidCursor]: HttpStatus.BAD_REQUEST,

  [FailureCode.WalletNotFound]: HttpStatus.NOT_FOUND,
  [FailureCode.TransactionNotFound]: HttpStatus.NOT_FOUND,

  [FailureCode.WalletAlreadyExists]: HttpStatus.CONFLICT,
  [FailureCode.IdempotencyConflict]: HttpStatus.CONFLICT,

  [FailureCode.CurrencyMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.WalletMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.InsufficientFunds]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.ReversalInsufficientFunds]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.ReferenceNotFound]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.ReferenceMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.InvalidReferenceKind]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.ReferenceNotProcessed]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.AmountMismatch]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.AlreadyReversed]: HttpStatus.UNPROCESSABLE_ENTITY,

  [FailureCode.ProcessingFailed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export function statusForCode(code: FailureCode): HttpStatus {
  return STATUS_BY_CODE[code];
}

/**
 * Status HTTP do RESULTADO de uma transação (sucesso ou rejeição registrada).
 * Replay devolve o mesmo status da primeira resposta: para o provedor, a
 * segunda chamada é indistinguível da primeira (fora `idempotentReplay`).
 */
export function statusForTransaction(status: WagerTransactionStatus): HttpStatus {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
