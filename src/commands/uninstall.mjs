import fs from 'node:fs/promises';

import { configHome, tildify, toolsDir } from '../lib/paths.mjs';
import { SKILLS, removeSkill } from '../lib/skills.mjs';
import { bold, dim, flowEnd, flowStart, heading, info, ok } from '../lib/ui.mjs';

/**
 * Give the three names back, and with `--purge` the tooling and the credentials.
 *
 * Nothing is asked: passing `--purge` is the decision.
 */
export async function uninstallCommand({ purge = false } = {}) {
  flowStart('ws-skills uninstall');

  heading('Removing the skills');
  for (const skill of SKILLS) {
    if (await removeSkill(skill.name)) ok(`/${skill.name} removed`);
    else info(dim(`/${skill.name} was not installed`));
  }

  if (!purge) {
    info(`The tooling is still at ${tildify(toolsDir())}, credentials at ${tildify(configHome())}.`);
    flowEnd(`remove them too with ${bold('npx @masanao-ohba/ws-skills uninstall --purge')}`);
    return 0;
  }

  heading('Removing the tooling and the credentials');
  info('This includes OAuth tokens, the saved Slack session, and the API keys in .env.');
  await fs.rm(toolsDir(), { recursive: true, force: true });
  await fs.rm(configHome(), { recursive: true, force: true });
  flowEnd(`removed ${tildify(toolsDir())} and ${tildify(configHome())}`);
  return 0;
}
