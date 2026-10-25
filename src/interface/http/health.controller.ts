import { Controller, Get, HttpCode, HttpStatus, Inject, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Response } from 'express';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs.client';
import { env } from '../../config/env';

type CheckResult = { ok: boolean; error?: string };

// Endpoints abertos (sem autenticação), conforme o desafio.
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /** Liveness: o processo está de pé. Não toca em dependências externas. */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. 503 se algum falhar. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const ok = postgres.ok && sqs.ok;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }

  private async checkPostgres(): Promise<CheckResult> {
    // Ida e volta real ao banco: a conexão do MikroORM é aberta sob demanda.
    try {
      await this.orm.em.getConnection().execute('select 1');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.name : 'unknown' };
    }
  }

  private async checkSqs(): Promise<CheckResult> {
    try {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: env.sqs.wagerQueue }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.name : 'unknown' };
    }
  }
}
