import fs from 'node:fs/promises';
import path from 'node:path';

import { installedSkillsDir, skillsDir } from './paths.mjs';
import { lstatOrNull, timestampSuffix } from './fsx.mjs';

export const SKILLS = [
  {
    name: 'ws-google',
    integration: 'google',
    label: 'Google Workspace — Docs, Sheets, Drive comments, Calendar',
  },
  { name: 'ws-slack', integration: 'slack', label: 'Slack — channels, DMs, threads' },
  { name: 'ws-backlog', integration: 'backlog', label: 'Backlog — issues, comments, wikis' },
];

export const INTEGRATIONS = SKILLS.map((s) => s.integration);

export function skillFor(integration) {
  return SKILLS.find((s) => s.integration === integration);
}

/**
 * What sits at ~/.claude/skills/<name> right now.
 *
 * `ours` — a symlink into the install home (possibly stale, hence `target`)
 * `foreign` — a symlink somewhere else, or a real directory someone else owns
 * `absent` — nothing there
 */
export async function linkStatus(name) {
  const link = path.join(skillsDir(), name);
  const want = path.join(installedSkillsDir(), name);
  const stat = await lstatOrNull(link);
  if (!stat) return { state: 'absent', link, want };

  if (stat.isSymbolicLink()) {
    const raw = await fs.readlink(link);
    const target = path.resolve(path.dirname(link), raw);
    if (target === want) return { state: 'ours', link, want, target, current: true };
    return { state: 'foreign', link, want, target };
  }
  return { state: 'foreign', link, want, target: link, directory: true };
}

/**
 * Point ~/.claude/skills/<name> at the installed copy.
 *
 * Anything already there that we did not create is moved aside rather than
 * deleted — an existing skill of the same name is someone's work.
 */
export async function linkSkill(name, { force = false } = {}) {
  const status = await linkStatus(name);
  await fs.mkdir(skillsDir(), { recursive: true });

  if (status.state === 'ours') return { ...status, action: 'unchanged' };

  if (status.state === 'foreign') {
    if (!force) return { ...status, action: 'conflict' };
    const backup = `${status.link}.backup-${timestampSuffix()}`;
    await fs.rename(status.link, backup);
    await fs.symlink(status.want, status.link);
    return { ...status, action: 'replaced', backup };
  }

  await fs.symlink(status.want, status.link);
  return { ...status, action: 'linked' };
}

/** Remove the symlink, but only if it is one of ours. */
export async function unlinkSkill(name) {
  const status = await linkStatus(name);
  if (status.state !== 'ours') return { ...status, action: 'skipped' };
  await fs.rm(status.link);
  return { ...status, action: 'removed' };
}
