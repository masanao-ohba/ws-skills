import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir, mode) {
  await fs.mkdir(dir, { recursive: true });
  if (mode !== undefined) await fs.chmod(dir, mode);
}

export async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** lstat without throwing — null when the path does not exist. */
export async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/**
 * Make `dest` a copy of `src`, keeping named entries that only exist in `dest`.
 *
 * Everything not named in `keep` goes first, so a file deleted upstream does not
 * survive an upgrade.
 */
export async function syncDir(src, dest, { keep = [] } = {}) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(dest)) {
    if (keep.includes(entry)) continue;
    await fs.rm(path.join(dest, entry), { recursive: true, force: true });
  }
  // A checkout carries build artifacts the published tarball excludes; skipping
  // them here makes both paths agree.
  await fs.cp(src, dest, { recursive: true, filter: (from) => !isBuildArtifact(from) });
}

const ARTIFACT_NAMES = new Set(['.venv', '__pycache__', '.DS_Store', '.metadata_never_index']);

function isBuildArtifact(target) {
  const name = path.basename(target);
  return ARTIFACT_NAMES.has(name) || name.endsWith('.pyc');
}

/** Write a file only the owner can read — credentials, always. */
export async function writeSecret(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

export async function copySecret(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  await fs.chmod(dest, 0o600);
}

/** `2026-08-17T091500` — a suffix that sorts and never collides in practice. */
export function timestampSuffix(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
}
