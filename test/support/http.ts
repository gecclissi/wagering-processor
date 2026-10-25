import 'reflect-metadata';
import { SQL } from 'bun';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { TEST_DATABASE_URL, createTestDatabase } from './database';

/** Sobe a aplicação Nest REAL (HTTP + Postgres de teste) numa porta livre. */
export async function startHttpApp() {
  await createTestDatabase();
  const app: INestApplication = await NestFactory.create(
    AppModule.register({
      databaseUrl: TEST_DATABASE_URL,
      sqsConsumer: { enabled: false, queueName: '', dlqName: '' },
      workers: { enabled: false, eventsQueueName: '', outboxIdleMs: 0, pendingReferenceIdleMs: 0 },
    }),
    { logger: false },
  );
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  const sql = new SQL(TEST_DATABASE_URL);

  async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  return {
    sql,
    request,
    get: (path: string) => request('GET', path),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => request('POST', path, body, headers),
    async close() {
      await app.close();
      await sql.close();
    },
  };
}

export type HttpApp = Awaited<ReturnType<typeof startHttpApp>>;
