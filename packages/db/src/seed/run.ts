import { fileURLToPath } from 'node:url';
import { createDatabase } from '../client.js';
import { seedPermissions, verifyPermissionCatalogue, hasDrift } from './permissions.js';
import { seedOperationalStatuses } from './statuses.js';
import { seedOrganizations } from './organizations.js';
import { seedIncidentTypes } from './incident-types.js';
import { seedDemoData } from './demo.js';

/**
 * Baseline seed.
 *
 * Everything here is REFERENCE DATA the application cannot function without:
 * the permission catalogue, operational statuses, incident types, and the
 * organizations with their starting rank structures. It is idempotent and safe
 * to run against production.
 *
 * Demo/fixture data is a separate, explicitly-flagged path (`--demo`) that
 * refuses to run in production (engineering rules 34, 35).
 */
export async function runSeed(options: { demo?: boolean } = {}): Promise<void> {
  const { db, close } = createDatabase();

  try {
    const permissions = await seedPermissions(db);
    console.log(`  permissions            ${permissions}`);

    const statuses = await seedOperationalStatuses(db);
    console.log(`  operational statuses   ${statuses}`);

    const types = await seedIncidentTypes(db);
    console.log(`  incident types         ${types}`);

    const orgs = await seedOrganizations(db);
    console.log(
      `  organizations          ${orgs.organizations} ` +
        `(${orgs.roles} roles, ${orgs.rolePermissions} permission grants)`,
    );

    // The catalogue check is part of seeding, not an afterthought: a drifted
    // catalogue is an authorization hole, so it fails loudly here too.
    const drift = await verifyPermissionCatalogue(db);
    if (hasDrift(drift)) {
      console.error('Permission catalogue drift detected:', JSON.stringify(drift, null, 2));
      throw new Error('Permission catalogue drift — refusing to complete seed.');
    }
    console.log('  catalogue check        no drift');

    if (options.demo) {
      const demo = await seedDemoData(db);
      console.log(`  demo fixtures          ${demo.summary}`);
    }
  } finally {
    await close();
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const demo = process.argv.includes('--demo');
  console.log(demo ? 'Seeding baseline + DEMO data…' : 'Seeding baseline reference data…');
  runSeed({ demo })
    .then(() => {
      console.log('Seed complete.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Seed failed:', error);
      process.exit(1);
    });
}
