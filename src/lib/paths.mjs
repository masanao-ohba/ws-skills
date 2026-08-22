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

/**
 * The vendor-neutral skills home, and where our skills actually live.
 *
 * `~/.agents/skills` is read as a personal skills location by every agent that
 * implements the Agent Skills format except Claude Code, which reads only its
 * own directory — so this is the one copy, and `~/.claude/skills` gets a link
 * to it. Keeping a single real directory is what lets SKILL.md name an absolute
 * path to its own tooling.
 */
export function agentsDir() {
  return path.join(os.homedir(), '.agents');
}

export const skillsDir = () => path.join(agentsDir(), 'skills');

/** A skill's own directory — SKILL.md plus its `tools` link. */
export const skillDir = (name) => path.join(skillsDir(), name);

/** The Python tooling, one copy shared by every skill, reached as `<skill>/tools`. */
export const TOOLS_DIRNAME = 'ws-skills-tools';
export const toolsDir = () => path.join(skillsDir(), TOOLS_DIRNAME);

/** The `tools` link inside a skill — what SKILL.md tells the agent to run. */
export const skillToolsLink = (name) => path.join(skillDir(name), 'tools');

/**
 * Agents that read a skills directory of their own, each needing a link to the
 * real skill. Anything reading `~/.agents/skills` directly belongs nowhere here.
 */
export const AGENT_LINKS = [
  { id: 'claude', label: 'Claude Code', dir: () => path.join(claudeDir(), 'skills') },
];

export const agentSkillLink = (agent, name) => path.join(agent.dir(), name);

export const googleDir = () => path.join(configHome(), 'google');
export const slackDir = () => path.join(configHome(), 'slack');
export const envFile = () => path.join(configHome(), '.env');

export function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
