import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_LINKS,
  agentSkillLink,
  backupsDir,
  skillDir,
  skillToolsLink,
  skillsDir,
  tildify,
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
 * `foreign` — anything else: someone's own skill, or a link elsewhere
 * `absent` — nothing there
 *
 * This is the one real copy, so a symlink here is never ours to follow.
 */
export async function skillStatus(name) {
  const dir = skillDir(name);
  const stat = await lstatOrNull(dir);
  if (!stat) return { state: 'absent', dir };

  if (stat.isSymbolicLink()) {
    const target = path.resolve(path.dirname(dir), await fs.readlink(dir));
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
 * `stale` — a link of ours aimed somewhere else; ours to point back
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
    // A skills home we no longer use, or a target that is gone: still a link we
    // made, so it is ours to point back, not a skill to move aside.
    if (!(await exists(target)) || (await exists(path.join(target, MARKER)))) {
      return { state: 'stale', link, target };
    }
    return { state: 'foreign', link, target };
  }

  return { state: 'foreign', link, target: link, directory: true };
}

/**
 * Put the skill at ~/.agents/skills/<name>, with its `tools` link, and point
 * every agent that needs its own entry at it.
 *
 * Anything already there that we did not create is moved aside, never deleted.
 *
 * `action` says what happened to the skill itself, and nothing else — an agent
 * whose own entry is taken does not stop the skill from being installed. Those
 * are reported separately in `blocked`, each naming the entry in the way, so a
 * caller can say which path it means rather than pointing at the skill.
 */
export async function installSkill(name, source, { force = false } = {}) {
  const status = await skillStatus(name);
  await fs.mkdir(skillsDir(), { recursive: true });

  let action = 'installed';
  if (status.state === 'ours') {
    action = 'updated';
  } else if (status.state === 'foreign') {
    if (!force) return { ...status, action: 'conflict', links: [], blocked: [] };
    await moveAside(name, status.dir, status);
    action = 'replaced';
  }

  // `tools` is ours to manage, so it survives the sync that refreshes SKILL.md.
  await syncDir(source, status.dir, { keep: ['tools'] });
  await fs.writeFile(path.join(status.dir, MARKER), `${name}\n`);
  await linkTools(name);

  const links = [];
  for (const agent of AGENT_LINKS) links.push(await linkSkillFor(agent, name, { force }));
  return { ...status, action, links, blocked: links.filter((l) => l.action === 'conflict') };
}

/**
 * What to tell the user about one `installSkill` result, as lines to print.
 *
 * `install` and `link` both call `installSkill` and have to say the same things
 * about the same outcome, so the wording lives here rather than in each command
 * — a new outcome cannot end up described one way in one and another way in the
 * other. What to do about it is still the command's own: whether a line is worth
 * a non-zero exit is `isBlocked`.
 */
export function describeInstall(name, result) {
  if (result.action === 'conflict') {
    return [{ level: 'bad', text: `/${name}: left alone (${tildify(result.dir)} already exists)` }];
  }

  const lines = [];
  if (result.action === 'replaced') {
    lines.push({
      level: 'ok',
      text: `/${name} installed`,
      note: `previous copy kept at ${tildify(result.backup)}`,
    });
  } else if (result.action === 'updated') {
    lines.push({ level: 'ok', text: `/${name} up to date` });
  } else {
    lines.push({ level: 'ok', text: `/${name} installed` });
  }

  // In place, but an agent whose own entry is taken still cannot reach it.
  for (const link of result.blocked) {
    lines.push({
      level: 'bad',
      text: `/${name}: ${link.agent.label} cannot see it — ${tildify(link.link)} is not ours`,
    });
  }
  return lines;
}

/** Whether anything stood in the way — the skill's own location, or an agent's entry. */
export const isBlocked = (result) => result.action === 'conflict' || result.blocked.length > 0;

/** Move a directory that is not ours out of the skills tree, never deleting it. */
async function moveAside(name, dir, carry) {
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

/**
 * Remove the skill and every link to it, but only where it is one of ours.
 *
 * `action` is what happened to the skill itself, and nothing else — removing a
 * link is not removing the skill. An entry that is not ours is left where it is
 * and named in `left`, because the agent goes on reading whatever sits there.
 */
export async function removeSkill(name) {
  // The links go first: once the real directory is gone they only look broken.
  const unlinked = [];
  const left = [];
  for (const agent of AGENT_LINKS) {
    const status = await linkStatus(agent, name);
    if (status.state === 'ours' || status.state === 'stale') {
      await fs.rm(status.link, { recursive: true, force: true });
      unlinked.push(agent.id);
    } else if (status.state === 'foreign') {
      left.push({ ...status, agent });
    }
  }

  const status = await skillStatus(name);
  if (status.state === 'ours') {
    await fs.rm(status.dir, { recursive: true, force: true });
    return { ...status, unlinked, left, action: 'removed' };
  }
  return { ...status, unlinked, left, action: 'skipped' };
}
