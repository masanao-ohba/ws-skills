import fs from 'node:fs/promises';
import path from 'node:path';

import { doctorCommand } from './commands/doctor.mjs';
import { installCommand } from './commands/install.mjs';
import { setupCommand } from './commands/setup.mjs';
import { uninstallCommand } from './commands/uninstall.mjs';
import { linkCommand } from './commands/link.mjs';
import { packageRoot } from './lib/paths.mjs';
import { bold, dim } from './lib/ui.mjs';

const USAGE = `
${bold('ws-skills')} — install the ws-* Claude Code skills and the tooling behind them

  ${bold('npx @masanao-ohba/ws-skills')}            install and set up (the default)

Commands
  install      copy the tools, link the skills, ask for credentials
  setup        ask for credentials again (nothing is copied or linked)
  link         re-create the skill symlinks only
  doctor       report what is installed, authorized, and missing
  uninstall    remove the skill symlinks (--purge also deletes credentials)

Options
  --force      overwrite an existing skill entry (the old one is kept as .backup-<time>)
  --no-setup   install without asking for credentials
  --purge      uninstall: also delete the install home
  -h, --help   this message
  -v, --version

Environment
  WS_SKILLS_HOME     where to install (default: ~/.config/ws-skills)
  CLAUDE_CONFIG_DIR  where Claude Code keeps its config (default: ~/.claude)
`;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  const positional = argv.filter((a) => !a.startsWith('-'));
  return {
    command: positional[0] ?? 'install',
    force: flags.has('--force') || flags.has('-f'),
    skipSetup: flags.has('--no-setup'),
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
      return installCommand({ force: args.force, skipSetup: args.skipSetup });
    case 'setup':
      return setupCommand();
    case 'link':
      return linkCommand({ force: args.force });
    case 'doctor':
      return doctorCommand();
    case 'uninstall':
      return uninstallCommand({ purge: args.purge, force: args.force });
    default:
      console.log(USAGE);
      console.error(`\nunknown command: ${args.command}`);
      console.error(dim('run `ws-skills --help` for the list'));
      return 2;
  }
}
