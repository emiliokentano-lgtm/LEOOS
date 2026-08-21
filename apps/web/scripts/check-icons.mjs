/**
 * Fails if a catalogue names an icon the registry does not have.
 *
 * `components/icon.tsx` lists its icons explicitly so the bundler can drop the
 * rest of lucide — a namespace import kept all ~1 500 of them and made the
 * shared client chunk 948 KB. The cost of that is this file: the registry and
 * the catalogues can now drift, and a missing icon renders as nothing, which is
 * a silent hole rather than a crash.
 *
 * So the two are checked against each other. Cheap, exact, and it runs in the
 * same breath as the linter.
 *
 * Usage:  node scripts/check-icons.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTRACTS = join(ROOT, '../../packages/contracts/src');

function read(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** Every `icon: 'Name'` a catalogue can produce. */
const named = new Set();
const sources = [
  ...readdirSync(CONTRACTS).filter((f) => f.endsWith('.ts')).map((f) => join(CONTRACTS, f)),
  join(ROOT, 'lib/navigation.ts'),
];
for (const file of sources) {
  for (const m of read(file).matchAll(/icon:\s*'([A-Z][A-Za-z0-9]*)'/g)) named.add(m[1]);
}

/** Every icon the registry exports. */
const registry = read(join(ROOT, 'components/icon.tsx'));
const block = registry.match(/export const ICONS[^{]*\{([\s\S]*?)\n\};/);
if (!block) {
  console.error('check-icons: could not find the ICONS registry in components/icon.tsx');
  process.exit(1);
}
const have = new Set([...block[1].matchAll(/([A-Z][A-Za-z0-9]*)\s*,/g)].map((m) => m[1]));

const missing = [...named].filter((n) => !have.has(n)).sort();
const unused = [...have].filter((n) => !named.has(n)).sort();

if (missing.length > 0) {
  console.error(
    `check-icons: ${missing.length} icon(s) named by a catalogue but absent from `
    + `components/icon.tsx — they would render as nothing:\n  ${missing.join('\n  ')}`,
  );
  process.exit(1);
}

// Unused is a warning, not a failure: an icon may be referenced from a database
// row rather than from a catalogue in source, and deleting one on that evidence
// would break a status somebody configured.
if (unused.length > 0) {
  console.error(`check-icons: ${unused.length} registered but not named in source (may be database-driven): ${unused.join(', ')}`);
}

console.log(`check-icons: ${named.size} catalogue icons, all present.`);
