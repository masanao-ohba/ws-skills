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
      // `~/.agents` has no setting of its own — a skill names an absolute path to
      // its own tooling, so the location cannot move. A home of our own is what
      // keeps the run off the developer's real one.
      HOME: dir,
      USERPROFILE: dir,
      WS_SKILLS_HOME: path.join(dir, 'home'),
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      NO_COLOR: '1',
    },
    home: path.join(dir, 'home'),
    // Where the skills really live, and where every agent but Claude Code reads them.
    skills: path.join(dir, '.agents', 'skills'),
    tools: path.join(dir, '.agents', 'skills', 'ws-skills-tools'),
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

test('update puts every skill and the shared tooling under the skills directory', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['update']);

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
  await cliRun(box.env, ['update']);

  for (const name of SKILL_NAMES) {
    const text = await fs.readFile(path.join(box.skills, name, 'SKILL.md'), 'utf8');
    // The one real location, so the documented path holds for every agent.
    assert.match(text, new RegExp(`~/\\.agents/skills/${name}/tools`));
    assert.doesNotMatch(text, /\.config\/ws-skills\/tools/, `${name} still points at the config home`);
  }
});

test('every skill is reachable from the agents dir and linked into Claude Code', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['update']);
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

test('a second update is idempotent', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  const { code, stdout } = await cliRun(box.env, ['update']);

  assert.equal(code, 0, stdout);
  const entries = await fs.readdir(box.skills);
  assert.deepEqual(entries.sort(), [...SKILL_NAMES, 'ws-skills-tools'].sort());
});

test('a skill already holding the name is replaced, whoever put it there', async (t) => {
  const box = await sandbox(t);
  const existing = path.join(box.skills, 'ws-google');
  await fs.mkdir(existing, { recursive: true });
  await fs.writeFile(path.join(existing, 'SKILL.md'), 'someone else\n');

  const { code, stdout } = await cliRun(box.env, ['update']);
  assert.equal(code, 0, stdout);

  assert.match(
    await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8'),
    /^---\nname: ws-google\n/,
    'theirs should be gone, not merged with ours',
  );
  assert.ok(await fs.stat(path.join(existing, 'tools', 'main.py')));

  // Nothing is set aside, so nothing may be left under the skills directory —
  // an agent lists every directory there as a skill of its own.
  const entries = await fs.readdir(box.skills);
  assert.deepEqual(entries.sort(), [...SKILL_NAMES, 'ws-skills-tools'].sort());
});

test("an agent's entry already holding the name is replaced too", async (t) => {
  const box = await sandbox(t);

  // A skill of someone else's, in Claude Code's directory rather than ours.
  const theirs = path.join(box.claudeSkills, 'ws-google');
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(theirs, 'SKILL.md'), 'someone else\n');

  const { code, stdout } = await cliRun(box.env, ['update']);
  assert.equal(code, 0, stdout);

  assert.ok((await fs.lstat(theirs)).isSymbolicLink(), 'the entry should now be our link');
  assert.equal(
    await fs.realpath(theirs),
    await fs.realpath(path.join(box.skills, 'ws-google')),
    'the entry should reach our skill, not what used to be there',
  );
});

test('overwriting a link in the skills tree does not empty what it points at', async (t) => {
  const box = await sandbox(t);

  // A skills tree of someone's own, reached by a link where our skill goes.
  // Syncing over the link instead of removing it first would follow it and
  // empty their directory — a path we were never asked about.
  const elsewhere = path.join(box.dir, 'elsewhere', 'ws-google');
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.writeFile(path.join(elsewhere, 'SKILL.md'), 'someone else\n');
  await fs.mkdir(box.skills, { recursive: true });
  const ours = path.join(box.skills, 'ws-google');
  await fs.symlink(path.relative(box.skills, elsewhere), ours);

  const { code, stdout } = await cliRun(box.env, ['update']);
  assert.equal(code, 0, stdout);

  assert.equal(await fs.readFile(path.join(elsewhere, 'SKILL.md'), 'utf8'), 'someone else\n');
  assert.ok((await fs.lstat(ours)).isDirectory(), 'our skill should be a real directory now');
});

test("overwriting an agent's entry takes the entry, not the skill it pointed at", async (t) => {
  const box = await sandbox(t);

  // Their entry is a link into a skills tree of their own. Removing a link
  // removes the link; the skill on the other side is not ours to touch.
  const elsewhere = path.join(box.dir, 'elsewhere', 'ws-google');
  await fs.mkdir(elsewhere, { recursive: true });
  await fs.writeFile(path.join(elsewhere, 'SKILL.md'), 'someone else\n');
  const theirs = path.join(box.claudeSkills, 'ws-google');
  await fs.mkdir(box.claudeSkills, { recursive: true });
  await fs.symlink(path.relative(box.claudeSkills, elsewhere), theirs);

  const { code, stdout } = await cliRun(box.env, ['update']);
  assert.equal(code, 0, stdout);

  assert.equal(
    await fs.realpath(theirs),
    await fs.realpath(path.join(box.skills, 'ws-google')),
    'the entry should now be our link',
  );
  assert.equal(
    await fs.readFile(path.join(elsewhere, 'SKILL.md'), 'utf8'),
    'someone else\n',
    'their skill itself is at a path we were never asked about',
  );
});

test('an upgrade drops files that no longer exist upstream', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  const stale = path.join(box.tools, 'scripts', 'stale_module.py');
  await fs.writeFile(stale, '# left over from an older version\n');

  await cliRun(box.env, ['update']);
  await assert.rejects(fs.stat(stale));
});

test('an upgrade keeps the Python virtualenv uv built', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  const venv = path.join(box.tools, '.venv');
  await fs.mkdir(venv, { recursive: true });
  await fs.writeFile(path.join(venv, 'pyvenv.cfg'), 'home = /usr\n');

  await cliRun(box.env, ['update']);
  assert.equal(await fs.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8'), 'home = /usr\n');
});

test('update asks nothing and touches no credential', async (t) => {
  const box = await sandbox(t);
  const { code, stdout } = await cliRun(box.env, ['update']);

  assert.equal(code, 0, stdout);
  assert.doesNotMatch(stdout, /Authorization/);
  assert.doesNotMatch(stdout, /Credentials/);
  assert.doesNotMatch(stdout, /uv run --project/, 'the raw tooling command is not a user surface');

  // Nothing is written into the config home but the directory itself.
  await assert.rejects(fs.stat(path.join(box.home, '.env')));
});

test('auth refuses to guess when nothing is configured', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  const { code, stdout } = await cliRun(box.env, ['auth']);

  assert.equal(code, 1);
  assert.match(stdout, /nothing is configured yet/);
});

test('auth refuses to run without a terminal rather than hanging', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  await fs.mkdir(box.home, { recursive: true });
  await fs.writeFile(path.join(box.home, '.env'), 'WS_INTEGRATIONS=google\n');

  const { code, stdout } = await cliRun(box.env, ['auth']);
  assert.equal(code, 1);
  assert.match(stdout, /interactive terminal/);
});

test('doctor reports missing credentials without crashing', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  const { code, stdout } = await cliRun(box.env, ['doctor']);

  assert.equal(code, 1, 'a fresh install has nothing authorized yet');
  assert.match(stdout, /ws-skills doctor/);
  assert.match(stdout, /Skills/);
  assert.match(stdout, /Credentials/);
  for (const name of SKILL_NAMES) assert.match(stdout, new RegExp(`/${name}`));
});

test('update puts every entry back, whatever came to hold it', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);

  // One entry deleted by hand, one taken by someone else's skill.
  await fs.rm(path.join(box.claudeSkills, 'ws-google'));
  const theirs = path.join(box.claudeSkills, 'ws-slack');
  await fs.rm(theirs);
  await fs.mkdir(theirs);
  await fs.writeFile(path.join(theirs, 'SKILL.md'), 'someone else\n');

  const { code, stdout } = await cliRun(box.env, ['update']);
  assert.equal(code, 0, stdout);

  for (const name of ['ws-google', 'ws-slack']) {
    const entry = path.join(box.claudeSkills, name);
    assert.ok((await fs.lstat(entry)).isSymbolicLink(), `${name} should be our link again`);
    assert.equal(await fs.realpath(entry), await fs.realpath(path.join(box.skills, name)));
  }
});

test('doctor does not accept an entry that reaches something else', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);

  // A directory of the same name, with a SKILL.md of its own. Asking only
  // whether a SKILL.md is there would pass this; it reaches nothing of ours.
  // Nothing installs it back on its own, so doctor has to say so.
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
  await cliRun(box.env, ['update']);
  const { code } = await cliRun(box.env, ['uninstall']);

  assert.equal(code, 0);
  assert.deepEqual(await fs.readdir(box.skills), ['ws-skills-tools']);
  assert.ok(await fs.stat(path.join(box.tools, 'main.py')));

  // A link left behind would keep listing a skill whose target is gone.
  assert.deepEqual(await fs.readdir(box.claudeSkills), []);
});

test('uninstall clears both paths, whatever came to hold them', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);

  // Something else took both names after the install. Uninstall gives the names
  // back on the same terms install took them: no questions asked either way.
  const theirSkill = path.join(box.skills, 'ws-slack');
  await fs.writeFile(path.join(theirSkill, 'SKILL.md'), 'someone else\n');
  const theirEntry = path.join(box.claudeSkills, 'ws-google');
  await fs.rm(theirEntry);
  await fs.mkdir(theirEntry);
  await fs.writeFile(path.join(theirEntry, 'SKILL.md'), 'someone else\n');

  const { code, stdout } = await cliRun(box.env, ['uninstall']);
  assert.equal(code, 0, stdout);
  assert.match(stdout, /ws-slack removed/);
  await assert.rejects(fs.stat(theirSkill));
  await assert.rejects(fs.stat(theirEntry));
});

test('uninstall says so rather than claiming a removal that did not happen', async (t) => {
  const box = await sandbox(t);
  const { stdout } = await cliRun(box.env, ['uninstall']);

  for (const name of SKILL_NAMES) {
    assert.match(stdout, new RegExp(`/${name} was not installed`));
  }
});

test('uninstall --purge deletes the tooling and the credentials', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);
  const { code } = await cliRun(box.env, ['uninstall', '--purge']);

  assert.equal(code, 0);
  await assert.rejects(fs.stat(box.home));
  await assert.rejects(fs.stat(box.tools));
});

test('an entry aimed at nothing is pointed back', async (t) => {
  const box = await sandbox(t);
  await cliRun(box.env, ['update']);

  // What a home directory move, or deleting the skill by hand, leaves behind:
  // a link aimed at nothing. The next run repairs it.
  const link = path.join(box.claudeSkills, 'ws-google');
  await fs.rm(link);
  await fs.symlink(path.join(box.home, 'gone', 'ws-google'), link);

  const { code, stdout } = await cliRun(box.env, ['update']);
  assert.equal(code, 0, stdout);
  assert.equal(
    await fs.realpath(link),
    await fs.realpath(path.join(box.skills, 'ws-google')),
    'the link should point back at the real skill',
  );

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
