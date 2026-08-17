import assert from 'node:assert/strict';
import test from 'node:test';

import { parseEnv, renderEnv } from '../src/lib/envfile.mjs';

test('parseEnv ignores comments and strips quotes', () => {
  const values = parseEnv(
    ['# a comment', '', 'BACKLOG_DOMAIN=example.backlog.jp', "SLACK_TOKEN='xoxp-1'", 'BAD LINE'].join(
      '\n',
    ),
  );
  assert.deepEqual(values, { BACKLOG_DOMAIN: 'example.backlog.jp', SLACK_TOKEN: 'xoxp-1' });
});

test('parseEnv keeps = inside a value', () => {
  assert.equal(parseEnv('SLACK_TOKEN=xoxp-a=b=c').SLACK_TOKEN, 'xoxp-a=b=c');
});

test('renderEnv round-trips every value it was given', () => {
  const values = {
    BACKLOG_DOMAIN: 'example.backlog.jp',
    BACKLOG_API_KEY: 'key-1',
    BACKLOG_API_KEY_ABC123: 'key-2',
    GOOGLE_PROFILES: 'default,legacy',
    WS_SLACK_BACKEND: 'api',
    SLACK_TOKEN: 'xoxp-1',
    WS_INTEGRATIONS: 'google,slack,backlog',
  };
  assert.deepEqual(parseEnv(renderEnv(values)), values);
});

test('renderEnv keeps settings it does not manage', () => {
  const rendered = renderEnv({ BACKLOG_DOMAIN: 'example.backlog.jp', MY_OWN_SETTING: 'yes' });
  assert.equal(parseEnv(rendered).MY_OWN_SETTING, 'yes');
  assert.match(rendered, /Kept from the previous file/);
});

test('renderEnv omits empty values rather than writing blank keys', () => {
  const rendered = renderEnv({ BACKLOG_DOMAIN: 'example.backlog.jp', BACKLOG_API_KEY: '' });
  assert.ok(!rendered.includes('BACKLOG_API_KEY='));
});

test('renderEnv groups project-scoped Backlog keys with the Backlog section', () => {
  const rendered = renderEnv({ BACKLOG_API_KEY_ABC123: 'key' });
  const backlogSection = rendered.slice(rendered.indexOf('# --- Backlog ---'));
  assert.match(backlogSection, /BACKLOG_API_KEY_ABC123=key/);
  assert.ok(!rendered.includes('Kept from the previous file'));
});
