import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule.register({
      databaseUrl: env.databaseUrl,
      sqsConsumer: {
        enabled: env.sqs.consumerEnabled,
        queueName: env.sqs.wagerQueue,
        dlqName: env.sqs.wagerDlq,
      },
    }),
  );
  // Faz o Nest reagir a SIGTERM/SIGINT fechando conexões com calma (graceful shutdown).
  app.enableShutdownHooks();
  await app.listen(env.port);
  console.log(`Wagering processor listening on :${env.port}`);
}

void bootstrap();
