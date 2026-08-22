import fs from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_LINKS,
  agentSkillLink,
  skillDir,
  skillToolsLink,
  skillsDir,
  toolsDir,
} from './paths.mjs';
import { lstatOrNull, syncDir } from './fsx.mjs';

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

/**
 * Put the skill at ~/.agents/skills/<name>, with its `tools` link, and point
 * every agent that needs its own entry at it.
 *
 * Whatever holds either path is replaced, without asking. Telling our own
 * install from a same-named skill of someone else's would need a marker inside
 * the directory, and a marker is only worth the chance that nobody else writes
 * the same file — a judgement with holes is worse than no judgement, because it
 * reads as a guarantee. So these three names belong to this package: install
 * takes them, and `uninstall` gives them back the same way.
 */
export async function installSkill(name, source) {
  const dir = skillDir(name);
  await fs.mkdir(skillsDir(), { recursive: true });

  // Not just clearing the way: `syncDir` follows a symlink, so syncing onto one
  // would empty out whatever it points at, somewhere we were never asked about.
  const stat = await lstatOrNull(dir);
  if (stat && !stat.isDirectory()) await fs.rm(dir, { recursive: true, force: true });

  // `tools` is ours to manage, so it survives the sync that refreshes SKILL.md.
  await syncDir(source, dir, { keep: ['tools'] });
  await linkTools(name);
  for (const agent of AGENT_LINKS) await linkSkillFor(agent, name);
}

/** `<agent skills>/<name>` -> the real skill, so the agent reads the one copy. */
async function linkSkillFor(agent, name) {
  await fs.mkdir(agent.dir(), { recursive: true });
  // Relative, so moving a home directory does not strand the link.
  await relink(agentSkillLink(agent, name), path.relative(agent.dir(), skillDir(name)));
}

/** `<skill>/tools` -> the shared tooling, one copy for every skill. */
async function linkTools(name) {
  await relink(skillToolsLink(name), path.relative(skillDir(name), toolsDir()));
}

/** Make `link` a symlink to `target`, replacing anything else that holds it. */
async function relink(link, target) {
  const stat = await lstatOrNull(link);
  if (stat) {
    if (stat.isSymbolicLink() && (await fs.readlink(link)) === target) return;
    await fs.rm(link, { recursive: true, force: true });
  }
  await fs.symlink(target, link);
}

/**
 * Remove the skill and every agent's entry for it.
 *
 * Resolves to whether the skill was there, which is all the caller can say —
 * nothing here asks who put it there. Install overwrites whatever holds these
 * paths, so uninstall clears the same paths on the same terms.
 */
export async function removeSkill(name) {
  // The entries go first: once the real directory is gone they only look broken.
  for (const agent of AGENT_LINKS) {
    await fs.rm(agentSkillLink(agent, name), { recursive: true, force: true });
  }

  const dir = skillDir(name);
  const installed = Boolean(await lstatOrNull(dir));
  await fs.rm(dir, { recursive: true, force: true });
  return installed;
}
