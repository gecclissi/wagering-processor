import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { Clock } from '../../application/ports';
import type { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import type { Metrics } from '../../infrastructure/observability/metrics';
import { SqsWagerConsumer } from './sqs-wager-consumer';

export interface SqsConsumerServiceOptions {
  enabled: boolean;
  queueName: string;
  dlqName: string;
}

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

/**
 * Liga o consumer ao ciclo de vida do Nest:
 *   - sobe junto com a aplicação;
 *   - no SIGTERM, `beforeApplicationShutdown` roda ANTES de o MikroORM fechar
 *     as conexões — as mensagens em andamento ainda conseguem commitar.
 */
export class SqsConsumerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: SqsWagerConsumer | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly options: SqsConsumerServiceOptions,
    private readonly metrics: Metrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.enabled) return;
    const [queueUrl, dlqUrl] = await Promise.all([
      this.queueUrl(this.options.queueName),
      this.queueUrl(this.options.dlqName),
    ]);
    this.consumer = new SqsWagerConsumer(this.sqs, this.processWager, this.clock, {
      queueUrl,
      dlqUrl,
      consumerName: WAGER_CONSUMER_NAME,
      waitTimeSeconds: 10,
      maxMessages: 10,
      retryBaseSeconds: 2,
      retryMaxSeconds: 60,
      shutdownTimeoutMs: 10_000,
    }, this.metrics);
    this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
  }

  private async queueUrl(name: string): Promise<string> {
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!QueueUrl) throw new Error(`Queue ${name} not found`);
    return QueueUrl;
  }
}
