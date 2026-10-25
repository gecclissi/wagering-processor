// Códigos estáveis e legíveis por máquina. O provedor decide pelo código
// (não pela mensagem) se reenvia, corrige o payload ou desiste.
// Ver DESIGN.md §9 para o mapeamento em status HTTP.
export const FailureCode = {
  // ---- Payload inválido → corrigir antes de reenviar
  InvalidPayload: 'INVALID_PAYLOAD',
  InvalidAmount: 'INVALID_AMOUNT',
  InvalidCurrency: 'INVALID_CURRENCY',
  InvalidKind: 'INVALID_KIND', // ex.: OPENING enviado de fora
  MissingReference: 'MISSING_REFERENCE', // REFUND/ROLLBACK sem referência
  UnexpectedReference: 'UNEXPECTED_REFERENCE', // BET com referência

  MissingIdempotencyKey: 'MISSING_IDEMPOTENCY_KEY',
  InvalidCursor: 'INVALID_CURSOR',

  // ---- Recurso / conflito → não reenviar igual
  WalletNotFound: 'WALLET_NOT_FOUND',
  TransactionNotFound: 'TRANSACTION_NOT_FOUND',
  WalletAlreadyExists: 'WALLET_ALREADY_EXISTS',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT', // mesma key (ou mesmo id externo) com payload diferente
  MessageIdConflict: 'MESSAGE_ID_CONFLICT', // mesmo messageId da fila com conteúdo diferente

  // ---- Regra de negócio → terminal, não adianta reenviar igual
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletMismatch: 'WALLET_MISMATCH', // player não é dono da wallet
  InsufficientFunds: 'INSUFFICIENT_FUNDS', // BET sem saldo
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS', // ROLLBACK que deixaria saldo negativo
  ReferenceNotFound: 'REFERENCE_NOT_FOUND', // referência nunca chegou (tentativas esgotadas)
  ReferenceMismatch: 'REFERENCE_MISMATCH', // provider/player/wallet/rodada diferentes
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND', // ex.: REFUND referenciando WIN
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED', // referência REJECTED/FAILED
  AmountMismatch: 'AMOUNT_MISMATCH', // reversão com valor diferente da referência
  AlreadyReversed: 'ALREADY_REVERSED',

  // ---- Falha permanente de infraestrutura → FAILED, auditável
  ProcessingFailed: 'PROCESSING_FAILED',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
