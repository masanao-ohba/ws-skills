import fs from 'node:fs/promises';
import path from 'node:path';

import { exists } from '../lib/fsx.mjs';
import { readEnvFile } from '../lib/envfile.mjs';
import {
  configHome,
  envFile,
  googleDir,
  installedSkillsDir,
  slackDir,
  tildify,
  toolsCommand,
  toolsDir,
} from '../lib/paths.mjs';
import { SKILLS, linkStatus } from '../lib/skills.mjs';
import { playwrightBrowsersInstalled, pythonVersion, uvVersion, UV_INSTALL_HINT } from '../lib/prereq.mjs';
import { configuredIntegrations } from './setup.mjs';
import { bad, bold, dim, heading, info, ok, warn } from '../lib/ui.mjs';

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
  heading(`Install home ${dim(tildify(configHome()))}`);
  let problems = 0;

  if (await exists(path.join(toolsDir(), 'main.py'))) {
    ok(`tools at ${tildify(toolsDir())}`);
  } else {
    bad(`tools missing — run ${bold('npx @masanao-ohba/ws-skills install')}`);
    problems += 1;
  }

  for (const skill of SKILLS) {
    const installed = await exists(path.join(installedSkillsDir(), skill.name, 'SKILL.md'));
    const status = await linkStatus(skill.name);
    if (!installed) {
      bad(`${skill.name}: not installed`);
      problems += 1;
    } else if (status.state === 'ours') {
      ok(`/${skill.name} ${dim(`-> ${tildify(status.want)}`)}`);
    } else if (status.state === 'absent') {
      warn(`/${skill.name} not linked into ${tildify(path.dirname(status.link))}`);
    } else {
      warn(`/${skill.name} points somewhere else: ${tildify(status.target)}`);
    }
  }
  return problems;
}

async function checkSettings(values) {
  heading(`Settings ${dim(tildify(envFile()))}`);
  if (!(await exists(envFile()))) {
    bad(`no settings file — run ${bold('ws-skills setup')}`);
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
    else warn(`${profile}: not authorized yet — run ${dim(`${toolsCommand()} auth --profile ${profile}`)}`);

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
  } else {
    if (await exists(path.join(slackDir(), 'state.json'))) ok('saved browser session present');
    else if (values.SLACK_EMAIL && values.SLACK_PASSWORD) {
      warn('no saved session yet — the first run will log in and save one');
    } else {
      bad(
        `no saved session and no stored login — run ` +
          dim(`${toolsCommand()} slack-signin --url https://<workspace>.slack.com/`),
      );
      problems += 1;
    }
    if (await playwrightBrowsersInstalled()) ok('Playwright browsers installed');
    else {
      bad(
        `Chromium not installed — run ` +
          dim(`uv run --project ${tildify(toolsDir())} python -m playwright install chromium`),
      );
      problems += 1;
    }
  }

  if (values.SLACK_TEAM_ID) ok(`default team ${values.SLACK_TEAM_ID}`);
  else warn('no SLACK_TEAM_ID — pass --team-id on every run');
  return problems;
}

export async function doctorCommand() {
  console.log(bold('\nws-skills doctor'));
  const values = await readEnvFile(envFile());
  const integrations = configuredIntegrations(values);

  let problems = 0;
  problems += await checkTooling();
  problems += await checkInstall();
  problems += await checkSettings(values);
  if (integrations.includes('backlog')) problems += await checkBacklog(values);
  if (integrations.includes('google')) problems += await checkGoogle(values);
  if (integrations.includes('slack')) problems += await checkSlack(values);

  console.log('');
  if (problems === 0) {
    ok('everything the selected integrations need is in place');
    return 0;
  }
  warn(problems === 1 ? '1 item still needs attention' : `${problems} items still need attention`);
  return 1;
}
