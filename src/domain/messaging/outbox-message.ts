import type { IntegrationEvent } from '../events/integration-event';
import { exponentialBackoffMs, type BackoffPolicy } from '../shared/backoff';
import { InvariantViolationError } from '../shared/domain-error';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | undefined;
  publishedAt: Date | undefined;
}

/**
 * Publicação: 1s, 2s, 4s ... até 1 min entre tentativas, SEM limite de
 * tentativas — evento confirmado nunca é descartado. O lag aparece em métrica.
 */
export const OUTBOX_RETRY_POLICY: BackoffPolicy = { baseMs: 1_000, maxMs: 60_000 };

/**
 * Evento esperando publicação. Gravado na MESMA transação do efeito que o
 * gerou; um worker publica depois do commit. id = eventId (dedup no destino).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt, // elegível imediatamente
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    this._attempts += 1;
    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). */
  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + exponentialBackoffMs(this._attempts, OUTBOX_RETRY_POLICY));
  }
}
