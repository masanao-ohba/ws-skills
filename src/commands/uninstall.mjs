import fs from 'node:fs/promises';

import { confirm, interactive } from '../lib/prompt.mjs';
import { configHome, tildify } from '../lib/paths.mjs';
import { SKILLS, unlinkSkill } from '../lib/skills.mjs';
import { bold, dim, heading, info, ok, warn } from '../lib/ui.mjs';

export async function uninstallCommand({ purge = false, force = false } = {}) {
  console.log(bold('\nws-skills uninstall'));

  heading('Unlinking the skills');
  for (const skill of SKILLS) {
    const result = await unlinkSkill(skill.name);
    if (result.action === 'removed') ok(`/${skill.name} unlinked`);
    else if (result.state === 'absent') info(dim(`/${skill.name} was not linked`));
    else warn(`/${skill.name} left alone — ${tildify(result.link)} is not one of ours`);
  }

  if (!purge) {
    info('');
    info(`Tools and credentials are still at ${tildify(configHome())}.`);
    info(`Remove them too with ${dim('ws-skills uninstall --purge')}.`);
    return 0;
  }

  heading('Removing the install home');
  info(`This deletes ${tildify(configHome())}, including OAuth tokens, the saved`);
  info('Slack session, and the API keys in .env.');
  if (!force && interactive()) {
    if (!(await confirm('Delete it?', false))) {
      info('kept');
      return 0;
    }
  } else if (!force) {
    warn('not a terminal and --force was not passed — keeping the install home');
    return 1;
  }

  await fs.rm(configHome(), { recursive: true, force: true });
  ok(`removed ${tildify(configHome())}`);
  return 0;
}
