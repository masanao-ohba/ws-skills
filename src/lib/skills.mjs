import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_LINKS,
  agentSkillLink,
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
 * What sits at ~/.agents/skills/<name> right now.
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
 * What sits at an agent's own <skills>/<name>, which should be a link to the
 * real skill.
 *
 * `ours` — already the link we would create
 * `stale` — a link of ours pointing somewhere else, or a directory an earlier
 *   version installed here when this was the real location; ours to replace
 * `foreign` — someone else's skill
 * `absent` — nothing there
 */
async function linkStatus(agent, name) {
  const link = agentSkillLink(agent, name);
  const stat = await lstatOrNull(link);
  if (!stat) return { state: 'absent', link };

  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(link), await fs.readlink(link));
    if (target === skillDir(name)) return { state: 'ours', link, target };
    // An earlier layout linked into the config home; so did we, one move ago.
    if (target === path.join(legacySkillsDir(), name)) return { state: 'stale', link, target };
    return { state: 'foreign', link, target };
  }

  // Before the skills moved to ~/.agents/skills, this was the real directory.
  if (await exists(path.join(link, MARKER))) return { state: 'stale', link, directory: true };
  return { state: 'foreign', link, target: link, directory: true };
}

/**
 * Put the skill at ~/.agents/skills/<name>, with its `tools` link, and point
 * every agent that needs its own entry at it.
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
    await moveAside(name, status.dir, status);
    action = 'replaced';
  }

  // `tools` is ours to manage, so it survives the sync that refreshes SKILL.md.
  await syncDir(source, status.dir, { keep: ['tools'] });
  await fs.writeFile(path.join(status.dir, MARKER), `${name}\n`);
  await linkTools(name);

  const links = [];
  for (const agent of AGENT_LINKS) links.push(await linkSkillFor(agent, name, { force }));
  const conflicts = links.filter((l) => l.action === 'conflict');
  if (conflicts.length) return { ...status, action: 'conflict', links, conflicts };
  return { ...status, action, links };
}

/** Move a directory that is not ours out of the skills tree, never deleting it. */
async function moveAside(name, dir, carry) {
  // Backups live outside any skills directory, or the agent would keep
  // discovering the old SKILL.md as a duplicate skill.
  await fs.mkdir(backupsDir(), { recursive: true });
  const backup = path.join(backupsDir(), `${name}.backup-${timestampSuffix()}`);
  await fs.rename(dir, backup);
  if (carry) carry.backup = backup;
  return backup;
}

/** `<agent skills>/<name>` -> the real skill, so the agent reads the one copy. */
async function linkSkillFor(agent, name, { force = false } = {}) {
  const status = await linkStatus(agent, name);
  if (status.state === 'ours') return { ...status, agent, action: 'current' };

  if (status.state === 'foreign') {
    if (!force) return { ...status, agent, action: 'conflict' };
    await moveAside(`${agent.id}-${name}`, status.link, status);
  } else if (status.state === 'stale') {
    await fs.rm(status.link, { recursive: true, force: true });
  }

  await fs.mkdir(agent.dir(), { recursive: true });
  // Relative, so moving a home directory does not strand the link.
  await fs.symlink(path.relative(agent.dir(), skillDir(name)), status.link);
  return { ...status, agent, action: status.state === 'absent' ? 'linked' : 'relinked' };
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

/** Remove the skill and every link to it, but only where it is one of ours. */
export async function removeSkill(name) {
  // The links go first: once the real directory is gone they only look broken.
  const unlinked = [];
  for (const agent of AGENT_LINKS) {
    const status = await linkStatus(agent, name);
    if (status.state === 'ours' || status.state === 'stale') {
      await fs.rm(status.link, { recursive: true, force: true });
      unlinked.push(agent.id);
    }
  }

  const status = await skillStatus(name);
  if (status.state === 'ours') {
    await fs.rm(status.dir, { recursive: true, force: true });
    return { ...status, unlinked, action: 'removed' };
  }
  if (status.state === 'legacy') {
    await fs.rm(status.dir);
    return { ...status, unlinked, action: 'removed' };
  }
  return { ...status, unlinked, action: unlinked.length ? 'removed' : 'skipped' };
}
