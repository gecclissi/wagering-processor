import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { RelayOutboxUseCase } from '../../application/outbox/relay-outbox.use-case';
import type { RetryPendingReferencesUseCase } from '../../application/wagering/retry-pending-references.use-case';
import { PeriodicWorker } from './periodic-worker';

export interface WorkersOptions {
  enabled: boolean;
  outboxIdleMs: number;
  pendingReferenceIdleMs: number;
}

/**
 * Os dois workers rodam em TODAS as instâncias — não há "líder". A
 * coordenação é feita pelo banco: SKIP LOCKED na outbox e lock da wallet nas
 * pendentes. Uma instância que morre não deixa trabalho preso.
 */
export class WorkersService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Workers');
  private readonly workers: PeriodicWorker[] = [];

  constructor(
    private readonly relayOutbox: RelayOutboxUseCase,
    private readonly retryPending: RetryPendingReferencesUseCase,
    private readonly options: WorkersOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.workers.push(
      new PeriodicWorker(
        'OutboxRelay',
        async () => {
          const { published, failed } = await this.relayOutbox.execute();
          if (failed > 0) this.logger.warn(`Outbox: ${failed} event(s) failed, retry scheduled`);
          return published > 0;
        },
        this.options.outboxIdleMs,
      ),
      new PeriodicWorker(
        'PendingReferenceRetry',
        async () => {
          const result = await this.retryPending.execute();
          for (const { transactionId, error } of result.errors) {
            this.logger.warn(`Pending ${transactionId} retry failed: ${(error as Error).message}`);
          }
          return result.processed + result.rejected > 0;
        },
        this.options.pendingReferenceIdleMs,
      ),
    );
    for (const worker of this.workers) worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }
}
