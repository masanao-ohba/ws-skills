import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { exists } from './fsx.mjs';

/** Run a command for its version string. Returns null when it is not installed. */
export function probe(command, args = ['--version']) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
    if (result.error || result.status !== 0) return null;
    return (result.stdout || result.stderr).trim().split('\n')[0];
  } catch {
    return null;
  }
}

export function uvVersion() {
  return probe('uv');
}

export function pythonVersion() {
  return probe('python3');
}

/** Playwright's browser download lives outside the venv, so check it separately. */
export async function playwrightBrowsersInstalled() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return exists(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  const home = os.homedir();
  const candidates =
    process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Caches', 'ms-playwright')]
      : process.platform === 'win32'
        ? [path.join(home, 'AppData', 'Local', 'ms-playwright')]
        : [path.join(home, '.cache', 'ms-playwright')];
  for (const dir of candidates) {
    if (await exists(dir)) return true;
  }
  return false;
}

export const UV_INSTALL_HINT =
  'uv is not installed. Install it with `brew install uv`, or ' +
  '`curl -LsSf https://astral.sh/uv/install.sh | sh` — it manages the Python side.';
