import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { TransientError } from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';
import { Metrics } from '../../infrastructure/observability/metrics';
import { statusForCode } from './error-mapping';

/** Formato único de erro em toda a API. */
export interface ErrorBody {
  error: { code: string; message: string };
}

const RETRY_AFTER_SECONDS = 1;

/**
 * Traduz QUALQUER erro em resposta HTTP. Os controllers não têm try/catch:
 * lançam e este filtro decide o status pela tabela de error-mapping.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  constructor(private readonly metrics: Metrics) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(error);
    this.metrics.errors.inc({ code: body.error.code, source: 'http' });
    if (error instanceof TransientError) this.metrics.transient('http', error.reason);
    if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(status).json(body);
  }

  private toResponse(error: unknown): { status: number; body: ErrorBody } {
    // Erro de domínio/aplicação: o failureCode decide o status.
    if (error instanceof DomainError) {
      return { status: statusForCode(error.code), body: this.body(error.code, error.message) };
    }
    // Banco ocupado/indisponível: seguro reenviar com a MESMA Idempotency-Key.
    if (error instanceof TransientError) {
      this.logger.warn({ msg: 'transient failure', reason: error.reason, error: error.message });
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        body: this.body('TEMPORARILY_UNAVAILABLE', 'Temporary failure, retry with the same Idempotency-Key'),
      };
    }
    // Erros do próprio Nest/Express: JSON malformado (400), rota inexistente (404)...
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const code = status === HttpStatus.BAD_REQUEST ? 'INVALID_PAYLOAD' : HttpStatus[status] ?? 'HTTP_ERROR';
      return { status, body: this.body(code, error.message) };
    }
    // Qualquer outra coisa é bug (inclui InvariantViolationError). Detalhes só no log.
    this.logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: this.body('INTERNAL_ERROR', 'Unexpected error'),
    };
  }

  private body(code: string, message: string): ErrorBody {
    return { error: { code, message } };
  }
}
