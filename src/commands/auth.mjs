import path from 'node:path';

import { exists } from '../lib/fsx.mjs';
import { readEnvFile } from '../lib/envfile.mjs';
import { ask, confirm, interactive } from '../lib/prompt.mjs';
import { envFile, googleDir, slackDir } from '../lib/paths.mjs';
import { UV_INSTALL_HINT, playwrightBrowsersInstalled, uvVersion } from '../lib/prereq.mjs';
import { runPythonModule, runTool } from '../lib/tools.mjs';
import { configuredIntegrations } from './setup.mjs';
import { bad, bold, dim, flowEnd, flowStart, heading, info, ok } from '../lib/ui.mjs';

const CHROMIUM_DOWNLOAD_SIZE = '~150 MB';
const RERUN = 'npx @masanao-ohba/ws-skills auth';

const profileSuffix = (profile) => (profile === 'default' ? '' : `_${profile}`);

async function authorizeGoogle(values, { force }) {
  heading('Google');
  const profiles = (values.GOOGLE_PROFILES || 'default')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  const pending = [];
  for (const profile of profiles) {
    const suffix = profileSuffix(profile);
    const client = path.join(googleDir(), `credentials${suffix}.json`);
    if (!(await exists(client))) {
      bad(`${profile}: no OAuth client yet — run the installer again and point it at the JSON`);
      pending.push(`Google (${profile}): add the OAuth client JSON`);
      continue;
    }

    const token = path.join(googleDir(), `token_readonly${suffix}.json`);
    if ((await exists(token)) && !force) {
      ok(`${profile}: already authorized`);
    } else {
      const go = await confirm(`Authorize Google now for profile "${profile}"?`, true, {
        hint: 'a consent URL is printed below — open it in your browser and approve',
      });
      if (go) {
        info('waiting for your approval in the browser; this continues on its own');
        const result = await runTool(['auth', '--profile', profile]);
        if (result.uvMissing) {
          bad(UV_INSTALL_HINT);
          return [...pending, 'install uv'];
        }
        if (!result.ok) {
          bad(`${profile}: authorization did not complete`);
          pending.push(`Google (${profile}): authorize the read-only token`);
        }
      } else {
        pending.push(`Google (${profile}): authorize the read-only token`);
      }
    }

    // Writing is a second, separate credential — asked for only if it is wanted.
    for (const [service, what] of [['sheets', 'write cells in Sheets'], ['docs', 'append to Docs']]) {
      const writeToken = path.join(googleDir(), `token_${service}${suffix}.json`);
      if ((await exists(writeToken)) && !force) {
        ok(`${profile}: ${service} write token present`);
        continue;
      }
      if (
        await confirm(`Also authorize the separate token that lets the skill ${what}?`, false, {
          hint: 'another consent URL — skip it unless you need to write today',
        })
      ) {
        info('waiting for your approval in the browser; this continues on its own');
        await runTool(['auth', '--profile', profile, '--write', service]);
      }
    }
  }
  return pending;
}

async function authorizeSlack(values, { force }) {
  heading('Slack');
  const backend = values.WS_SLACK_BACKEND || (values.SLACK_TOKEN ? 'api' : 'browser');

  if (backend === 'api') {
    if (values.SLACK_TOKEN) {
      ok('API backend: the token is all it needs');
      return [];
    }
    bad('API backend selected but no token stored — run the installer again');
    return ['Slack: store an API token (run the installer again)'];
  }

  const pending = [];
  if (await playwrightBrowsersInstalled()) {
    ok('Chromium present');
  } else if (
    await confirm(`Download Chromium for Slack collection now? (${CHROMIUM_DOWNLOAD_SIZE})`, true, {
      hint: 'a one-off download; nothing opens on screen',
    })
  ) {
    info('downloading — this takes a minute');
    const result = await runPythonModule(['playwright', 'install', 'chromium']);
    if (result.uvMissing) {
      bad(UV_INSTALL_HINT);
      return [...pending, 'install uv'];
    }
    if (!result.ok) {
      bad('the Chromium download did not finish');
      pending.push('Slack: download Chromium');
    }
  } else {
    pending.push('Slack: download Chromium');
  }

  if (values.SLACK_FROM_APP === '1') {
    const store = path.join(
      process.env.HOME || '',
      'Library/Application Support/Slack/Cookies',
    );
    if (await exists(store)) {
      ok("the Slack desktop app's session will be used — keep the app signed in");
      return pending;
    }
    bad('the Slack desktop app is not installed, or has never signed in');
    return [...pending, 'Slack: sign in to the Slack desktop app'];
  }

  if ((await exists(path.join(slackDir(), 'state.json'))) && !force) {
    ok('saved session present');
    return pending;
  }
  if (values.SLACK_EMAIL && values.SLACK_PASSWORD) {
    info('stored login: the first collection signs in and saves the session');
    return pending;
  }
  const signIn = 'Slack: sign in once and save the session';

  // The workspace is already known here, so there is nothing to ask about it.
  let url = values.SLACK_WORKSPACE ? `https://${values.SLACK_WORKSPACE}.slack.com/` : '';

  const go = await confirm('Sign in to Slack now?', true, {
    hint: 'a separate Chromium window opens — sign in inside that window, not your usual browser',
  });
  if (!go) return [...pending, signIn];

  if (!url) {
    url = await ask('Workspace URL to sign in to', { hint: 'https://<workspace>.slack.com/' });
    if (!url) return [...pending, signIn];
  }

  info(`opening ${url}`);
  info('finish the sign-in in that window; this waits until the workspace is on screen');
  const result = await runTool(['slack-signin', '--url', url]);
  if (result.uvMissing) bad(UV_INSTALL_HINT);
  return result.ok ? pending : [...pending, signIn];
}

/**
 * Walk through whatever the configured integrations still need a person for.
 *
 * Returns descriptions of the steps left undone, so the caller can list them
 * rather than claiming a finished setup.
 */
export async function authorize(values, { force = false } = {}) {
  const integrations = configuredIntegrations(values);
  if (!integrations.length) return [];

  if (!uvVersion()) {
    bad(UV_INSTALL_HINT);
    return ['install uv, then run the authorization again'];
  }

  const pending = [];
  if (integrations.includes('google')) pending.push(...(await authorizeGoogle(values, { force })));
  if (integrations.includes('slack')) pending.push(...(await authorizeSlack(values, { force })));
  if (integrations.includes('backlog')) {
    heading('Backlog');
    ok('the API key is all it needs — nothing to authorize');
  }
  return pending;
}

export async function authCommand({ force = false } = {}) {
  flowStart('ws-skills auth');

  if (!(await exists(envFile()))) {
    bad('nothing is configured yet — run `npx @masanao-ohba/ws-skills` first');
    flowEnd('');
    return 1;
  }
  if (!interactive()) {
    bad('this needs an interactive terminal: a consent URL and a sign-in are involved');
    flowEnd('');
    return 1;
  }

  const pending = await authorize(await readEnvFile(envFile()), { force });
  if (!pending.length) {
    flowEnd('every step is done');
    return 0;
  }
  heading('Still to do');
  for (const item of pending) info(`- ${item}`);
  flowEnd(`run ${bold(RERUN)} to pick these up (${dim('--force redoes finished ones too')})`);
  return 1;
}
