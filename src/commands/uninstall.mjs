import fs from 'node:fs/promises';

import { confirm, interactive } from '../lib/prompt.mjs';
import { configHome, tildify, toolsDir } from '../lib/paths.mjs';
import { SKILLS, removeSkill } from '../lib/skills.mjs';
import { bold, dim, flowEnd, flowStart, heading, info, ok, warn } from '../lib/ui.mjs';

export async function uninstallCommand({ purge = false, force = false } = {}) {
  flowStart('ws-skills uninstall');

  heading('Removing the skills');
  for (const skill of SKILLS) {
    const result = await removeSkill(skill.name);
    if (result.action === 'removed') ok(`/${skill.name} removed`);
    else if (result.state === 'absent') info(dim(`/${skill.name} was not installed`));
    else warn(`/${skill.name} left alone — ${tildify(result.dir)} is not one of ours`);

    // Not ours to delete, and the agent keeps reading it — say so rather than
    // letting "removed" imply the name is free everywhere.
    for (const link of result.left) {
      warn(`/${skill.name}: ${link.agent.label} still reads ${tildify(link.link)} — not ours`);
    }
  }

  if (!purge) {
    info(`The tooling is still at ${tildify(toolsDir())}, credentials at ${tildify(configHome())}.`);
    flowEnd(`remove them too with ${bold('npx @masanao-ohba/ws-skills uninstall --purge')}`);
    return 0;
  }

  heading('Removing the tooling and the credentials');
  info(`This deletes ${tildify(toolsDir())} and ${tildify(configHome())}, including`);
  info('OAuth tokens, the saved Slack session, and the API keys in .env.');
  if (!force && interactive()) {
    if (!(await confirm('Delete them?', false))) {
      flowEnd('kept');
      return 0;
    }
  } else if (!force) {
    warn('not a terminal and --force was not passed — keeping both');
    flowEnd('');
    return 1;
  }

  await fs.rm(toolsDir(), { recursive: true, force: true });
  await fs.rm(configHome(), { recursive: true, force: true });
  flowEnd(`removed ${tildify(toolsDir())} and ${tildify(configHome())}`);
  return 0;
}
