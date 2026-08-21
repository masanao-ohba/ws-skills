import path from 'node:path';

import { authorize } from './auth.mjs';
import { ensureDir, syncDir } from '../lib/fsx.mjs';
import { confirm, interactive } from '../lib/prompt.mjs';
import {
  configHome,
  packageRoot,
  skillsDir,
  tildify,
  toolsDir,
} from '../lib/paths.mjs';
import { SKILLS, describeInstall, installSkill, isBlocked } from '../lib/skills.mjs';
import { UV_INSTALL_HINT, uvVersion } from '../lib/prereq.mjs';
import { bad, bold, dim, emit, flowEnd, flowStart, heading, info, ok, warn } from '../lib/ui.mjs';
import { runWizard } from './setup.mjs';

async function copyPayload() {
  const root = packageRoot();
  // The config home holds credentials only, nothing executable.
  await ensureDir(configHome(), 0o700);
  // .venv is uv's, not ours.
  await syncDir(path.join(root, 'payload', 'tools'), toolsDir(), { keep: ['.venv'] });
  ok(`tooling installed at ${tildify(toolsDir())}`);
}

async function installChosen(integrations, { force }) {
  const wanted = SKILLS.filter((s) => integrations.includes(s.integration));
  const source = path.join(packageRoot(), 'payload', 'skills');
  const blocked = [];

  for (const skill of wanted) {
    const from = path.join(source, skill.name);
    let result = await installSkill(skill.name, from, { force });

    const inTheWay = obstacles(result);
    if (inTheWay.length && interactive()) {
      for (const at of inTheWay) warn(`${skill.name}: something else is already at ${tildify(at)}`);
      if (await confirm(`  move it aside and install /${skill.name}?`, true)) {
        result = await installSkill(skill.name, from, { force: true });
      }
    }

    for (const line of describeInstall(skill.name, result)) emit(line);
    if (isBlocked(result)) blocked.push(skill.name);
  }

  const skipped = SKILLS.filter((s) => !integrations.includes(s.integration));
  for (const skill of skipped) {
    info(dim(`/${skill.name} not installed (integration not selected)`));
  }
  return blocked;
}

/** Every path standing in the way, whichever step hit it — all cleared by --force. */
function obstacles(result) {
  const skill = result.action === 'conflict' ? [result.dir] : [];
  return [...skill, ...result.blocked.map((l) => l.link)];
}

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

export async function installCommand({ force = false, skipSetup = false } = {}) {
  flowStart('ws-skills');
  info('Installs the ws-* agent skills and the tooling behind them.');
  info(dim(`skills: ${tildify(skillsDir())}`));
  info(dim(`credentials: ${tildify(configHome())}`));

  heading('Copying the tooling');
  await copyPayload();

  heading('Credentials');
  const wizard = skipSetup ? null : await runWizard();
  const integrations = wizard ? wizard.integrations : SKILLS.map((s) => s.integration);

  heading('Installing the skills');
  const blocked = await installChosen(integrations, { force });

  // Credentials collected is not the same as authorized: Google needs a consent
  // flow and Slack may need a sign-in, both interactive.
  let pending = [];
  if (wizard && interactive()) {
    heading('Authorization');
    pending = await authorize(wizard.values);
  }

  nextSteps(integrations, pending);

  // Not always "not installed": an entry can be in the way of the link alone.
  if (blocked.length) {
    warn(
      `something is in the way of ${blocked.map((c) => `/${c}`).join(', ')} — ` +
        're-run with --force to move the existing entries aside',
    );
    return 1;
  }
  return 0;
}
