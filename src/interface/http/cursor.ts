import { DomainError } from '../../domain/shared/domain-error';
import { FailureCode } from '../../domain/shared/failure-code';

export class InvalidCursorError extends DomainError {
  readonly code = FailureCode.InvalidCursor;

  constructor() {
    super('cursor is invalid');
  }
}

// Cursor OPACO: o cliente só devolve o que recebeu. Por dentro é a posição
// (seq) do último lançamento visto, em base64url — podemos mudar o formato
// sem quebrar ninguém. Versionado ("v1") para permitir essa mudança.

export function encodeCursor(seq: string): string {
  return Buffer.from(`v1:${seq}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  const match = /^v1:(\d{1,19})$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!match?.[1]) throw new InvalidCursorError();
  return match[1];
}
