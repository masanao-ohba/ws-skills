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

/** A throwaway install home, agents dir, and Claude config dir, cleaned up afterwards. */
async function sandbox(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-skills-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    dir,
    env: {
      ...process.env,
      WS_SKILLS_HOME: path.join(dir, 'home'),
      WS_AGENTS_DIR: path.join(dir, 'agents'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      NO_COLOR: '1',
    },
    home: path.join(dir, 'home'),
    // Where the skills really live, and where every agent but Claude Code reads them.
    skills: path.join(dir, 'agents', 'skills'),
    tools: path.join(dir, 'agents', 'skills', 'ws-skills-tools'),
    // Claude Code reads only its own directory, so it gets links.
    claudeSkills: path.join(dir, 'claude', 'skills'),
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
    // The one real location, so the documented path holds for every agent.
    assert.match(text, new RegExp(`~/\\.agents/skills/${name}/tools`));
    assert.doesNotMatch(text, /\.config\/ws-skills\/tools/, `${name} still points at the config home`);
  }
});

test('every skill is reachable from the agents dir and linked into Claude Code', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(code, 0, stdout);

  for (const name of SKILL_NAMES) {
    const real = path.join(box.skills, name);
    assert.ok((await fs.lstat(real)).isDirectory(), `${name} should be real in the agents dir`);

    const link = path.join(box.claudeSkills, name);
    assert.ok((await fs.lstat(link)).isSymbolicLink(), `${name} should be a link for Claude Code`);
    assert.equal(await fs.realpath(link), await fs.realpath(real));
    // Reading through the link has to reach the tooling, not just the SKILL.md.
    assert.ok(await fs.stat(path.join(link, 'SKILL.md')));
    assert.ok(await fs.stat(path.join(link, 'tools', 'main.py')));
  }

  // The shared tooling carries no SKILL.md, so no agent lists it as a skill.
  await assert.rejects(fs.stat(path.join(box.tools, 'SKILL.md')));
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

test("install reports the agent entry in the way, not the skill's own location", async (t) => {
  const box = await sandbox(t);

  // Someone else's ws-google, in Claude Code's directory rather than ours. The
  // skill itself has nothing in its way — only the entry Claude Code reads.
  const theirs = path.join(box.claudeSkills, 'ws-google');
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(theirs, 'SKILL.md'), 'someone else\n');

  const first = await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(first.code, 1, 'a link we cannot make is still a problem to report');
  assert.equal(await fs.readFile(path.join(theirs, 'SKILL.md'), 'utf8'), 'someone else\n');

  assert.ok(first.stdout.includes(theirs), `the run should name ${theirs}\n${first.stdout}`);
  assert.doesNotMatch(first.stdout, /ws-google: left alone/);
  assert.ok(await fs.stat(path.join(box.skills, 'ws-google', 'SKILL.md')));

  // The skills whose entry was free are linked as usual, not held back.
  assert.ok((await fs.lstat(path.join(box.claudeSkills, 'ws-slack'))).isSymbolicLink());

  const forced = await cliRun(box.env, ['install', '--no-setup', '--force']);
  assert.equal(forced.code, 0, forced.stdout);
  assert.ok((await fs.lstat(theirs)).isSymbolicLink(), 'the entry should now be our link');

  const backupsHome = path.join(box.home, 'backups');
  const backups = (await fs.readdir(backupsHome)).filter((e) =>
    e.startsWith('claude-ws-google.backup-'),
  );
  assert.equal(backups.length, 1, 'their skill should be kept, not deleted');
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
  assert.match(stdout, /Start a new session in your agent/);
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

test('link puts back the entries that are ours and reports the ones that are not', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);

  // One entry deleted by hand, one taken by someone else's skill.
  await fs.rm(path.join(box.claudeSkills, 'ws-google'));
  const theirs = path.join(box.claudeSkills, 'ws-slack');
  await fs.rm(theirs);
  await fs.mkdir(theirs);
  await fs.writeFile(path.join(theirs, 'SKILL.md'), 'someone else\n');

  const { code, stdout } = await cliRun(box.env, ['link']);
  assert.equal(code, 1, stdout);

  const repaired = path.join(box.claudeSkills, 'ws-google');
  assert.ok((await fs.lstat(repaired)).isSymbolicLink(), 'the deleted entry should be back');
  assert.equal(await fs.realpath(repaired), await fs.realpath(path.join(box.skills, 'ws-google')));

  // Same wording as install, and their skill is still theirs.
  assert.match(stdout, /ws-slack: Claude Code cannot see it/);
  assert.equal(await fs.readFile(path.join(theirs, 'SKILL.md'), 'utf8'), 'someone else\n');
});

test("doctor does not accept someone else's skill as ours being reachable", async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);

  // A directory of the same name, with a SKILL.md of its own. Asking only
  // whether a SKILL.md is there would pass this; it reaches nothing of ours.
  const link = path.join(box.claudeSkills, 'ws-google');
  await fs.rm(link);
  await fs.mkdir(link);
  await fs.writeFile(path.join(link, 'SKILL.md'), 'someone else\n');

  const { stdout } = await cliRun(box.env, ['doctor']);
  assert.match(stdout, /ws-google: not reachable from Claude Code/);
  // The skills whose link is intact must still read as fine.
  assert.doesNotMatch(stdout, /ws-slack: not reachable/);
});

test('uninstall removes our skills and keeps the tooling and credentials', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code } = await cliRun(box.env, ['uninstall']);

  assert.equal(code, 0);
  assert.deepEqual(await fs.readdir(box.skills), ['ws-skills-tools']);
  assert.ok(await fs.stat(path.join(box.tools, 'main.py')));

  // A link left behind would keep listing a skill whose target is gone.
  assert.deepEqual(await fs.readdir(box.claudeSkills), []);
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

test('uninstall does not call a skill removed when only its link went', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);

  // The real ws-slack is someone else's now; only the link into it is ours.
  const theirs = path.join(box.skills, 'ws-slack');
  await fs.rm(path.join(theirs, '.ws-skills-install'));

  const { stdout } = await cliRun(box.env, ['uninstall']);
  assert.doesNotMatch(stdout, /ws-slack removed/, 'the skill itself is still there');
  assert.match(stdout, /ws-slack left alone/);
  assert.ok(await fs.stat(path.join(theirs, 'SKILL.md')));
});

test("uninstall says when an agent still reads a skill it could not remove", async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);

  // Ours is gone from Claude Code's directory, someone else's took the name.
  const theirs = path.join(box.claudeSkills, 'ws-google');
  await fs.rm(theirs);
  await fs.mkdir(theirs);
  await fs.writeFile(path.join(theirs, 'SKILL.md'), 'someone else\n');

  const { stdout } = await cliRun(box.env, ['uninstall']);
  assert.match(stdout, /ws-google removed/);
  // "removed" alone would leave the user thinking the name is free everywhere.
  assert.match(stdout, /ws-google: Claude Code still reads .*ws-google — not ours/);
  assert.equal(await fs.readFile(path.join(theirs, 'SKILL.md'), 'utf8'), 'someone else\n');
});

test('uninstall --purge --force deletes the tooling and the credentials', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);
  const { code } = await cliRun(box.env, ['uninstall', '--purge', '--force']);

  assert.equal(code, 0);
  await assert.rejects(fs.stat(box.home));
  await assert.rejects(fs.stat(box.tools));
});

test('a link of ours aimed elsewhere is pointed back without --force', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['install', '--no-setup']);

  // What moving WS_AGENTS_DIR, or deleting the skill by hand, leaves behind:
  // our own link, now aimed at nothing. It is ours to repair, not to back up.
  const link = path.join(box.claudeSkills, 'ws-google');
  await fs.rm(link);
  await fs.symlink(path.join(box.home, 'gone', 'ws-google'), link);

  const { code, stdout } = await cliRun(box.env, ['install', '--no-setup']);
  assert.equal(code, 0, stdout);
  assert.equal(
    await fs.realpath(link),
    await fs.realpath(path.join(box.skills, 'ws-google')),
    'the link should point back at the real skill',
  );
  await assert.rejects(fs.stat(path.join(box.home, 'backups')), 'nothing was ours to move aside');
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
