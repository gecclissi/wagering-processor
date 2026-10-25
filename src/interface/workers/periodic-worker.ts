import { Logger } from '@nestjs/common';

/**
 * Executa `task` em loop. Se a rodada fez trabalho, roda de novo na hora
 * (drena o acúmulo); se não, dorme `idleMs`. Erros não derrubam o loop.
 * `stop()` termina a rodada em andamento antes de sair (graceful shutdown).
 */
export class PeriodicWorker {
  private readonly logger: Logger;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    /** Devolve true se encontrou trabalho. */
    private readonly task: () => Promise<boolean>,
    private readonly idleMs: number,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.(); // interrompe o sono; a rodada em andamento termina normalmente
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.task();
      } catch (error) {
        this.logger.error(`${this.name} failed: ${(error as Error).message}`);
      }
      if (!busy && this.running) await this.sleep(this.idleMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
