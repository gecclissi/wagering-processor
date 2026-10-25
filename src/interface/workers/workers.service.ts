import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { TransientError } from '../../application/errors';
import type { RelayOutboxUseCase } from '../../application/outbox/relay-outbox.use-case';
import type { RetryPendingReferencesUseCase } from '../../application/wagering/retry-pending-references.use-case';
import { runWithLogContext } from '../../infrastructure/observability/log-context';
import type { Metrics } from '../../infrastructure/observability/metrics';
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
    private readonly metrics: Metrics,
    private readonly options: WorkersOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.workers.push(
      new PeriodicWorker('OutboxRelay', () => this.relayOnce(), this.options.outboxIdleMs),
      new PeriodicWorker('PendingReferenceRetry', () => this.retryPendingOnce(), this.options.pendingReferenceIdleMs),
    );
    for (const worker of this.workers) worker.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }

  private relayOnce(): Promise<boolean> {
    return runWithLogContext({ worker: 'outbox-relay' }, async () => {
      const { published, failed } = await this.relayOutbox.execute();
      this.metrics.eventsPublished.inc(published);
      if (failed > 0) {
        this.metrics.retries.inc({ operation: 'outbox_publish', reason: 'broker_error' }, failed);
        this.logger.warn({ msg: 'outbox publish failed, retry scheduled', failed });
      }
      return published > 0;
    });
  }

  private retryPendingOnce(): Promise<boolean> {
    return runWithLogContext({ worker: 'pending-reference-retry' }, async () => {
      const result = await this.retryPending.execute();

      for (const settled of result.settled) {
        this.metrics.transactions.inc({ status: settled.status, kind: settled.kind, source: 'worker' });
        runWithLogContext({ transactionId: settled.transactionId, walletId: settled.walletId }, () =>
          this.logger.log({ msg: 'pending reference settled', status: settled.status }),
        );
      }
      if (result.stillPending > 0) {
        this.metrics.retries.inc({ operation: 'pending_reference', reason: 'reference_missing' }, result.stillPending);
      }
      for (const { transactionId, error } of result.errors) {
        if (error instanceof TransientError) this.metrics.transient('pending_reference', error.reason);
        runWithLogContext({ transactionId }, () =>
          this.logger.warn({ msg: 'pending reference retry failed', error: (error as Error).message }),
        );
      }
      return result.settled.length > 0;
    });
  }
}
