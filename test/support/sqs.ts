import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

// Filas REAIS no LocalStack, criadas por teste com nomes únicos.

export const sqs = new SQSClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  destroy(): Promise<void>;
}

export async function createTestQueues(maxReceiveCount = 3): Promise<TestQueues> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const { QueueUrl: dlqUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `test-dlq-${suffix}.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const { QueueUrl: queueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: `test-wager-${suffix}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount }),
      },
    }),
  );
  return {
    queueUrl: queueUrl!,
    dlqUrl: dlqUrl!,
    async destroy() {
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

/** Publica o envelope como um provedor faria. `deliveryId` diferente = SQS não deduplica. */
export async function sendMessage(queueUrl: string, body: unknown, groupId: string, deliveryId = crypto.randomUUID()) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: deliveryId,
    }),
  );
}

/** Lê o que estiver na fila agora (sem esperar), com atributos. */
export async function peek(queueUrl: string) {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return Messages;
}

export function wagerEnvelope(data: Record<string, unknown>, messageId = `msg-${crypto.randomUUID()}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data,
  };
}
