import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { TransientError } from '../../application/errors';
import type { Clock } from '../../application/ports';
import type { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { exponentialBackoffMs } from '../../domain/shared/backoff';
import { DomainError } from '../../domain/shared/domain-error';
import { parseWagerMessage } from './wager-message';

export interface SqsWagerConsumerConfig {
  queueUrl: string;
  dlqUrl: string;
  /** Identidade na inbox: (consumerName, messageId). */
  consumerName: string;
  /** Long polling: a chamada espera até N s por mensagens (menos requisições vazias). */
  waitTimeSeconds: number;
  maxMessages: number;
  /** Backoff do retry transitório, aplicado via visibility timeout. */
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  /** No SIGTERM: quanto esperar as mensagens em andamento antes de devolvê-las à fila. */
  shutdownTimeoutMs: number;
}

/**
 * O que fazer com cada mensagem:
 *   ack   → processada (ou rejeição de negócio já REGISTRADA no banco): apaga da fila
 *   retry → falha transitória: NÃO apaga; volta a ficar visível após o backoff.
 *           Passando de maxReceiveCount (redrive policy da fila), o SQS manda para a DLQ.
 *   dlq   → falha permanente: nunca vai dar certo repetindo; manda para a DLQ já.
 */
export type Decision =
  | { action: 'ack'; outcome: string }
  | { action: 'retry'; delaySeconds: number; reason: string }
  | { action: 'dlq'; reason: string };

export class SqsWagerConsumer {
  private readonly logger = new Logger('SqsWagerConsumer');
  private running = false;
  private loop: Promise<void> | undefined;
  private polling: AbortController | undefined;
  /** Mensagens em processamento, por receiptHandle. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly config: SqsWagerConsumerConfig,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log(`Consuming ${this.config.queueUrl}`);
  }

  /**
   * Graceful shutdown (SIGTERM): para de buscar mensagens, espera as que estão
   * em andamento terminarem e, passado o prazo, devolve a visibilidade das que
   * sobraram (visibility = 0) para outra instância pegar na hora.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.polling?.abort();

    const pending = [...this.inFlight.keys()];
    const finished = await Promise.race([
      Promise.allSettled([...this.inFlight.values()]).then(() => true),
      Bun.sleep(this.config.shutdownTimeoutMs).then(() => false),
    ]);
    if (finished) {
      await this.loop;
      return;
    }
    // Prazo estourado: devolve as que sobraram e sai SEM esperar por elas.
    // Se alguma ainda commitar depois, a redelivery cai na inbox como duplicata.
    const leftovers = pending.filter((receipt) => this.inFlight.has(receipt));
    this.logger.warn(`Shutdown timeout: returning ${leftovers.length} message(s) to the queue`);
    await Promise.allSettled(leftovers.map((receipt) => this.changeVisibility(receipt, 0)));
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break; // poll abortado pelo stop()
        this.logger.error(`Polling failed: ${(error as Error).message}`);
        await Bun.sleep(1_000); // SQS fora do ar: não martelar
      }
    }
  }

  /** Uma rodada: recebe um lote e trata. Público para os testes conduzirem passo a passo. */
  async pollOnce(): Promise<number> {
    this.polling = new AbortController();
    const { Messages: messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.config.queueUrl,
        MaxNumberOfMessages: this.config.maxMessages,
        WaitTimeSeconds: this.config.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.polling.signal },
    );

    // Mesma wallet (MessageGroupId) em sequência; grupos diferentes em paralelo.
    // A ordem é otimização: a correção é garantida pelo banco de qualquer jeito.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? 'default';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) await this.track(message);
      }),
    );
    return messages.length;
  }

  private async track(message: Message): Promise<void> {
    const receipt = message.ReceiptHandle!;
    const work = this.handle(message).finally(() => this.inFlight.delete(receipt));
    this.inFlight.set(receipt, work);
    await work;
  }

  private async handle(message: Message): Promise<void> {
    const decision = await this.decide(message);
    const receipt = message.ReceiptHandle!;
    const sqsId = message.MessageId;

    switch (decision.action) {
      case 'ack':
        // Só chega aqui DEPOIS do commit (o use case retornou).
        await this.delete(receipt);
        this.logger.log(`Message ${sqsId} acked (${decision.outcome})`);
        break;
      case 'retry':
        await this.changeVisibility(receipt, decision.delaySeconds);
        this.logger.warn(`Message ${sqsId} will retry in ${decision.delaySeconds}s: ${decision.reason}`);
        break;
      case 'dlq':
        await this.sendToDlq(message, decision.reason);
        await this.delete(receipt);
        this.logger.error(`Message ${sqsId} sent to DLQ: ${decision.reason}`);
        break;
    }
  }

  /** Processa e classifica o resultado. Nunca lança. */
  async decide(message: Message): Promise<Decision> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    try {
      const parsed = parseWagerMessage(message.Body);
      const inbox = InboxMessage.receive({
        messageId: parsed.messageId,
        consumerName: this.config.consumerName,
        payloadHash: parsed.payloadHash,
        receivedAt: this.clock.now(),
      });
      const result = await this.processWager.execute(parsed.command, { inbox });
      // PROCESSED, REJECTED (negócio, gravada) e PENDING_REFERENCE (o worker
      // continua daqui): em todos o banco já tem o registro → ack.
      return { action: 'ack', outcome: `${result.status}${result.idempotentReplay ? ', duplicate' : ''}` };
    } catch (error) {
      return this.classify(error, receiveCount);
    }
  }

  private classify(error: unknown, receiveCount: number): Decision {
    // Erro de domínio que NÃO virou transação gravada: payload inválido, wallet
    // inexistente, conflito de idempotência/messageId. Repetir dá o mesmo erro.
    if (error instanceof DomainError) {
      return { action: 'dlq', reason: `${error.code}: ${error.message}` };
    }
    // Transitório (banco ocupado/fora) ou inesperado: tenta de novo com backoff.
    // Erro inesperado também entra aqui — se for bug, o maxReceiveCount o leva à DLQ.
    const delayMs = exponentialBackoffMs(receiveCount, {
      baseMs: this.config.retryBaseSeconds * 1_000,
      maxMs: this.config.retryMaxSeconds * 1_000,
    });
    const kind = error instanceof TransientError ? 'transient' : 'unexpected';
    return {
      action: 'retry',
      delaySeconds: Math.round(delayMs / 1_000),
      reason: `${kind}: ${(error as Error)?.message ?? String(error)}`,
    };
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.config.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        // Reenvio do mesmo original para a DLQ (crash entre send e delete) é deduplicado.
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 1_000) },
        },
      }),
    );
  }

  private async delete(receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: receiptHandle }));
  }

  private async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.config.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
