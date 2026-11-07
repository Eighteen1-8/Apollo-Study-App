// Starts the fake model server and a backend on a fresh, throwaway data folder for the Playwright smoke run.
// Never touches the student's data or real model servers. Stops both when Playwright stops this process.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E } from './ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '../../../backend');
const python = join(backend, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const data = mkdtempSync(join(tmpdir(), 'apollo-e2e-'));
const fake = `http://127.0.0.1:${E2E.fake}/v1`;

const procs = [
  spawn(python, [join(here, 'fake_llm.py'), String(E2E.fake)], { stdio: 'inherit' }),
  spawn(python, ['-m', 'studyapp.main', '--port', String(E2E.backend), '--data-dir', data], {
    cwd: backend, stdio: 'inherit',
    env: {
      ...process.env, APOLLO_TOKEN: E2E.token, STUDY_ENV_FILE: join(data, 'no.env'),
      LLM_BASE_URL: fake, LLM_MODEL: 'fake-chat', EMBED_BASE_URL: fake, EMBED_MODEL: 'fake-embed',
    },
  }),
];
const stop = () => {
  for (const p of procs) p.kill();
  setTimeout(() => { try { rmSync(data, { recursive: true, force: true }); } catch { /* still locked */ } process.exit(0); }, 800);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) { console.error(`server exited with ${code}`); stop(); } });
