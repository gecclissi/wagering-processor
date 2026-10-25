import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

// Sobe PROCESSOS REAIS da aplicação (bun run src/main.ts): sistemas
// operacionais separados, pools de conexão separados, memória separada.
// Nada compartilhado além do PostgreSQL e do SQS — como em produção.

const LOG_DIR = join(tmpdir(), 'wagering-instances');
mkdirSync(LOG_DIR, { recursive: true });

export interface InstanceEnv {
  databaseUrl: string;
  wagerQueue: string;
  wagerDlq: string;
  eventsQueue: string;
  consumerEnabled: boolean;
  workersEnabled: boolean;
}

export interface Instance {
  name: string;
  port: number;
  url: string;
  proc: Subprocess;
  logFile: string;
  /** SIGKILL: morte abrupta, sem shutdown hooks (como um OOM kill ou queda da máquina). */
  crash(): Promise<void>;
}

/** Pede ao sistema operacional uma porta livre (porta 0) e a devolve. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port!;
}

export async function startInstance(name: string, env: InstanceEnv): Promise<Instance> {
  const port = freePort();
  const logFile = join(LOG_DIR, `${name}-${port}.log`);
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: env.databaseUrl,
      SQS_WAGER_QUEUE: env.wagerQueue,
      SQS_WAGER_DLQ: env.wagerDlq,
      SQS_EVENTS_QUEUE: env.eventsQueue,
      SQS_CONSUMER_ENABLED: String(env.consumerEnabled),
      WORKERS_ENABLED: String(env.workersEnabled),
    },
    stdout: Bun.file(logFile),
    stderr: Bun.file(`${logFile}.err`),
  });

  const url = `http://localhost:${port}`;
  const instance: Instance = {
    name,
    port,
    url,
    proc,
    logFile,
    async crash() {
      proc.kill('SIGKILL');
      await proc.exited;
    },
  };

  // Pronto = /health/ready respondeu 200 (Postgres e SQS alcançáveis).
  await waitFor(async () => {
    if (proc.exitCode !== null) throw new Error(`${name} exited early (code ${proc.exitCode}), see ${logFile}`);
    const res = await fetch(`${url}/health/ready`).catch(() => undefined);
    return res?.status === 200;
  }, 30_000, `${name} to become ready (log: ${logFile})`);

  return instance;
}

export async function startInstances(count: number, env: InstanceEnv, prefix = 'instance'): Promise<Instance[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => startInstance(`${prefix}-${i + 1}`, env)));
}

export async function stopAll(instances: Instance[]): Promise<void> {
  await Promise.all(instances.filter((i) => i.proc.exitCode === null).map((i) => i.crash()));
}

/** Repete `check` até dar true (ou estourar o prazo). */
export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}
