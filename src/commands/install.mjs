import fs from 'node:fs/promises';
import path from 'node:path';

import { authorize } from './auth.mjs';
import { ensureDir, exists, syncDir } from '../lib/fsx.mjs';
import { confirm, interactive } from '../lib/prompt.mjs';
import {
  configHome,
  legacySkillsDir,
  legacyToolsDir,
  packageRoot,
  skillsDir,
  tildify,
  toolsDir,
} from '../lib/paths.mjs';
import { SKILLS, installSkill } from '../lib/skills.mjs';
import { UV_INSTALL_HINT, uvVersion } from '../lib/prereq.mjs';
import { bad, bold, dim, flowEnd, flowStart, heading, info, ok, warn } from '../lib/ui.mjs';
import { runWizard } from './setup.mjs';

/**
 * Carry the virtualenv over from an install made by an earlier version.
 *
 * If the move cannot be done (a different filesystem), uv rebuilds it on first
 * run. The old layout itself stays until `removeLegacyInstall`, after the skills
 * are installed — the entries an earlier version made are symlinks into it.
 */
async function carryLegacyVenv() {
  if (!(await exists(legacyToolsDir()))) return;

  const from = path.join(legacyToolsDir(), '.venv');
  const to = path.join(toolsDir(), '.venv');
  if ((await exists(from)) && !(await exists(to))) {
    await ensureDir(toolsDir());
    try {
      await fs.rename(from, to);
    } catch {
      warn('could not move the Python virtualenv — uv will rebuild it on the first run');
    }
  }
}

/**
 * Delete the old layout, and every ~/.claude/skills entry still pointing into it.
 *
 * A skill chosen this run is already migrated by `installSkill` before this
 * runs, so it is no longer a legacy symlink here. Anything still a legacy
 * symlink was not chosen this run — ask before removing it, since that
 * removes a skill the user did not just decide to drop. The old shared
 * layout (`legacyToolsDir`/`legacySkillsDir`) is only deleted once nothing
 * still points into it.
 */
async function removeLegacyInstall() {
  if (!(await exists(legacyToolsDir())) && !(await exists(legacySkillsDir()))) return;

  let remaining = false;
  for (const skill of SKILLS) {
    const entry = path.join(skillsDir(), skill.name);
    const target = await fs.readlink(entry).catch(() => null);
    if (!target || !path.resolve(path.dirname(entry), target).startsWith(configHome() + path.sep)) {
      continue;
    }

    const remove =
      interactive() &&
      (await confirm(`  /${skill.name} is still the previous version's link — remove it?`, false));
    if (remove) {
      await fs.rm(entry, { force: true });
    } else {
      warn(`/${skill.name}: left as the previous version's link (re-select it next time to migrate)`);
      remaining = true;
    }
  }

  if (remaining) return;

  await fs.rm(legacyToolsDir(), { recursive: true, force: true });
  await fs.rm(legacySkillsDir(), { recursive: true, force: true });
  info(dim(`moved the previous install out of ${tildify(configHome())}`));
}

async function copyPayload() {
  const root = packageRoot();
  // The config home holds credentials now, nothing executable.
  await ensureDir(configHome(), 0o700);
  await carryLegacyVenv();
  // .venv is uv's, not ours.
  await syncDir(path.join(root, 'payload', 'tools'), toolsDir(), { keep: ['.venv'] });
  ok(`tooling installed at ${tildify(toolsDir())}`);
}

async function installChosen(integrations, { force }) {
  const wanted = SKILLS.filter((s) => integrations.includes(s.integration));
  const source = path.join(packageRoot(), 'payload', 'skills');
  const conflicts = [];

  for (const skill of wanted) {
    const from = path.join(source, skill.name);
    let result = await installSkill(skill.name, from, { force });

    if (result.action === 'conflict' && interactive()) {
      warn(`${skill.name}: something else is already at ${tildify(result.dir)}`);
      if (await confirm(`  move it aside and install /${skill.name}?`, true)) {
        result = await installSkill(skill.name, from, { force: true });
      }
    }

    if (result.action === 'conflict') {
      conflicts.push(skill.name);
      bad(`/${skill.name}: left alone (${tildify(result.dir)} already exists)`);
    } else if (result.action === 'replaced') {
      ok(
        `/${skill.name} installed ${dim(`(previous copy kept at ${tildify(result.backup)})`)}`,
      );
    } else if (result.action === 'migrated') {
      ok(`/${skill.name} installed ${dim('(replacing the link an earlier version made)')}`);
    } else if (result.action === 'updated') {
      ok(`/${skill.name} up to date`);
    } else {
      ok(`/${skill.name} installed`);
    }
  }

  const skipped = SKILLS.filter((s) => !integrations.includes(s.integration));
  for (const skill of skipped) {
    info(dim(`/${skill.name} not installed (integration not selected)`));
  }
  return conflicts;
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

  info('Start a new Claude Code session, then ask for what you need:');
  for (const integration of integrations) info(dim(`  ${EXAMPLES[integration]}`));
  flowEnd(`check anything still missing with ${bold('npx @masanao-ohba/ws-skills doctor')}`);
}

export async function installCommand({ force = false, skipSetup = false } = {}) {
  flowStart('ws-skills');
  info('Installs the ws-* Claude Code skills and the tooling behind them.');
  info(dim(`skills: ${tildify(skillsDir())}`));
  info(dim(`credentials: ${tildify(configHome())}`));

  heading('Copying the tooling');
  await copyPayload();

  heading('Credentials');
  const wizard = skipSetup ? null : await runWizard();
  const integrations = wizard ? wizard.integrations : SKILLS.map((s) => s.integration);

  heading('Installing the skills into Claude Code');
  const conflicts = await installChosen(integrations, { force });
  await removeLegacyInstall();

  // Credentials collected is not the same as authorized: Google needs a consent
  // flow and Slack may need a sign-in, both interactive.
  let pending = [];
  if (wizard && interactive()) {
    heading('Authorization');
    pending = await authorize(wizard.values);
  }

  nextSteps(integrations, pending);

  if (conflicts.length) {
    warn(
      `not installed: ${conflicts.map((c) => `/${c}`).join(', ')} — ` +
        're-run with --force to move the existing entries aside',
    );
    return 1;
  }
  return 0;
}
