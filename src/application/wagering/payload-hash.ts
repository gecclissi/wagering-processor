import { createHash } from 'node:crypto';
import type { Money } from '../../domain/shared/money';

/** Campos de negócio que definem "a mesma operação". Header e metadados de transporte ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 *
 * JSON canônico: chaves ordenadas em todos os níveis, sem espaços, campos
 * ausentes omitidos e `money` normalizado (escala 2) — "25" e "25.00" são o
 * mesmo payload. Assim a ordem das chaves no corpo da requisição não muda o hash.
 */
export function computePayloadHash(payload: WagerPayload): string {
  const business: Record<string, unknown> = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
  };
  if (payload.referenceExternalTransactionId !== undefined) {
    business.referenceExternalTransactionId = payload.referenceExternalTransactionId;
  }
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
