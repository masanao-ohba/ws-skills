import path from 'node:path';
import os from 'node:os';

import { copySecret, ensureDir, exists, writeSecret } from '../lib/fsx.mjs';
import { readEnvFile, renderEnv } from '../lib/envfile.mjs';
import { ask, askSecret, confirm, interactive, selectMany, selectOne } from '../lib/prompt.mjs';
import { configHome, envFile, googleDir, slackDir, tildify } from '../lib/paths.mjs';
import { INTEGRATIONS, SKILLS } from '../lib/skills.mjs';
import { bar, dim, heading, info, ok, warn } from '../lib/ui.mjs';

const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/** Integrations that already have enough configured to be considered set up. */
export function configuredIntegrations(values) {
  const enabled = (values.WS_INTEGRATIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (enabled.length) return enabled.filter((i) => INTEGRATIONS.includes(i));

  const guess = [];
  if (values.BACKLOG_API_KEY) guess.push('backlog');
  if (values.SLACK_TOKEN || values.SLACK_TEAM_ID) guess.push('slack');
  return guess;
}

async function setupBacklog(values) {
  heading('Backlog', 'read-only: issues, comments, wikis, activities');

  values.BACKLOG_DOMAIN = await ask('Backlog space host', {
    def: values.BACKLOG_DOMAIN || '',
    hint: 'the host part of your Backlog URL, e.g. yourspace.backlog.jp or yourspace.backlog.com',
  });

  const key = await askSecret('Backlog API key', {
    keep: Boolean(values.BACKLOG_API_KEY),
    hint: 'Personal Settings → API → Register new key',
  });
  if (key) values.BACKLOG_API_KEY = key;
  else if (!values.BACKLOG_API_KEY) warn('no API key set — ws-backlog will not run until there is one');

  // An explicit question each round, rather than a bare "blank to stop" prompt.
  let another = await confirm('Add a key that is scoped to a single project?', false, {
    hint: 'a key someone shared with you, that reaches that project only',
  });
  while (another) {
    const project = (await ask('Project key', { def: '', hint: 'e.g. ABC123' })).toUpperCase();
    if (!project) break;

    const scoped = await askSecret(`API key for ${project}`);
    if (scoped) values[`BACKLOG_API_KEY_${project}`] = scoped;

    const other = await ask(`Space host for ${project}`, {
      def: '',
      hint: 'press Enter unless that project lives in a different Backlog space',
    });
    if (other) values[`BACKLOG_DOMAIN_${project}`] = other;
    ok(`${project}: scoped key stored`);

    another = await confirm('Add another project-scoped key?', false);
  }
}

async function setupGoogle(values) {
  heading('Google Workspace', 'read and write hold separate tokens');
  bar(dim(`OAuth client JSON files live in ${tildify(googleDir())}`));
  bar(dim('create one: Cloud Console → Credentials → OAuth client ID → Desktop app'));

  // Profiles exist for a second Google organization, which most setups never need.
  const configured = (values.GOOGLE_PROFILES || 'default')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && p !== 'default');

  let extras = configured;
  if (extras.length) {
    bar(`extra profiles: ${extras.join(', ')}`);
    if (await confirm('Remove them?', false, { hint: 'their tokens stay on disk, unused' })) {
      extras = [];
    }
  }

  const askForMore = extras.length
    ? 'Add one more organization?'
    : 'Do you work with a second Google organization?';
  if (
    await confirm(askForMore, false, {
      hint: 'an OAuth client registered "Internal" rejects accounts from any other organization',
    })
  ) {
    while (true) {
      const name = await askProfileName(extras);
      if (!name) break;
      extras.push(name);
      if (!(await confirm('Add another?', false))) break;
    }
  }

  const profiles = ['default', ...extras];
  values.GOOGLE_PROFILES = profiles.join(',');

  await ensureDir(googleDir(), 0o700);
  for (const profile of profiles) {
    const target = path.join(
      googleDir(),
      profile === 'default' ? 'credentials.json' : `credentials_${profile}.json`,
    );
    if (await exists(target)) {
      ok(`${profile}: OAuth client already at ${tildify(target)}`);
      continue;
    }
    const source = await ask(`Path to the OAuth client JSON for profile "${profile}"`, {
      def: '',
      hint: 'blank to skip — you can drop the file in later',
    });
    if (!source) {
      warn(`${profile}: no OAuth client yet — save it to ${tildify(target)} before authorizing`);
      continue;
    }
    const resolved = expand(source);
    if (!(await exists(resolved))) {
      warn(`not found: ${resolved} — skipped`);
      continue;
    }
    await copySecret(resolved, target);
    ok(`${profile}: OAuth client copied to ${tildify(target)}`);
  }
}

/** A profile name becomes part of a filename, so keep it to a short plain label. */
async function askProfileName(taken) {
  while (true) {
    const name = await ask('Name for that organization', {
      def: '',
      hint: 'a short label used in the token filenames, e.g. work, legacy — blank to stop',
    });
    if (!name) return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(name)) {
      warn('letters, digits, - and _ only (up to 20 characters)');
      continue;
    }
    if (name === 'default' || taken.includes(name)) {
      warn(`${name} is already in use`);
      continue;
    }
    return name;
  }
}

async function setupSlack(values) {
  heading('Slack', 'channels, DMs and thread replies');
  const backend = await selectOne(
    'Which backend should Slack collection use?',
    [
      {
        value: 'api',
        label: 'Slack Web API (token)',
        hint: 'faster and exact — needs an app installed in the workspace',
      },
      {
        value: 'browser',
        label: 'Browser automation (no token)',
        hint: 'when API access is not granted; drives its own Chromium',
      },
    ],
    values.WS_SLACK_BACKEND === 'browser' ? 1 : 0,
  );
  values.WS_SLACK_BACKEND = backend;

  if (backend === 'api') {
    bar('scopes to grant: channels:history, groups:history, im:history, mpim:history,');
    bar('channels:read, groups:read, im:read, mpim:read, users:read');
    const token = await askSecret('Slack token (xoxp-... or xoxb-...)', {
      keep: Boolean(values.SLACK_TOKEN),
    });
    if (token) values.SLACK_TOKEN = token;
    else if (!values.SLACK_TOKEN) warn('no token set — ws-slack will fall back to the browser backend');
  } else {
    delete values.SLACK_TOKEN;
  }

  values.SLACK_TEAM_ID = await ask('Default team ID', {
    def: values.SLACK_TEAM_ID || '',
    hint: 'the T... segment of https://app.slack.com/client/T.../C... — blank if you always pass --team-id',
  });

  if (backend === 'browser') {
    values.SLACK_WORKSPACE = await ask('Workspace subdomain', {
      def: values.SLACK_WORKSPACE || '',
      hint: 'the xxx of https://xxx.slack.com',
    });

    // Google refuses sign-in inside an automation-controlled browser, so borrowing
    // the desktop app's session is the only way into such a workspace.
    const sources = [];
    if (process.platform === 'darwin') {
      sources.push({
        value: 'app',
        label: "Borrow the Slack desktop app's session",
        hint: 'macOS; the only way in when the workspace signs in through Google',
      });
    }
    sources.push({
      value: 'signin',
      label: 'Sign in once in a Chromium window',
      hint: 'fine for password or SAML sign-in; Google sign-in is blocked there',
    });
    sources.push({
      value: 'password',
      label: 'Store an email and password',
      hint: 'unattended, but no use behind Google sign-in or MFA',
    });

    const current = values.SLACK_FROM_APP === '1' ? 'app' : values.SLACK_EMAIL ? 'password' : 'signin';
    const source = await selectOne(
      'How should collection get its Slack session?',
      sources,
      Math.max(0, sources.findIndex((o) => o.value === current)),
    );

    delete values.SLACK_FROM_APP;
    if (source === 'app') {
      values.SLACK_FROM_APP = '1';
      delete values.SLACK_EMAIL;
      delete values.SLACK_PASSWORD;
      bar(dim('keep the desktop app signed in; its cookies are read at collection time'));
    } else if (source === 'password') {
      values.SLACK_EMAIL = await ask('Slack account email', { def: values.SLACK_EMAIL || '' });
      const password = await askSecret('Slack password', { keep: Boolean(values.SLACK_PASSWORD) });
      if (password) values.SLACK_PASSWORD = password;
      values.SLACK_AUTH_METHOD = await selectOne(
        'How does that account sign in?',
        [
          { value: 'sso', label: 'Single sign-on (Entra ID, Okta, SAML)' },
          { value: 'email_code', label: 'Email + password + emailed verification code' },
        ],
        values.SLACK_AUTH_METHOD === 'email_code' ? 1 : 0,
      );
    } else {
      delete values.SLACK_EMAIL;
      delete values.SLACK_PASSWORD;
      bar(dim('a one-time sign-in step follows right after this'));
    }

    await ensureDir(slackDir(), 0o700);
  }
}

/**
 * Ask for everything the chosen integrations need and write the shared .env.
 *
 * Existing values are the defaults, so a re-run is a safe way to change one thing.
 */
export async function runWizard({ only = null } = {}) {
  const values = await readEnvFile(envFile());
  const previous = configuredIntegrations(values);

  let chosen;
  if (only) {
    chosen = only;
  } else if (!interactive()) {
    chosen = previous.length ? previous : INTEGRATIONS;
    info(`not a terminal — keeping the current integrations (${chosen.join(', ') || 'none'})`);
  } else {
    chosen = await selectMany(
      'Which integrations do you want to set up?',
      SKILLS.map((s) => ({ value: s.integration, label: s.label, hint: `/${s.name}` })),
      previous.length ? previous : INTEGRATIONS,
    );
  }

  if (interactive()) {
    if (chosen.includes('backlog')) await setupBacklog(values);
    if (chosen.includes('google')) await setupGoogle(values);
    if (chosen.includes('slack')) await setupSlack(values);
  }

  values.WS_INTEGRATIONS = chosen.join(',');

  await ensureDir(configHome(), 0o700);
  await writeSecret(envFile(), renderEnv(values));
  ok(`settings written to ${tildify(envFile())} ${dim('(chmod 600)')}`);

  return { values, integrations: chosen };
}

