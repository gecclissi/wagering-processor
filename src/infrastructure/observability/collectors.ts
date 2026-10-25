import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { MetricsCollectors } from './metrics';

/** Fontes dos gauges calculados no scrape: outbox (banco) e DLQ (SQS). */
export function createCollectors(em: EntityManager, sqs: SQSClient, dlqName: string | undefined): MetricsCollectors {
  let dlqUrl: string | undefined;
  return {
    async outboxStats() {
      const [row] = await em.fork().execute<{ pending: number; lag: number }[]>(
        `select count(*)::int as pending,
                coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
           from outbox_messages where published_at is null`,
      );
      return { pending: row?.pending ?? 0, oldestPendingAgeSeconds: row?.lag ?? 0 };
    },
    dlqDepth: dlqName
      ? async () => {
          dlqUrl ??= (await sqs.send(new GetQueueUrlCommand({ QueueName: dlqName }))).QueueUrl;
          const { Attributes } = await sqs.send(
            new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
          );
          return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
        }
      : undefined,
  };
}
