import { spawn } from 'node:child_process';
import path from 'node:path';

import { toolsDir } from './paths.mjs';

/**
 * Run the installed Python tooling with this terminal attached.
 *
 * Resolves to { ok, code, uvMissing }; it never rejects.
 */
export function runTool(args) {
  return uv(['run', '--project', toolsDir(), 'python', path.join(toolsDir(), 'main.py'), ...args]);
}

/** Same, for a module the tooling depends on but does not wrap (`python -m ...`). */
export function runPythonModule(args) {
  return uv(['run', '--project', toolsDir(), 'python', '-m', ...args]);
}

function uv(args) {
  return new Promise((resolve) => {
    const child = spawn('uv', args, { stdio: 'inherit' });
    child.on('error', (err) =>
      resolve({ ok: false, code: 1, uvMissing: err.code === 'ENOENT' }),
    );
    child.on('close', (code) => resolve({ ok: code === 0, code: code ?? 1, uvMissing: false }));
  });
}
