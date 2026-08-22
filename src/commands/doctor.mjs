import fs from 'node:fs/promises';
import path from 'node:path';

import { exists } from '../lib/fsx.mjs';
import { readEnvFile } from '../lib/envfile.mjs';
import {
  AGENT_LINKS,
  agentSkillLink,
  configHome,
  envFile,
  googleDir,
  skillDir,
  skillToolsLink,
  skillsDir,
  slackDir,
  tildify,
  toolsDir,
} from '../lib/paths.mjs';
import { SKILLS } from '../lib/skills.mjs';
import { playwrightBrowsersInstalled, pythonVersion, uvVersion, UV_INSTALL_HINT } from '../lib/prereq.mjs';
import { configuredIntegrations } from './setup.mjs';
import { bad, bold, dim, flowEnd, flowStart, heading, info, ok, warn } from '../lib/ui.mjs';

const RUN_AUTH = 'npx @masanao-ohba/ws-skills auth';

const RUN_INSTALL = 'npx @masanao-ohba/ws-skills';

const RUN_UPDATE = 'npx @masanao-ohba/ws-skills update';

async function checkTooling() {
  heading('Tooling');
  const uv = uvVersion();
  if (uv) ok(`uv ${dim(uv)}`);
  else bad(UV_INSTALL_HINT);

  const python = pythonVersion();
  if (python) ok(`${python} ${dim('(uv provides its own if this one is too old)')}`);
  else warn('python3 not found on PATH — uv will download one when it first runs');

  ok(`node ${process.version}`);
  return uv ? 0 : 1;
}

async function checkInstall() {
  heading(`Skills ${dim(tildify(skillsDir()))}`);
  let problems = 0;

  if (await exists(path.join(toolsDir(), 'main.py'))) {
    ok(`tooling at ${tildify(toolsDir())}`);
  } else {
    bad(`tooling missing — run ${bold(RUN_UPDATE)}`);
    problems += 1;
  }

  for (const skill of SKILLS) {
    if (!(await exists(path.join(skillDir(skill.name), 'SKILL.md')))) {
      bad(`/${skill.name}: not installed — run ${bold(RUN_UPDATE)}`);
      problems += 1;
      continue;
    }
    // Every command in SKILL.md runs through this link.
    if (!(await exists(path.join(skillToolsLink(skill.name), 'main.py')))) {
      bad(`/${skill.name}: ${tildify(skillToolsLink(skill.name))} does not reach the tooling`);
      problems += 1;
      continue;
    }

    // Agents reading ~/.agents/skills need nothing; the rest need their link.
    // Where it lands is the question — someone else's skill of the same name
    // also has a SKILL.md, and reaches nothing of ours.
    const real = await fs.realpath(skillDir(skill.name)).catch(() => null);
    const missing = [];
    for (const agent of AGENT_LINKS) {
      const reached = await fs.realpath(agentSkillLink(agent, skill.name)).catch(() => null);
      if (reached !== real) missing.push(agent.label);
    }
    if (missing.length) {
      bad(`/${skill.name}: not reachable from ${missing.join(', ')} — run ${bold(RUN_UPDATE)}`);
      problems += 1;
    } else {
      ok(`/${skill.name}`);
    }
  }
  return problems;
}

async function checkSettings(values) {
  heading(`Credentials ${dim(tildify(configHome()))}`);
  if (!(await exists(envFile()))) {
    bad(`no settings file — run ${bold(RUN_INSTALL)}`);
    return 1;
  }
  const mode = (await fs.stat(envFile())).mode & 0o777;
  if (mode === 0o600) ok('permissions 600');
  else warn(`permissions ${mode.toString(8)} — should be 600 (it holds API keys)`);

  const integrations = configuredIntegrations(values);
  info(`integrations: ${integrations.join(', ') || dim('none selected')}`);
  return 0;
}

async function checkBacklog(values) {
  heading('Backlog');
  let problems = 0;
  if (values.BACKLOG_DOMAIN) ok(`space ${values.BACKLOG_DOMAIN}`);
  else {
    bad('BACKLOG_DOMAIN is not set');
    problems += 1;
  }
  if (values.BACKLOG_API_KEY) ok('API key set');
  else {
    bad('BACKLOG_API_KEY is not set');
    problems += 1;
  }
  const scoped = Object.keys(values).filter((k) => k.startsWith('BACKLOG_API_KEY_'));
  for (const key of scoped) ok(`project-scoped key for ${key.replace('BACKLOG_API_KEY_', '')}`);
  return problems;
}

async function checkGoogle(values) {
  heading('Google');
  let problems = 0;
  const profiles = (values.GOOGLE_PROFILES || 'default').split(',').map((p) => p.trim());
  for (const profile of profiles) {
    const suffix = profile === 'default' ? '' : `_${profile}`;
    const client = path.join(googleDir(), `credentials${suffix}.json`);
    const token = path.join(googleDir(), `token_readonly${suffix}.json`);
    if (await exists(client)) ok(`${profile}: OAuth client present`);
    else {
      bad(`${profile}: no OAuth client at ${tildify(client)}`);
      problems += 1;
    }
    if (await exists(token)) ok(`${profile}: read-only token present`);
    else warn(`${profile}: not authorized yet — run ${bold(RUN_AUTH)}`);

    for (const service of ['sheets', 'docs']) {
      if (await exists(path.join(googleDir(), `token_${service}${suffix}.json`))) {
        ok(`${profile}: ${service} write token present`);
      } else {
        info(dim(`${profile}: no ${service} write token (only needed to write)`));
      }
    }
  }
  return problems;
}

async function checkSlack(values) {
  heading('Slack');
  let problems = 0;
  const backend = values.WS_SLACK_BACKEND || (values.SLACK_TOKEN ? 'api' : 'browser');
  info(`backend: ${backend}`);

  if (backend === 'api') {
    if (values.SLACK_TOKEN) ok('token set');
    else {
      bad('SLACK_TOKEN is not set');
      problems += 1;
    }
  } else if (values.SLACK_FROM_APP === '1') {
    // Nothing of ours to check: only the app itself knows whether it is signed in.
    ok('using the Slack desktop app session (keep the app signed in)');
  } else {
    if (await exists(path.join(slackDir(), 'state.json'))) ok('saved browser session present');
    else if (values.SLACK_EMAIL && values.SLACK_PASSWORD) {
      warn('no saved session yet — the first run will log in and save one');
    } else {
      bad(`no saved session and no stored login — run ${bold(RUN_AUTH)}`);
      problems += 1;
    }
    if (await playwrightBrowsersInstalled()) ok('Playwright browsers installed');
    else {
      bad(`Chromium not installed — run ${bold(RUN_AUTH)}`);
      problems += 1;
    }
  }

  if (values.SLACK_TEAM_ID) ok(`default team ${values.SLACK_TEAM_ID}`);
  else warn('no SLACK_TEAM_ID — pass --team-id on every run');
  return problems;
}

export async function doctorCommand() {
  flowStart('ws-skills doctor');
  const values = await readEnvFile(envFile());
  const integrations = configuredIntegrations(values);

  let problems = 0;
  problems += await checkTooling();
  problems += await checkInstall();
  problems += await checkSettings(values);
  if (integrations.includes('backlog')) problems += await checkBacklog(values);
  if (integrations.includes('google')) problems += await checkGoogle(values);
  if (integrations.includes('slack')) problems += await checkSlack(values);

  flowEnd(
    problems === 0
      ? 'everything the selected integrations need is in place'
      : problems === 1
        ? '1 item still needs attention'
        : `${problems} items still need attention`,
  );
  return problems === 0 ? 0 : 1;
}
