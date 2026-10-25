import { Counter, Gauge, Histogram, Registry } from 'prom-client';

export type Source = 'http' | 'sqs' | 'worker';

/** Coletas feitas na hora do scrape (consulta ao banco / SQS). */
export interface MetricsCollectors {
  outboxStats?: () => Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
  dlqDepth?: () => Promise<number>;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/**
 * Métricas no formato Prometheus, expostas em GET /metrics.
 * Registry PRÓPRIO por instância (não o global): testes criam várias sem colidir.
 *
 * Mínimo exigido pelo desafio → métrica:
 *   transações por status   → wagering_transactions_total{status,kind,source}
 *   duplicatas detectadas   → wagering_duplicates_total{source}
 *   retries                 → wagering_retries_total{operation,reason}
 *   mensagens em DLQ        → wagering_dlq_messages_total{code} + wagering_dlq_depth
 *   conflitos de lock       → wagering_lock_conflicts_total{reason}
 *   outbox lag              → wagering_outbox_lag_seconds + wagering_outbox_pending
 *   latência                → wagering_processing_duration_seconds{source}
 */
export class Metrics {
  readonly registry = new Registry();

  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações finalizadas (primeira vez, sem replays), por status',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });

  readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Requisições/mensagens repetidas reconhecidas (replay idempotente ou inbox)',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas agendadas',
    labelNames: ['operation', 'reason'] as const,
    registers: [this.registry],
  });

  readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas à DLQ por esta instância (erro permanente)',
    labelNames: ['code'] as const,
    registers: [this.registry],
  });

  readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Falhas por concorrência no banco (lock_timeout, deadlock, version_conflict)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly errors = new Counter({
    name: 'wagering_errors_total',
    help: 'Erros devolvidos ao cliente / à fila, por código',
    labelNames: ['code', 'source'] as const,
    registers: [this.registry],
  });

  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Wallets cujo saldo diverge do ledger (nunca corrigido automaticamente)',
    registers: [this.registry],
  });

  readonly eventsPublished = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Eventos publicados pela outbox',
    registers: [this.registry],
  });

  readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência de processamento de uma transação (inclui espera pelo lock)',
    labelNames: ['source'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Latência das requisições HTTP',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  constructor(collectors: MetricsCollectors = {}) {
    const { outboxStats, dlqDepth } = collectors;

    // Gauges "pull": calculados no momento do scrape, direto da fonte da verdade.
    if (outboxStats) {
      new Gauge({
        name: 'wagering_outbox_pending',
        help: 'Eventos na outbox ainda não publicados',
        registers: [this.registry],
        async collect() {
          this.set((await outboxStats()).pending);
        },
      });
      new Gauge({
        name: 'wagering_outbox_lag_seconds',
        help: 'Idade do evento pendente mais antigo (0 = nada atrasado)',
        registers: [this.registry],
        async collect() {
          this.set((await outboxStats()).oldestPendingAgeSeconds);
        },
      });
    }
    if (dlqDepth) {
      new Gauge({
        name: 'wagering_dlq_depth',
        help: 'Mensagens na DLQ agora (inclui as movidas pela redrive policy do SQS)',
        registers: [this.registry],
        async collect() {
          // SQS fora: mantém o último valor em vez de derrubar o /metrics.
          await dlqDepth().then((n) => this.set(n), () => undefined);
        },
      });
    }
  }

  /** Conta uma falha transitória: retry + (se for de concorrência) conflito de lock. */
  transient(operation: string, reason: string): void {
    this.retries.inc({ operation, reason });
    if (reason === 'lock_timeout' || reason === 'deadlock' || reason === 'version_conflict') {
      this.lockConflicts.inc({ reason });
    }
  }
}
