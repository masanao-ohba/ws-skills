import fs from 'node:fs/promises';

/** Parse a `KEY=value` file. Comments and blank lines are ignored. */
export function parseEnv(text) {
  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    values[key] = value;
  }
  return values;
}

export async function readEnvFile(file) {
  try {
    return parseEnv(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}

const SECTIONS = [
  {
    title: 'General',
    comment: [
      'WS_INTEGRATIONS records what setup configured; doctor and link read it.',
      'Output directories default to ./references/raw-source and',
      './references/working-notes under whatever directory you run from.',
      'Set them to send everything to one fixed place instead.',
    ],
    keys: ['WS_INTEGRATIONS', 'WS_OUTPUT_DIR', 'WS_NOTES_DIR'],
  },
  {
    title: 'Backlog',
    comment: [
      'BACKLOG_API_KEY_<PROJECT> takes precedence for that project and is never',
      'used for another — that is how a key shared with you stays scoped.',
      'Add BACKLOG_DOMAIN_<PROJECT> too if that project lives in another space.',
    ],
    keys: ['BACKLOG_DOMAIN', 'BACKLOG_API_KEY'],
    prefixes: ['BACKLOG_API_KEY_', 'BACKLOG_DOMAIN_'],
  },
  {
    title: 'Google',
    comment: [
      'One profile per Google organization; each needs its own OAuth client JSON',
      'in google/ (credentials.json, credentials_<profile>.json).',
    ],
    keys: ['GOOGLE_PROFILES', 'GOOGLE_OAUTH_PORT'],
  },
  {
    title: 'Slack',
    comment: [
      'WS_SLACK_BACKEND: api (needs SLACK_TOKEN) or browser (Playwright).',
      'Unset, it is api when SLACK_TOKEN exists, otherwise browser.',
      'SLACK_FROM_APP=1 borrows the Slack desktop app session (macOS) — the only',
      'way into a workspace that signs in through Google, which refuses to',
      'authenticate inside an automated browser.',
      'SLACK_EMAIL / SLACK_PASSWORD are only for the scripted login instead.',
    ],
    keys: [
      'WS_SLACK_BACKEND',
      'SLACK_FROM_APP',
      'SLACK_TOKEN',
      'SLACK_TEAM_ID',
      'SLACK_WORKSPACE',
      'SLACK_AUTH_METHOD',
      'SLACK_EMAIL',
      'SLACK_PASSWORD',
      'SLACK_LOCALE',
    ],
  },
];

const KNOWN_KEYS = new Set(SECTIONS.flatMap((s) => s.keys));
const KNOWN_PREFIXES = SECTIONS.flatMap((s) => s.prefixes ?? []);

function isKnown(key) {
  return KNOWN_KEYS.has(key) || KNOWN_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Render the shared .env.
 *
 * Keys the file already had that this tool does not manage are carried through
 * untouched.
 */
export function renderEnv(values) {
  const lines = [
    '# Settings for the ws-* agent skills.',
    '# Written by `ws-skills setup`. Safe to edit by hand — a later setup run',
    '# keeps whatever it finds here as the default.',
    '#',
    '# Resolution order: process environment > ./.env > this file.',
    '',
  ];

  for (const section of SECTIONS) {
    const keys = [
      ...section.keys.filter((k) => values[k]),
      ...Object.keys(values)
        .filter((k) => (section.prefixes ?? []).some((p) => k.startsWith(p)))
        .sort(),
    ];
    if (!keys.length) continue;
    lines.push(`# --- ${section.title} ---`);
    for (const comment of section.comment ?? []) lines.push(`# ${comment}`);
    for (const key of keys) lines.push(`${key}=${values[key]}`);
    lines.push('');
  }

  const extra = Object.keys(values)
    .filter((k) => !isKnown(k) && values[k])
    .sort();
  if (extra.length) {
    lines.push('# --- Kept from the previous file ---');
    for (const key of extra) lines.push(`${key}=${values[key]}`);
    lines.push('');
  }

  return lines.join('\n');
}
