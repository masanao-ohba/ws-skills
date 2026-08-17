import path from 'node:path';

import { exists } from '../lib/fsx.mjs';
import { readEnvFile } from '../lib/envfile.mjs';
import { envFile, installedSkillsDir, tildify } from '../lib/paths.mjs';
import { SKILLS, linkSkill } from '../lib/skills.mjs';
import { configuredIntegrations } from './setup.mjs';
import { bad, bold, dim, info, ok, warn } from '../lib/ui.mjs';

/** Re-create the symlinks — after a Claude config move, or a stray `rm`. */
export async function linkCommand({ force = false } = {}) {
  console.log(bold('\nws-skills link'));

  const values = await readEnvFile(envFile());
  const chosen = configuredIntegrations(values);
  const wanted = chosen.length ? SKILLS.filter((s) => chosen.includes(s.integration)) : SKILLS;

  let problems = 0;
  for (const skill of wanted) {
    if (!(await exists(path.join(installedSkillsDir(), skill.name, 'SKILL.md')))) {
      bad(`${skill.name} is not installed — run \`ws-skills install\` first`);
      problems += 1;
      continue;
    }
    const result = await linkSkill(skill.name, { force });
    if (result.action === 'conflict') {
      warn(`/${skill.name}: ${tildify(result.link)} already exists — re-run with --force`);
      problems += 1;
    } else if (result.action === 'replaced') {
      ok(`/${skill.name} linked ${dim(`(previous copy kept at ${path.basename(result.backup)})`)}`);
    } else if (result.action === 'linked') {
      ok(`/${skill.name} linked`);
    } else {
      info(dim(`/${skill.name} already linked`));
    }
  }
  return problems ? 1 : 0;
}
