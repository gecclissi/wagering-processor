import { createHash } from 'node:crypto';
import { canonicalJson } from '../../application/wagering/payload-hash';
import type { SubmitWagerTransactionCommand } from '../../application/wagering/process-wager-transaction.use-case';
import { InvalidPayloadError } from '../../domain/shared/domain-error';
import { optionalString, requireMoney, requireObject, requireString } from '../validation';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export interface ParsedWagerMessage {
  messageId: string;
  /** Hash do envelope inteiro (JSON canônico): detecta messageId reaproveitado com outro conteúdo. */
  payloadHash: string;
  command: SubmitWagerTransactionCommand;
}

/**
 * Converte o corpo da mensagem SQS no MESMO comando que a entrada HTTP usa.
 *
 *   { messageId, type: "WagerTransactionRequested", occurredAt, data: { ...campos, idempotencyKey } }
 *
 * Lança InvalidPayloadError se o envelope não tiver o formato esperado.
 */
export function parseWagerMessage(rawBody: string | undefined): ParsedWagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody ?? '');
  } catch {
    throw new InvalidPayloadError('message body is not valid JSON');
  }

  const envelope = requireObject(parsed, 'message');
  const messageId = requireString(envelope, 'messageId');
  const type = requireString(envelope, 'type');
  if (type !== WAGER_MESSAGE_TYPE) throw new InvalidPayloadError(`unsupported message type "${type}"`);

  const data = requireObject(envelope.data, 'data');
  return {
    messageId,
    payloadHash: createHash('sha256').update(canonicalJson(envelope)).digest('hex'),
    command: {
      idempotencyKey: requireString(data, 'idempotencyKey'),
      providerId: requireString(data, 'providerId'),
      externalTransactionId: requireString(data, 'externalTransactionId'),
      playerId: requireString(data, 'playerId'),
      walletId: requireString(data, 'walletId'),
      roundId: requireString(data, 'roundId'),
      gameId: requireString(data, 'gameId'),
      kind: requireString(data, 'kind'),
      money: requireMoney(data, 'money'),
      referenceExternalTransactionId: optionalString(data, 'referenceExternalTransactionId'),
    },
  };
}
