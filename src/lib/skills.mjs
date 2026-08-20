import fs from 'node:fs/promises';
import path from 'node:path';

import {
  backupsDir,
  legacySkillsDir,
  skillDir,
  skillToolsLink,
  skillsDir,
  toolsDir,
} from './paths.mjs';
import { exists, lstatOrNull, syncDir, timestampSuffix } from './fsx.mjs';

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

/** Marks a skill directory as installed by us, not written by hand. */
const MARKER = '.ws-skills-install';

/**
 * What sits at ~/.claude/skills/<name> right now.
 *
 * `ours` — a directory we installed
 * `legacy` — a symlink into the old install home; ours to replace
 * `foreign` — anything else: someone's own skill, or a link elsewhere
 * `absent` — nothing there
 */
export async function skillStatus(name) {
  const dir = skillDir(name);
  const stat = await lstatOrNull(dir);
  if (!stat) return { state: 'absent', dir };

  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(dir), await fs.readlink(dir));
    const legacy = path.join(legacySkillsDir(), name);
    if (target === legacy) return { state: 'legacy', dir, target };
    return { state: 'foreign', dir, target };
  }

  if (await exists(path.join(dir, MARKER))) return { state: 'ours', dir };
  return { state: 'foreign', dir, target: dir, directory: true };
}

/**
 * Put the skill at ~/.claude/skills/<name>, with its `tools` link.
 *
 * Anything already there that we did not create is moved aside, never deleted.
 */
export async function installSkill(name, source, { force = false } = {}) {
  const status = await skillStatus(name);
  await fs.mkdir(skillsDir(), { recursive: true });

  let action = 'installed';
  if (status.state === 'ours') {
    action = 'updated';
  } else if (status.state === 'legacy') {
    await fs.rm(status.dir);
    action = 'migrated';
  } else if (status.state === 'foreign') {
    if (!force) return { ...status, action: 'conflict' };
    // Move aside outside ~/.claude/skills, or Claude Code would keep
    // discovering the old SKILL.md as a duplicate skill.
    await fs.mkdir(backupsDir(), { recursive: true });
    const backup = path.join(backupsDir(), `${name}.backup-${timestampSuffix()}`);
    await fs.rename(status.dir, backup);
    status.backup = backup;
    action = 'replaced';
  }

  // `tools` is ours to manage, so it survives the sync that refreshes SKILL.md.
  await syncDir(source, status.dir, { keep: ['tools'] });
  await fs.writeFile(path.join(status.dir, MARKER), `${name}\n`);
  await linkTools(name);
  return { ...status, action };
}

/** `<skill>/tools` -> the shared tooling, replaced if it points anywhere else. */
async function linkTools(name) {
  const link = skillToolsLink(name);
  const target = path.relative(skillDir(name), toolsDir());
  const stat = await lstatOrNull(link);
  if (stat) {
    if (stat.isSymbolicLink() && (await fs.readlink(link)) === target) return;
    await fs.rm(link, { recursive: true, force: true });
  }
  await fs.symlink(target, link);
}

/** Remove the skill, but only if it is one of ours. */
export async function removeSkill(name) {
  const status = await skillStatus(name);
  if (status.state === 'ours') {
    await fs.rm(status.dir, { recursive: true, force: true });
    return { ...status, action: 'removed' };
  }
  if (status.state === 'legacy') {
    await fs.rm(status.dir);
    return { ...status, action: 'removed' };
  }
  return { ...status, action: 'skipped' };
}
