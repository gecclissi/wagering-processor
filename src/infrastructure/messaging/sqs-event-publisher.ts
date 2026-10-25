import { GetQueueUrlCommand, SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** Até 10 mensagens por chamada (limite do SendMessageBatch). */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    /** Resolvido na primeira publicação: o app sobe mesmo com o SQS fora (a outbox acumula). */
    private readonly queue: { url: string } | { name: string },
  ) {}

  private async resolveUrl(): Promise<string> {
    if (this.queueUrl) return this.queueUrl;
    if ('url' in this.queue) return (this.queueUrl = this.queue.url);
    const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queue.name }));
    if (!QueueUrl) throw new Error(`Queue ${this.queue.name} not found`);
    return (this.queueUrl = QueueUrl);
  }

  async publish(messages: OutboxMessage[]): Promise<{ failedIds: Set<string> }> {
    const queueUrl = await this.resolveUrl();
    const failedIds = new Set<string>();
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      const result = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            // Ordem por wallet no consumidor (FIFO por grupo).
            MessageGroupId: message.aggregateId,
            // Publicação repetida do mesmo evento (crash antes de marcar) é
            // descartada pelo SQS FIFO dentro da janela de 5 min; fora dela, o
            // consumidor deduplica pelo eventId.
            MessageDeduplicationId: message.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
          })),
        }),
      );
      for (const failure of result.Failed ?? []) {
        const message = chunk[Number(failure.Id)];
        if (message) failedIds.add(message.id);
      }
    }
    return { failedIds };
  }
}
