/**
 * Syntax-checks the FiveM resource.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Nothing else in this repository ever looks at the Lua. TypeScript has a
 * compiler and a linter, the SQL is exercised by every test run — and the
 * resource that talks to the game servers had neither. A stray `end` in
 * `collector.lua` would have been found by a server operator restarting their
 * server, which is the worst possible place to find it.
 *
 * `luac -p` parses without emitting bytecode. It catches syntax, not FiveM
 * natives: `GetEntityCoords` is undefined here and that is fine, because a
 * parse error is the failure this is for.
 *
 * Skipped with a WARNING, not an error, when no Lua is installed — a
 * contributor working on the web tier should not be blocked by a toolchain they
 * do not need. CI is where it must actually run.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const resources = join(root, 'resources');

function findLua(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findLua(full));
    else if (entry.endsWith('.lua')) out.push(full);
  }
  return out;
}

const compiler = ['luac5.4', 'luac', 'luac5.3'].find((candidate) => {
  const probe = spawnSync(candidate, ['-v'], { stdio: 'ignore' });
  return probe.error === undefined;
});

if (compiler === undefined) {
  console.warn('check-lua: no luac on PATH — skipping. Install lua5.4 to run this locally.');
  process.exit(0);
}

let files;
try {
  files = findLua(resources).sort();
} catch {
  console.log('check-lua: no resources/ directory.');
  process.exit(0);
}

const failures = [];
for (const file of files) {
  try {
    execFileSync(compiler, ['-p', file], { stdio: 'pipe' });
  } catch (error) {
    failures.push(`${relative(root, file)}\n  ${String(error.stderr ?? error).trim()}`);
  }
}

if (failures.length > 0) {
  console.error(`check-lua: ${failures.length} file(s) failed to parse:\n`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`check-lua: ${files.length} Lua file(s), all parse.`);
