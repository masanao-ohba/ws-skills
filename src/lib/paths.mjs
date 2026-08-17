import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this package (where payload/ lives). */
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * Where the tools, skills and credentials are installed.
 *
 * Never inside the package: `npx` unpacks into a cache directory that is wiped,
 * and the skill symlinks have to keep pointing at something that stays put.
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
export const toolsDir = () => path.join(configHome(), 'tools');
export const installedSkillsDir = () => path.join(configHome(), 'skills');
export const googleDir = () => path.join(configHome(), 'google');
export const slackDir = () => path.join(configHome(), 'slack');
export const envFile = () => path.join(configHome(), '.env');

/** The command the SKILL.md files tell Claude to run. */
export function toolsCommand() {
  return `uv run --project ${tildify(toolsDir())} python ${tildify(path.join(toolsDir(), 'main.py'))}`;
}

export function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
