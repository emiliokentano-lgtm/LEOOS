import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDatabase } from './client.js';

/**
 * Applies pending migrations.
 *
 * Migrations are FORWARD ONLY and reviewed (engineering rule 48). There is no
 * down-migration path: reversing a schema change in production is a new
 * migration, written deliberately, not an automated rollback that silently drops
 * columns holding operational history.
 */
const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const { db, close } = createDatabase();
  try {
    await migrate(db, { migrationsFolder: join(here, '..', 'migrations') });
  } finally {
    await close();
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
