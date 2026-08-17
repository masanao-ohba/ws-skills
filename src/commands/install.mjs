import path from 'node:path';

import { ensureDir, syncDir } from '../lib/fsx.mjs';
import { confirm, interactive } from '../lib/prompt.mjs';
import {
  configHome,
  installedSkillsDir,
  packageRoot,
  tildify,
  toolsCommand,
  toolsDir,
} from '../lib/paths.mjs';
import { SKILLS, linkSkill } from '../lib/skills.mjs';
import { UV_INSTALL_HINT, uvVersion } from '../lib/prereq.mjs';
import { bad, bold, dim, heading, info, ok, step, warn } from '../lib/ui.mjs';
import { runWizard } from './setup.mjs';

async function copyPayload() {
  const root = packageRoot();
  await ensureDir(configHome(), 0o700);
  // .venv is uv's, not ours — wiping it would re-download every dependency.
  await syncDir(path.join(root, 'payload', 'tools'), toolsDir(), { keep: ['.venv'] });
  await syncDir(path.join(root, 'payload', 'skills'), installedSkillsDir());
  ok(`tools and skills installed under ${tildify(configHome())}`);
}

async function linkChosen(integrations, { force }) {
  const wanted = SKILLS.filter((s) => integrations.includes(s.integration));
  const conflicts = [];

  for (const skill of wanted) {
    let result = await linkSkill(skill.name, { force });

    if (result.action === 'conflict' && interactive()) {
      warn(`${skill.name}: something else is already at ${tildify(result.link)}`);
      if (await confirm(`  move it aside and link /${skill.name}?`, true)) {
        result = await linkSkill(skill.name, { force: true });
      }
    }

    if (result.action === 'conflict') {
      conflicts.push(skill.name);
      bad(`/${skill.name}: left alone (${tildify(result.link)} already exists)`);
    } else if (result.action === 'replaced') {
      ok(`/${skill.name} linked ${dim(`(previous copy kept at ${path.basename(result.backup)})`)}`);
    } else if (result.action === 'linked') {
      ok(`/${skill.name} linked`);
    } else {
      ok(`/${skill.name} already linked`);
    }
  }

  const skipped = SKILLS.filter((s) => !integrations.includes(s.integration));
  for (const skill of skipped) {
    info(dim(`/${skill.name} not linked (integration not selected)`));
  }
  return conflicts;
}

function nextSteps(integrations) {
  const cmd = toolsCommand();
  heading('Next steps');

  if (!uvVersion()) {
    bad(UV_INSTALL_HINT);
  }

  info(`The skills run this command; nothing else needs to be on your PATH:`);
  info(dim(`  ${cmd} --help`));

  if (integrations.includes('google')) {
    info('');
    info(`${bold('Google')}: authorize the read-only token (and the write tokens you need)`);
    info(dim(`  ${cmd} auth`));
    info(dim(`  ${cmd} auth --write sheets`));
    info(dim(`  ${cmd} auth --check`));
  }
  if (integrations.includes('slack')) {
    info('');
    info(`${bold('Slack')}: for the browser backend, install Chromium once and save a session`);
    info(dim(`  uv run --project ${tildify(toolsDir())} python -m playwright install chromium`));
    info(dim(`  ${cmd} slack-signin --url https://<workspace>.slack.com/`));
  }
  if (integrations.includes('backlog')) {
    info('');
    info(`${bold('Backlog')}: ready — try`);
    info(dim(`  ${cmd} bl-explore overview --project <PROJECT>`));
  }

  info('');
  info('In Claude Code, the skills are available as ' + SKILLS.map((s) => `/${s.name}`).join(', '));
  info(dim('  (start a new session to pick them up)'));
  info(`Check anything that is still missing with ${dim('ws-skills doctor')}`);
}

export async function installCommand({ force = false, skipSetup = false } = {}) {
  console.log(bold('\nws-skills'));
  info('Installs the ws-* Claude Code skills and the tooling behind them.');
  info(dim(`install home: ${tildify(configHome())}`));

  step('Copying the tools and skills');
  await copyPayload();

  step('Credentials');
  const { integrations } = skipSetup
    ? { integrations: SKILLS.map((s) => s.integration) }
    : await runWizard();

  step('Linking the skills into Claude Code');
  const conflicts = await linkChosen(integrations, { force });

  nextSteps(integrations);

  if (conflicts.length) {
    warn(
      `not linked: ${conflicts.map((c) => `/${c}`).join(', ')} — ` +
        're-run with --force to move the existing entries aside',
    );
    return 1;
  }
  return 0;
}
