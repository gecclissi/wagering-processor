import { Migration20261025000000_initial_schema } from './Migration20261025000000_initial_schema';

// Lista explícita (em ordem): não depende de varrer o disco, funciona igual com Bun e em build.
export const migrationsList = [
  { name: 'Migration20261025000000_initial_schema', class: Migration20261025000000_initial_schema },
];
