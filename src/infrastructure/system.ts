import type { Clock, IdGenerator } from '../application/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * UUIDv7: começa com o timestamp, então ids gerados depois são "maiores".
 * Fica ordenável por tempo e amigável ao índice B-tree (inserções no fim).
 */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
