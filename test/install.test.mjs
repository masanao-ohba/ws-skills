import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'cli.mjs');

const SKILL_NAMES = ['ws-google', 'ws-slack', 'ws-backlog'];

/** A throwaway install home + Claude config dir, cleaned up afterwards. */
async function sandbox(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-skills-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    env: {
      ...process.env,
      WS_SKILLS_HOME: path.join(dir, 'home'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      NO_COLOR: '1',
    },
    home: path.join(dir, 'home'),
    skills: path.join(dir, 'claude', 'skills'),
    tools: path.join(dir, 'claude', 'skills', 'ws-skills-tools'),
  };
}

async function cliRun(env, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('install puts every skill and the shared tooling under the skills directory', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);

  assert.equal(code, 0, stdout);
  assert.ok(await fs.stat(path.join(box.tools, 'main.py')));
  assert.ok(await fs.stat(path.join(box.tools, 'scripts', 'slack_api.py')));

  for (const name of SKILL_NAMES) {
    const dir = path.join(box.skills, name);
    assert.ok((await fs.lstat(dir)).isDirectory(), `${name} should be a real directory`);
    const skillFile = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    assert.match(skillFile, new RegExp(`^---\\nname: ${name}\\n`));

    // The whole point of the layout: what a skill runs is reachable from inside
    // the skill, not from a config directory somewhere else.
    const tools = path.join(dir, 'tools');
    assert.ok((await fs.lstat(tools)).isSymbolicLink(), `${name}/tools should be a link`);
    assert.equal(await fs.realpath(tools), await fs.realpath(box.tools));
    assert.ok(await fs.stat(path.join(tools, 'main.py')));
  }

  // Credentials only — nothing executable is left in the config home.
  await assert.rejects(fs.stat(path.join(box.home, 'tools')));
  await assert.rejects(fs.stat(path.join(box.home, 'skills')));
});

test('every skill documents commands that run from inside the skill', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);

  for (const name of SKILL_NAMES) {
    const text = await fs.readFile(path.join(box.skills, name, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`~/\\.claude/skills/${name}/tools`));
    assert.doesNotMatch(text, /\.config\/ws-skills\/tools/, `${name} still points at the config home`);
  }
});

test('a second install is idempotent', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);

  assert.equal(code, 0, stdout);
  assert.match(stdout, /up to date/);
  const entries = await fs.readdir(box.skills);
  assert.deepEqual(entries.sort(), [...SKILL_NAMES, 'ws-skills-tools'].sort());
});

test('install never overwrites an unrelated skill of the same name', async (t) => {
  const box = await sandbox(t);
  const existing = path.join(box.skills, 'ws-google');
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, 'SKILL.md'), 'someone else\n');

  const first = await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(first.code, 1, 'conflict should be reported, not silently resolved');
  assert.equal(await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8'), 'someone else\n');

  const forced = await cliRun(box.env, ['install', '--no-setup', '--force']);
  assert.equal(forced.code, 0, forced.stdout);
  assert.ok(await fs.stat(path.join(existing, 'tools', 'main.py')));

  const inSkills = (await fs.readdir(box.skills)).filter((e) => e.includes('.backup-'));
  assert.deepEqual(inSkills, [], 'no backup may sit under the skills directory — Claude would list it as a duplicate skill');

  const backupsHome = path.join(box.home, 'backups');
  const backups = (await fs.readdir(backupsHome)).filter((e) => e.startsWith('ws-google.backup-'));
  assert.equal(backups.length, 1, 'the previous entry should be kept as a backup');
  assert.equal(
    await fs.readFile(path.join(backupsHome, backups[0], 'SKILL.md'), 'utf8'),
    'someone else\n',
  );
});

test('an upgrade drops files that no longer exist upstream', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const stale = path.join(box.tools, 'scripts', 'stale_module.py');
  await fs.writeFile(stale, '# left over from an older version\n');

  await cliRun(box.env, ['install', '--no-setup']);
  await assert.rejects(fs.stat(stale));
});

test('an upgrade keeps the Python virtualenv uv built', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const venv = path.join(box.tools, '.venv');
  await fs.mkdir(venv, { recursive: true });
  await fs.writeFile(path.join(venv, 'pyvenv.cfg'), 'home = /usr\n');

  await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(await fs.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8'), 'home = /usr\n');
});

test('install --no-setup does not start an authorization step', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);

  assert.equal(code, 0, stdout);
  assert.doesNotMatch(stdout, /Authorization/);
  assert.match(stdout, /Start a new Claude Code session/);
  assert.doesNotMatch(stdout, /uv run --project/, 'the raw tooling command is not a user surface');
});

test('auth refuses to guess when nothing is configured', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code, stdout } = await cliRun(box.env, ['auth']);

  assert.equal(code, 1);
  assert.match(stdout, /nothing is configured yet/);
});

test('auth refuses to run without a terminal rather than hanging', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  await fs.mkdir(box.home, { recursive: true });
  await fs.writeFile(path.join(box.home, '.env'), 'WS_INTEGRATIONS=google\n');

  const { code, stdout } = await cliRun(box.env, ['auth']);
  assert.equal(code, 1);
  assert.match(stdout, /interactive terminal/);
});

test('doctor reports missing credentials without crashing', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code, stdout } = await cliRun(box.env, ['doctor']);

  assert.equal(code, 1, 'a fresh install has nothing authorized yet');
  assert.match(stdout, /ws-skills doctor/);
  assert.match(stdout, /Skills/);
  assert.match(stdout, /Credentials/);
  for (const name of SKILL_NAMES) assert.match(stdout, new RegExp(`/${name}`));
});

test('uninstall removes our skills and keeps the tooling and credentials', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code } = await cliRun(box.env, ['uninstall']);

  assert.equal(code, 0);
  assert.deepEqual(await fs.readdir(box.skills), ['ws-skills-tools']);
  assert.ok(await fs.stat(path.join(box.tools, 'main.py')));
});

test('uninstall leaves a skill it did not install alone', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const theirs = path.join(box.skills, 'ws-slack');
  await fs.rm(path.join(theirs, '.ws-skills-install'));

  const { code } = await cliRun(box.env, ['uninstall']);
  assert.equal(code, 0);
  assert.ok(await fs.stat(path.join(theirs, 'SKILL.md')));
});

test('uninstall --purge --force deletes the tooling and the credentials', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code } = await cliRun(box.env, ['uninstall', '--purge', '--force']);

  assert.equal(code, 0);
  await assert.rejects(fs.stat(box.home));
  await assert.rejects(fs.stat(box.tools));
});

test('an upgrade from the old layout moves the install and keeps the virtualenv', async (t) => {
  const box = await sandbox(t);

  // What an earlier version left behind: tools and skill copies in the config
  // home, with ~/.claude/skills holding symlinks into it.
  const legacyTools = path.join(box.home, 'tools');
  const legacySkills = path.join(box.home, 'skills');
  await fs.mkdir(path.join(legacyTools, '.venv'), { recursive: true });
  await fs.writeFile(path.join(legacyTools, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  await fs.mkdir(box.skills, { recursive: true });
  for (const name of SKILL_NAMES) {
    await fs.mkdir(path.join(legacySkills, name), { recursive: true });
    await fs.writeFile(path.join(legacySkills, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    await fs.symlink(path.join(legacySkills, name), path.join(box.skills, name));
  }

  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(code, 0, stdout);

  // Re-downloading every Python dependency on an upgrade is not acceptable, so
  // the virtualenv moves rather than being rebuilt.
  assert.equal(await fs.readFile(path.join(box.tools, '.venv', 'pyvenv.cfg'), 'utf8'), 'home = /usr\n');
  await assert.rejects(fs.stat(legacyTools));
  await assert.rejects(fs.stat(legacySkills));

  for (const name of SKILL_NAMES) {
    const dir = path.join(box.skills, name);
    assert.ok((await fs.lstat(dir)).isDirectory(), `${name} should no longer be a link`);
    assert.ok(await fs.stat(path.join(dir, 'tools', 'main.py')));
  }
});

test('an upgrade that reselects only some integrations leaves the rest untouched', async (t) => {
  const box = await sandbox(t);

  // Same pre-upgrade legacy layout as above, but this run's .env already
  // narrows WS_INTEGRATIONS to google+slack — as if ws-backlog was configured
  // by an earlier version and this run's (non-interactive, so no prompt)
  // wizard does not reselect it.
  const legacyTools = path.join(box.home, 'tools');
  const legacySkills = path.join(box.home, 'skills');
  await fs.mkdir(path.join(legacyTools, '.venv'), { recursive: true });
  await fs.writeFile(path.join(legacyTools, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  await fs.mkdir(box.skills, { recursive: true });
  for (const name of SKILL_NAMES) {
    await fs.mkdir(path.join(legacySkills, name), { recursive: true });
    await fs.writeFile(path.join(legacySkills, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    await fs.symlink(path.join(legacySkills, name), path.join(box.skills, name));
  }
  await fs.mkdir(box.home, { recursive: true });
  await fs.writeFile(path.join(box.home, '.env'), 'WS_INTEGRATIONS=google,slack\n');

  const { code, stdout } = await cliRun(box.env, ['install']);
  assert.equal(code, 0, stdout);

  assert.ok((await fs.lstat(path.join(box.skills, 'ws-google'))).isDirectory());
  assert.ok((await fs.lstat(path.join(box.skills, 'ws-slack'))).isDirectory());

  // ws-backlog was not reselected — its previous install must survive, not
  // vanish silently, and the run must say so.
  const backlogLink = await fs.readlink(path.join(box.skills, 'ws-backlog')).catch(() => null);
  assert.ok(backlogLink, "ws-backlog should still be the previous version's link, not removed");
  assert.match(stdout, /ws-backlog: left as the previous version's link/);
});

test('help and version do not touch the filesystem', async (t) => {
  const box = await sandbox(t);
  const help = await cliRun(box.env, ['--help']);
  const version = await cliRun(box.env, ['--version']);

  assert.equal(help.code, 0);
  assert.match(help.stdout, /ws-skills/);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /@masanao-ohba\/ws-skills \d+\.\d+\.\d+/);
  await assert.rejects(fs.stat(box.home));
});

test('an unknown command exits with a usage error', async (t) => {
  const box = await sandbox(t);
  const { code, stderr } = await cliRun(box.env, ['frobnicate']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command/);
});
