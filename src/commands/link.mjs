import path from 'node:path';

import { readEnvFile } from '../lib/envfile.mjs';
import { envFile, packageRoot } from '../lib/paths.mjs';
import { SKILLS, describeInstall, installSkill, isBlocked } from '../lib/skills.mjs';
import { configuredIntegrations } from './setup.mjs';
import { emit, flowEnd, flowStart } from '../lib/ui.mjs';

/**
 * Put the skills back where the agents look — the real copy, and every agent's
 * own entry pointing at it — after a home directory move, a stray `rm`, or a
 * `tools` link left dangling.
 *
 * Credentials are not touched, so this is the cheap repair when only the skills
 * side is wrong.
 */
export async function linkCommand({ force = false } = {}) {
  flowStart('ws-skills link');

  const values = await readEnvFile(envFile());
  const chosen = configuredIntegrations(values);
  const wanted = chosen.length ? SKILLS.filter((s) => chosen.includes(s.integration)) : SKILLS;
  const source = path.join(packageRoot(), 'payload', 'skills');

  let problems = 0;
  for (const skill of wanted) {
    const result = await installSkill(skill.name, path.join(source, skill.name), { force });
    for (const line of describeInstall(skill.name, result)) emit(line);
    if (isBlocked(result)) problems += 1;
  }

  flowEnd(problems ? `${problems} skill(s) still need --force` : 'all skills linked');
  return problems ? 1 : 0;
}
