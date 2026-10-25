import type { Clock, EventPublisher, UnitOfWork } from '../ports';

export interface RelayResult {
  published: number;
  failed: number;
}

/**
 * Publica um lote de eventos pendentes da outbox. Roda em TODAS as instâncias.
 *
 *   BEGIN
 *     SELECT ... FOR UPDATE SKIP LOCKED   → este lote é só meu
 *     envia ao broker
 *     marca published_at (ou agenda retry com backoff)
 *   COMMIT
 *
 * Se o processo morre depois de enviar e antes do COMMIT, o lock some e outra
 * instância publica de novo: AT-LEAST-ONCE. Por isso o eventId vai junto e é a
 * chave de deduplicação no destino (e no SQS FIFO, MessageDeduplicationId).
 */
export class RelayOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize = 10,
  ) {}

  async execute(): Promise<RelayResult> {
    return this.uow.run(async (ctx) => {
      const now = this.clock.now();
      const batch = await ctx.outbox.claimDue(now, this.batchSize);
      if (batch.length === 0) return { published: 0, failed: 0 };

      let failedIds: Set<string>;
      try {
        ({ failedIds } = await this.publisher.publish(batch));
      } catch {
        // Broker fora do ar: o lote inteiro tenta de novo mais tarde.
        failedIds = new Set(batch.map((m) => m.id));
      }

      for (const message of batch) {
        if (failedIds.has(message.id)) message.scheduleRetry(now);
        else message.markPublished(now);
        await ctx.outbox.save(message);
      }
      return { published: batch.length - failedIds.size, failed: failedIds.size };
    });
  }
}
