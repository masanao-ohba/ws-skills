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

test('install copies the payload and links every skill as a symlink', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);

  assert.equal(code, 0, stdout);
  assert.ok(await fs.stat(path.join(box.home, 'tools', 'main.py')));
  assert.ok(await fs.stat(path.join(box.home, 'tools', 'scripts', 'slack_api.py')));

  for (const name of SKILL_NAMES) {
    const link = path.join(box.skills, name);
    const stat = await fs.lstat(link);
    assert.ok(stat.isSymbolicLink(), `${name} should be a symlink`);
    assert.equal(await fs.realpath(link), await fs.realpath(path.join(box.home, 'skills', name)));
    const skillFile = await fs.readFile(path.join(link, 'SKILL.md'), 'utf8');
    assert.match(skillFile, new RegExp(`^---\\nname: ${name}\\n`));
  }
});

test('a second install is idempotent', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);

  assert.equal(code, 0, stdout);
  assert.match(stdout, /already linked/);
  const entries = await fs.readdir(box.skills);
  assert.deepEqual(entries.sort(), [...SKILL_NAMES].sort());
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
  assert.ok((await fs.lstat(existing)).isSymbolicLink());

  const backups = (await fs.readdir(box.skills)).filter((e) => e.startsWith('ws-google.backup-'));
  assert.equal(backups.length, 1, 'the previous entry should be kept as a backup');
  assert.equal(
    await fs.readFile(path.join(box.skills, backups[0], 'SKILL.md'), 'utf8'),
    'someone else\n',
  );
});

test('an upgrade drops files that no longer exist upstream', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const stale = path.join(box.home, 'tools', 'scripts', 'stale_module.py');
  await fs.writeFile(stale, '# left over from an older version\n');

  await cliRun(box.env, ['install', '--no-setup']);
  await assert.rejects(fs.stat(stale));
});

test('an upgrade keeps the Python virtualenv uv built', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const venv = path.join(box.home, 'tools', '.venv');
  await fs.mkdir(venv, { recursive: true });
  await fs.writeFile(path.join(venv, 'pyvenv.cfg'), 'home = /usr\n');

  await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(await fs.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8'), 'home = /usr\n');
});

test('doctor reports missing credentials without crashing', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code, stdout } = await cliRun(box.env, ['doctor']);

  assert.equal(code, 1, 'a fresh install has nothing authorized yet');
  assert.match(stdout, /ws-skills doctor/);
  assert.match(stdout, /Install home/);
  for (const name of SKILL_NAMES) assert.match(stdout, new RegExp(`/${name}`));
});

test('uninstall removes our symlinks and keeps the install home', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code } = await cliRun(box.env, ['uninstall']);

  assert.equal(code, 0);
  assert.deepEqual(await fs.readdir(box.skills), []);
  assert.ok(await fs.stat(path.join(box.home, 'tools', 'main.py')));
});

test('uninstall --purge --force deletes the install home', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code } = await cliRun(box.env, ['uninstall', '--purge', '--force']);

  assert.equal(code, 0);
  await assert.rejects(fs.stat(box.home));
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
