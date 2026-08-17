import path from 'node:path';
import os from 'node:os';

import { copySecret, ensureDir, exists, writeSecret } from '../lib/fsx.mjs';
import { readEnvFile, renderEnv } from '../lib/envfile.mjs';
import { ask, askSecret, confirm, interactive, selectMany, selectOne } from '../lib/prompt.mjs';
import { configHome, envFile, googleDir, slackDir, tildify } from '../lib/paths.mjs';
import { INTEGRATIONS, SKILLS } from '../lib/skills.mjs';
import { bold, dim, heading, info, ok, warn } from '../lib/ui.mjs';

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
  heading('Backlog');
  info('A read-only client: issues, comments, wikis and activities, nothing written.');

  values.BACKLOG_DOMAIN = await ask('Backlog space host', {
    def: values.BACKLOG_DOMAIN || '',
    hint: 'the host part of your Backlog URL, e.g. yourspace.backlog.jp or yourspace.backlog.com',
  });

  const key = await askSecret('API key (Personal Settings -> API -> Register new key)', {
    keep: Boolean(values.BACKLOG_API_KEY),
  });
  if (key) values.BACKLOG_API_KEY = key;
  else if (!values.BACKLOG_API_KEY) warn('no API key set — ws-backlog will not run until there is one');

  if (
    await confirm(
      'Add a key that is scoped to a single project? (a key someone shared with you)',
      false,
    )
  ) {
    while (true) {
      const project = (await ask('Project key (blank to stop)', { def: '' })).toUpperCase();
      if (!project) break;
      const scoped = await askSecret(`API key for ${project}`);
      if (scoped) values[`BACKLOG_API_KEY_${project}`] = scoped;
      const other = await ask(`Space host for ${project} (blank if the same space)`, { def: '' });
      if (other) values[`BACKLOG_DOMAIN_${project}`] = other;
    }
  }
}

async function setupGoogle(values) {
  heading('Google Workspace');
  info('Read and write use separate tokens, so fetching can never write.');
  info(
    `OAuth client JSON files live in ${tildify(googleDir())} ` +
      '(create one: Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID -> Desktop app).',
  );

  const extra = await ask(
    'Extra profile names, comma separated (one per Google organization; blank for just "default")',
    { def: (values.GOOGLE_PROFILES || 'default').split(',').filter((p) => p !== 'default').join(',') },
  );
  const profiles = ['default', ...extra.split(',').map((p) => p.trim()).filter(Boolean)];
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
      warn(`${profile}: no OAuth client yet. Save it to ${tildify(target)} before authorizing.`);
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

async function setupSlack(values) {
  heading('Slack');
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
    info('Scopes to grant: channels:history, groups:history, im:history, mpim:history,');
    info('channels:read, groups:read, im:read, mpim:read, users:read.');
    info(dim('This backend is not exercised on the maintainer\'s own workspace — see the README.'));
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
    const scripted = await confirm(
      'Store an email/password for the scripted login? (no = sign in once by hand instead)',
      Boolean(values.SLACK_EMAIL),
    );
    if (scripted) {
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
      info('Sign in once with:');
      info(dim('  ws-skills doctor   # prints the exact command for your install'));
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

export async function setupCommand() {
  console.log(bold('\nws-skills setup'));
  const { integrations } = await runWizard();
  info(`configured: ${integrations.join(', ') || 'nothing'}`);
  info(`run ${dim('ws-skills doctor')} to check what is still missing`);
  return 0;
}
