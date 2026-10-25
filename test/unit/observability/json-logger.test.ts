import { describe, expect, test } from 'bun:test';
import { JsonLogger } from '../../../src/infrastructure/observability/json-logger';
import { addLogContext, runWithLogContext } from '../../../src/infrastructure/observability/log-context';

function capture(level = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger(level, (line) => lines.push(JSON.parse(line)));
  return { logger, lines };
}

describe('JsonLogger', () => {
  test('uma linha JSON com time, level, context e msg', () => {
    const { logger, lines } = capture();
    logger.log('hello', 'MyService');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ time: expect.any(String), level: 'info', context: 'MyService', msg: 'hello' });
    expect(new Date(lines[0]!.time as string).toString()).not.toBe('Invalid Date');
  });

  test('objeto vira campos estruturados', () => {
    const { logger, lines } = capture();
    logger.warn({ msg: 'retrying', delaySeconds: 4 }, 'Consumer');
    expect(lines[0]).toMatchObject({ level: 'warn', context: 'Consumer', msg: 'retrying', delaySeconds: 4 });
  });

  test('campos do contexto assíncrono entram em toda linha, inclusive após await', async () => {
    const { logger, lines } = capture();
    await runWithLogContext({ correlationId: 'corr-1' }, async () => {
      addLogContext({ walletId: 'w-1' });
      await Bun.sleep(1);
      logger.log('inside');
    });
    logger.log('outside');

    expect(lines[0]).toMatchObject({ msg: 'inside', correlationId: 'corr-1', walletId: 'w-1' });
    expect(lines[1]).not.toHaveProperty('correlationId');
  });

  test('contextos concorrentes não se misturam', async () => {
    const { logger, lines } = capture();
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithLogContext({ correlationId: id }, async () => {
          await Bun.sleep(Math.random() * 5);
          logger.log(`req ${id}`);
        }),
      ),
    );
    for (const line of lines) expect(line.msg).toBe(`req ${line.correlationId}`);
  });

  test('valores financeiros e payloads nunca saem no log', () => {
    const { logger, lines } = capture();
    logger.log({ msg: 'oops', amount: '25.00', money: { amount: '25.00' }, payload: { x: 1 }, authorization: 'Bearer x' });
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('25.00');
    expect(raw).not.toContain('Bearer');
    expect(lines[0]).toMatchObject({ amount: '[redacted]', money: '[redacted]', payload: '[redacted]' });
  });

  test('error leva stack; nível abaixo do limiar é descartado', () => {
    const { logger, lines } = capture('warn');
    logger.log('ignored', 'X');
    logger.debug('ignored', 'X');
    logger.error('boom', 'Error: boom\n    at x', 'Svc');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Svc', msg: 'boom', stack: expect.stringContaining('at x') });
  });
});
