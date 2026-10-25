import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Metrics } from '../../infrastructure/observability/metrics';

/**
 * Formato texto do Prometheus. Aberto como os health checks: é para o
 * scraper interno; em produção fica numa porta/rede não exposta à internet.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
