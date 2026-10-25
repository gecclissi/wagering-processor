import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

// Uso: bun run src/infrastructure/persistence/migrate.ts <up|down|status>
const command = process.argv[2] ?? 'status';

const orm = await MikroORM.init(config);
try {
  const migrator = orm.migrator;
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(applied.length ? `Applied: ${applied.map((m) => m.name).join(', ')}` : 'Nothing to apply');
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(reverted.length ? `Reverted: ${reverted.map((m) => m.name).join(', ')}` : 'Nothing to revert');
      break;
    }
    case 'status': {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      console.log('Executed:', executed.map((m) => m.name));
      console.log('Pending: ', pending.map((m) => m.name));
      break;
    }
    default:
      console.error(`Unknown command "${command}". Use up, down or status.`);
      process.exitCode = 1;
  }
} finally {
  await orm.close();
}
