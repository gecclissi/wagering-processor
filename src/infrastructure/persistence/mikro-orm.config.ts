import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { env } from '../../config/env';
import { migrationsList } from './migrations';
import { persistenceEntities } from './records';

/** Configuração do MikroORM para um banco. Os testes usam a mesma, apontando para outro banco. */
export function createMikroOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: persistenceEntities,
    extensions: [Migrator],
    migrations: {
      migrationsList,
      tableName: 'mikro_orm_migrations',
      // Cada migration roda dentro de uma transação: ou aplica tudo, ou nada.
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
  });
}

// Configuração usada pela aplicação e pelo script de migrations.
export default createMikroOrmConfig(env.databaseUrl);
