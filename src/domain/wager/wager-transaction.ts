import { exponentialBackoffMs, type BackoffPolicy } from '../shared/backoff';
import {
  InvalidAmountError,
  InvalidKindError,
  InvalidPayloadError,
  InvalidTransactionStateError,
  InvariantViolationError,
  MissingReferenceError,
  UnexpectedReferenceError,
} from '../shared/domain-error';
import { FailureCode } from '../shared/failure-code';
import { Money } from '../shared/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

const TERMINAL = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Que kinds cada operação pode referenciar. Ausente no mapa = não aceita referência. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/**
 * Política para referências fora de ordem: 1s, 2s, 4s ... até 5 min entre
 * tentativas, no máximo 10 tentativas (~13 min no total). Provedores costumam
 * entregar a referência em segundos; se em ~13 min não chegou, desistimos.
 */
export const REFERENCE_RETRY_POLICY: BackoffPolicy & { maxAttempts: number } = {
  baseMs: 1_000,
  maxMs: 5 * 60_000,
  maxAttempts: 10,
};

/** Resultado da validação de uma referência encontrada. */
export type ReferenceCheck =
  | { kind: 'valid' }
  | { kind: 'wait' } // referência existe mas ainda não foi processada
  | { kind: 'invalid'; code: FailureCode };

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  resultingBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    /** Momento em que a transação atingiu um estado terminal. */
    private _processedAt: Date | undefined,
    /** Saldo observado ao finalizar — devolvido em replays idempotentes. */
    private _resultingBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Entrada externa (HTTP/SQS). Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) throw new InvalidKindError(props.kind);
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidKindError(String(props.kind));
    }
    WagerTransaction.assertRequired(props);

    const reference = props.referenceExternalTransactionId?.trim() || undefined;
    const tx = WagerTransaction.newPending({ ...props, referenceExternalTransactionId: reference });

    if (tx.requiresReference() && reference === undefined) throw new MissingReferenceError(tx.kind);
    if (reference !== undefined && !ALLOWED_REFERENCE_KINDS[tx.kind]) {
      throw new UnexpectedReferenceError(tx.kind);
    }
    // LOSS pode vir com 0.00 (só registra o resultado); o resto precisa mover dinheiro.
    const amountOk = tx.kind === WagerTransactionKind.Loss ? !tx.money.isNegative() : tx.money.isPositive();
    if (!amountOk) throw new InvalidAmountError(`${tx.kind} amount must be positive`);

    return tx;
  }

  /** Transação interna de abertura de wallet. Já nasce PROCESSED. */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    const key = `internal:opening:${props.walletId}`;
    const tx = WagerTransaction.newPending({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: key,
      payloadHash: key,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
    });
    tx.markProcessed(undefined, props.money, props.at);
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static newPending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private static assertRequired(props: CreateWagerTransactionProps): void {
    const fields = [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const;
    for (const field of fields) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidPayloadError(`${field} is required`);
      }
    }
  }

  // ---- getters

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições
  //
  //   PENDING ───────────┬──► PROCESSED  (terminal)
  //      │               ├──► REJECTED   (terminal)
  //      ▼               └──► FAILED     (terminal)
  //   PENDING_REFERENCE ─┘
  //      ▲  │
  //      └──┘ nova tentativa (attempts++)

  markProcessed(referenceTransactionId: string | undefined, resultingBalance: Money, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Processed);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Referência ainda não existe: agenda nova tentativa com backoff exponencial. */
  markPendingReference(at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.PendingReference);
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    const delay = exponentialBackoffMs(this._referenceAttempts, REFERENCE_RETRY_POLICY);
    this._nextReferenceAttemptAt = new Date(at.getTime() + delay);
  }

  reject(code: FailureCode, at: Date, resultingBalance?: Money): void {
    this.assertNotTerminal(WagerTransactionStatus.Rejected);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = resultingBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal(WagerTransactionStatus.Failed);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts >= REFERENCE_RETRY_POLICY.maxAttempts;
  }

  isDueForReferenceRetry(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      this._nextReferenceAttemptAt.getTime() <= now.getTime()
    );
  }

  /** Direção no ledger. ROLLBACK é o inverso da direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvariantViolationError('ROLLBACK direction needs its reference');
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not move balance');
    }
  }

  /**
   * Valida uma referência JÁ ENCONTRADA (a busca por
   * providerId + referenceExternalTransactionId é da camada de aplicação).
   */
  checkReference(reference: WagerTransaction): ReferenceCheck {
    const allowed = ALLOWED_REFERENCE_KINDS[this.kind] ?? [];
    if (!allowed.includes(reference.kind)) {
      return { kind: 'invalid', code: FailureCode.InvalidReferenceKind };
    }
    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId;
    if (!sameContext) return { kind: 'invalid', code: FailureCode.ReferenceMismatch };
    if (reference.money.currency !== this.money.currency) {
      return { kind: 'invalid', code: FailureCode.CurrencyMismatch };
    }
    // Reversão parcial está fora de escopo: valor tem que ser igual.
    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { kind: 'invalid', code: FailureCode.AmountMismatch };
    }

    switch (reference.status) {
      case WagerTransactionStatus.Processed:
        return { kind: 'valid' };
      case WagerTransactionStatus.Pending:
      case WagerTransactionStatus.PendingReference:
        return { kind: 'wait' };
      case WagerTransactionStatus.Rejected:
      case WagerTransactionStatus.Failed:
        return { kind: 'invalid', code: FailureCode.ReferenceNotProcessed };
    }
  }

  private assertNotTerminal(to: WagerTransactionStatus): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this.id, this._status, to);
  }
}
