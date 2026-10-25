import type { INestApplication } from '@nestjs/common';
import { Metrics } from './infrastructure/observability/metrics';
import { httpObservability } from './interface/http/observability.middleware';

/** Configuração HTTP comum ao main.ts e aos testes (mesmo comportamento nos dois). */
export function configureHttpApp(app: INestApplication): void {
  app.use(httpObservability(app.get(Metrics)));
}
