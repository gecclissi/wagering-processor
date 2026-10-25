import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { currentLogContext, runWithLogContext } from '../../infrastructure/observability/log-context';
import type { Metrics } from '../../infrastructure/observability/metrics';

const logger = new Logger('Http');
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Primeira coisa de toda requisição:
 *  - correlationId: o do header X-Correlation-Id (se for seguro) ou um novo;
 *    devolvido no header da resposta para o cliente citar em suporte;
 *  - abre o contexto de log — tudo que for logado nesta requisição o carrega;
 *  - ao terminar: uma linha de access log + métrica de latência.
 */
export function httpObservability(metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('x-correlation-id');
    const correlationId = header && SAFE_CORRELATION_ID.test(header) ? header : crypto.randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    const started = performance.now();

    runWithLogContext({ correlationId }, () => {
      // Referência ao contexto desta requisição: o controller acrescenta
      // walletId/transactionId nele e o access log abaixo enxerga.
      const context = currentLogContext();

      res.on('finish', () => {
        // Rota com parâmetros (/wallets/:walletId), nunca o id real: mantém a
        // cardinalidade da métrica baixa.
        const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
        const seconds = (performance.now() - started) / 1_000;
        metrics.httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
        runWithLogContext(context, () =>
          logger.log({
            msg: 'http request',
            method: req.method,
            route,
            status: res.statusCode,
            durationMs: Math.round(seconds * 1_000),
          }),
        );
      });

      next();
    });
  };
}
