import fs from 'node:fs/promises';
import path from 'node:path';

import { authCommand } from './commands/auth.mjs';
import { doctorCommand } from './commands/doctor.mjs';
import { installCommand } from './commands/install.mjs';
import { uninstallCommand } from './commands/uninstall.mjs';
import { updateCommand } from './commands/update.mjs';
import { packageRoot } from './lib/paths.mjs';
import { bold, dim } from './lib/ui.mjs';

const USAGE = `
${bold('ws-skills')} — install the ws-* agent skills and the tooling behind them

  ${bold('npx @masanao-ohba/ws-skills')}            install and set up (the default)

Commands
  install      the first run, and any change to credentials
  update       bring the tooling and the skills to this version — credentials untouched
  auth         run the authorization steps that need a person (Google, Slack)
  doctor       report what is installed, authorized, and missing
  uninstall    remove the skills (--purge also deletes the tooling and credentials)

Options
  --force      auth: re-run steps that are already done
  --purge      uninstall: also delete the tooling and the credentials
  -h, --help   this message
  -v, --version

Environment
  WS_SKILLS_HOME     credentials and settings (default: ~/.config/ws-skills)
                     the skills themselves always go to ~/.agents/skills
  CLAUDE_CONFIG_DIR  where Claude Code keeps its config (default: ~/.claude)
`;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const positional = argv.filter((a) => !a.startsWith('-'));
  return {
    command: positional[0] ?? 'install',
    force: flags.has('--force') || flags.has('-f'),
    purge: flags.has('--purge'),
    help: flags.has('--help') || flags.has('-h'),
    version: flags.has('--version') || flags.has('-v'),
  };
}

async function version() {
  const pkg = JSON.parse(
    await fs.readFile(path.join(packageRoot(), 'package.json'), 'utf8'),
  );
  return `${pkg.name} ${pkg.version}`;
}

export async function run(argv) {
  const args = parseArgs(argv);

  if (args.version) {
    console.log(await version());
    return 0;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  switch (args.command) {
    case 'install':
      return installCommand();
    case 'update':
      return updateCommand();
    case 'auth':
      return authCommand({ force: args.force });
    case 'doctor':
      return doctorCommand();
    case 'uninstall':
      return uninstallCommand({ purge: args.purge });
    default:
      console.log(USAGE);
      console.error(`\nunknown command: ${args.command}`);
      console.error(dim('run `ws-skills --help` for the list'));
      return 2;
  }
}
