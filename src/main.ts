import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureHttpApp } from './bootstrap';
import { env } from './config/env';
import { JsonLogger } from './infrastructure/observability/json-logger';

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule.register({
      databaseUrl: env.databaseUrl,
      sqsConsumer: {
        enabled: env.sqs.consumerEnabled,
        queueName: env.sqs.wagerQueue,
        dlqName: env.sqs.wagerDlq,
      },
      workers: {
        enabled: env.workersEnabled,
        eventsQueueName: env.sqs.eventsQueue,
        outboxIdleMs: 500,
        pendingReferenceIdleMs: 1_000,
      },
    }),
    // Logs em JSON desde a primeira linha (bufferLogs segura os logs de boot).
    { logger: new JsonLogger(env.logLevel), bufferLogs: true },
  );
  configureHttpApp(app);
  // Faz o Nest reagir a SIGTERM/SIGINT fechando conexões com calma (graceful shutdown).
  app.enableShutdownHooks();
  await app.listen(env.port);
}

void bootstrap();
