// Every check in one go (from app/): types, production build, front-end unit tests, backend tests, the browser smoke
// run and the Electron smoke run (on the build).
// `npm run check -- --quick` skips the build and the smoke run. Stops at the first failure.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(app, '../backend');
const quick = process.argv.includes('--quick');
const py = resolve(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const steps = [
  ['types', 'npx', ['tsc', '--noEmit'], app],
  ...(quick ? [] : [['build', 'npx', ['vite', 'build'], app]]),
  ['unit tests', 'npx', ['vitest', 'run'], app],
  ['backend tests', py, ['-m', 'pytest', '-q'], backend],
  ...(quick ? [] : [['smoke run', 'npx', ['playwright', 'test'], app], ['Electron smoke run', 'node', ['tests/electron/smoke.mjs'], app]]),
];
for (const [name, cmd, args, cwd] of steps) {
  console.log(`\n== ${name} ==`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && (cmd === 'npx' || cmd === 'node') });
  if (r.status !== 0) { console.error(`\n✗ ${name} failed`); process.exit(r.status ?? 1); }
  console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
console.log('\nAll checks passed.');
