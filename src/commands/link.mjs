import path from 'node:path';

import { readEnvFile } from '../lib/envfile.mjs';
import { envFile, packageRoot, tildify } from '../lib/paths.mjs';
import { SKILLS, installSkill } from '../lib/skills.mjs';
import { configuredIntegrations } from './setup.mjs';
import { dim, flowEnd, flowStart, info, ok, warn } from '../lib/ui.mjs';

/**
 * Put the skills back where Claude Code looks — after a config move, a stray
 * `rm`, or a `tools` link left dangling by an upgrade.
 *
 * Credentials are not touched, so this is the cheap repair when only the
 * ~/.claude side is wrong.
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
    if (result.action === 'conflict') {
      warn(`/${skill.name}: ${tildify(result.dir)} already exists — re-run with --force`);
      problems += 1;
    } else if (result.action === 'replaced') {
      ok(
        `/${skill.name} installed ${dim(`(previous copy kept at ${tildify(result.backup)})`)}`,
      );
    } else if (result.action === 'updated') {
      info(dim(`/${skill.name} already in place`));
    } else {
      ok(`/${skill.name} installed`);
    }
  }

  flowEnd(problems ? `${problems} skill(s) still need --force` : 'all skills linked');
  return problems ? 1 : 0;
}
