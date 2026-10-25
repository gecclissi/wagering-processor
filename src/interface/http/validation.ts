import { InvalidPayloadError } from '../../domain/shared/domain-error';
import type { MoneyProps } from '../../domain/shared/money';

// Validação de FORMA do JSON (tipos e campos obrigatórios). As regras de
// conteúdo (escala do dinheiro, kind válido, referência obrigatória...) são do
// domínio — aqui só garantimos que dá para construir o comando.

type Json = Record<string, unknown>;

export function requireObject(value: unknown, name = 'body'): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPayloadError(`${name} must be a JSON object`);
  }
  return value as Json;
}

export function requireString(obj: Json, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidPayloadError(`${field} must be a non-empty string`);
  }
  return value;
}

export function optionalString(obj: Json, field: string): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new InvalidPayloadError(`${field} must be a string`);
  return value;
}

/** `{ amount, currency }` com os dois campos string. O formato do valor é validado pelo Money. */
export function requireMoney(obj: Json, field: string): MoneyProps {
  const money = requireObject(obj[field], field);
  if (typeof money.amount !== 'string') {
    // Rejeita explicitamente number: 25.1 em JSON já é float e pode ter perdido precisão.
    throw new InvalidPayloadError(`${field}.amount must be a decimal string, e.g. "25.00"`);
  }
  if (typeof money.currency !== 'string') {
    throw new InvalidPayloadError(`${field}.currency must be a string`);
  }
  return { amount: money.amount, currency: money.currency };
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidPayloadError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}
