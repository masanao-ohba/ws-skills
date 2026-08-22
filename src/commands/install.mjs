import { authorize } from './auth.mjs';
import { interactive } from '../lib/prompt.mjs';
import { configHome, skillsDir, tildify } from '../lib/paths.mjs';
import { UV_INSTALL_HINT, uvVersion } from '../lib/prereq.mjs';
import { bad, bold, dim, flowEnd, flowStart, heading, info, warn } from '../lib/ui.mjs';
import { putArtifacts } from './update.mjs';
import { runWizard } from './setup.mjs';

const EXAMPLES = {
  backlog: '/ws-backlog  snapshot issue ABC123-45',
  slack: '/ws-slack    save #release since 2026-04-01',
  google: '/ws-google   fetch <doc url> and list the comments nobody resolved',
};

function nextSteps(integrations, pending) {
  heading('Next steps');

  if (!uvVersion()) bad(UV_INSTALL_HINT);
  if (pending.length) {
    warn('still to do:');
    for (const item of pending) info(`  - ${item}`);
    info(dim(`  run ${bold('npx @masanao-ohba/ws-skills auth')} to pick these up`));
    info('');
  }

  info('Start a new session in your agent, then ask for what you need:');
  for (const integration of integrations) info(dim(`  ${EXAMPLES[integration]}`));
  flowEnd(`check anything still missing with ${bold('npx @masanao-ohba/ws-skills doctor')}`);
}

/**
 * The whole first run: which integrations, their credentials, the artifacts,
 * and the authorization steps that need a person.
 *
 * Nothing here checks what is already installed — it is unconditional, so this
 * is also what puts a damaged install right.
 */
export async function installCommand() {
  flowStart('ws-skills');
  info('Installs the ws-* agent skills and the tooling behind them.');
  info(dim(`skills: ${tildify(skillsDir())}`));
  info(dim(`credentials: ${tildify(configHome())}`));

  heading('Credentials');
  const { values, integrations } = await runWizard();

  heading('Installing');
  await putArtifacts(integrations);

  // Credentials collected is not the same as authorized: Google needs a consent
  // flow and Slack may need a sign-in, both interactive.
  let pending = [];
  if (interactive()) {
    heading('Authorization');
    pending = await authorize(values);
  }

  nextSteps(integrations, pending);
  return 0;
}
