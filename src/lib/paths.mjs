import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this package (where payload/ lives). */
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Where credentials and settings live: the .env, OAuth tokens, the Slack session.
 *
 * Nothing executable is kept here.
 */
export function configHome() {
  if (process.env.WS_SKILLS_HOME) return path.resolve(process.env.WS_SKILLS_HOME);
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'ws-skills');
}

export function claudeDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(os.homedir(), '.claude');
}

export const skillsDir = () => path.join(claudeDir(), 'skills');

/** A skill's own directory — SKILL.md plus its `tools` link. */
export const skillDir = (name) => path.join(skillsDir(), name);

/** The Python tooling, one copy shared by every skill, reached as `<skill>/tools`. */
export const TOOLS_DIRNAME = 'ws-skills-tools';
export const toolsDir = () => path.join(skillsDir(), TOOLS_DIRNAME);

/** The `tools` link inside a skill — what SKILL.md tells Claude to run. */
export const skillToolsLink = (name) => path.join(skillDir(name), 'tools');

export const googleDir = () => path.join(configHome(), 'google');
export const slackDir = () => path.join(configHome(), 'slack');
export const envFile = () => path.join(configHome(), '.env');

/**
 * Where a replaced foreign skill is moved aside. Outside ~/.claude/skills so
 * Claude Code does not discover the old SKILL.md as a duplicate skill.
 */
export const backupsDir = () => path.join(configHome(), 'backups');

/** Where earlier versions put the tools and the skill copies. */
export const legacyToolsDir = () => path.join(configHome(), 'tools');
export const legacySkillsDir = () => path.join(configHome(), 'skills');

export function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
