import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentLogContext } from './log-context';

const LEVELS: Record<string, number> = { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, verbose: 5 };

/**
 * Campos que NUNCA saem no log, mesmo se alguém passar por engano: valores
 * financeiros e payloads completos ficam no banco (auditável), não no log.
 * Ids (wallet, transação, mensagem) bastam para correlacionar.
 */
const REDACTED_KEYS = new Set([
  'amount',
  'money',
  'balance',
  'balancebefore',
  'balanceafter',
  'payload',
  'body',
  'data',
  'password',
  'token',
  'authorization',
  'secret',
]);

type Sink = (line: string) => void;

/**
 * Logger do Nest que escreve UMA linha JSON por evento:
 *   {"time":"…","level":"info","context":"SqsWagerConsumer","msg":"…","correlationId":"…","walletId":"…"}
 * Os campos de rastreio vêm do contexto assíncrono (log-context.ts).
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  constructor(
    level: string = 'info',
    private readonly sink: Sink = (line) => process.stdout.write(line + '\n'),
  ) {
    this.threshold = LEVELS[level] ?? LEVELS.info!;
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write('verbose', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }
  /** Nest chama error(message, stack?, context?). */
  error(message: unknown, ...params: unknown[]): void {
    const context = params.length > 0 && typeof params.at(-1) === 'string' ? (params.pop() as string) : undefined;
    const stack = typeof params[0] === 'string' ? params[0] : undefined;
    this.write('error', message, context ? [context] : [], stack);
  }

  setLogLevels?(_levels: LogLevel[]): void {}

  private write(level: string, message: unknown, params: unknown[], stack?: string): void {
    if ((LEVELS[level] ?? 0) > this.threshold) return;
    // Convenção do Nest: o último parâmetro string é o "context" (nome da classe).
    const context = typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;

    const fields = typeof message === 'object' && message !== null && !(message instanceof Error)
      ? redact(message as Record<string, unknown>)
      : { msg: message instanceof Error ? message.message : String(message) };

    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      ...(context ? { context } : {}),
      ...redact(currentLogContext()),
      ...fields,
      ...(stack ? { stack } : {}),
    };
    this.sink(JSON.stringify(line));
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}
