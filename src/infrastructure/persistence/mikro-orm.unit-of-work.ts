import { ConnectionException } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { TransientError } from '../../application/errors';
import type { TransactionContext, UnitOfWork } from '../../application/ports';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './mikro-orm.repositories';

/** Tempo máximo esperando o lock de uma wallet antes de desistir (falha transitória). */
const LOCK_TIMEOUT = '5s';

/**
 * Uma transação SQL por chamada de `run`, isolamento READ COMMITTED (padrão do
 * PostgreSQL). Commit se `work` terminar; rollback se lançar.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    // fork(): EntityManager novo por operação — sem identity map compartilhado
    // entre requisições concorrentes.
    try {
      return await this.em.fork().transactional(async (em) => {
        // SET LOCAL vale só dentro desta transação.
        await em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        return work({
          wallets: new MikroOrmWalletRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em),
          ledger: new MikroOrmLedgerRepository(em),
          inbox: new MikroOrmInboxRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
        });
      });
    } catch (error) {
      if (error instanceof ConnectionException) {
        throw new TransientError('Database unavailable', 'database_unavailable', { cause: error });
      }
      throw error;
    }
  }
}
