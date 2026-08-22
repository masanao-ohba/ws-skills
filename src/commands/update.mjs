import path from 'node:path';

import { ensureDir, syncDir } from '../lib/fsx.mjs';
import { readEnvFile } from '../lib/envfile.mjs';
import { configHome, envFile, packageRoot, tildify, toolsDir } from '../lib/paths.mjs';
import { INTEGRATIONS, SKILLS, installSkill } from '../lib/skills.mjs';
import { configuredIntegrations } from './setup.mjs';
import { dim, flowEnd, flowStart, info, ok } from '../lib/ui.mjs';

/**
 * Put the tooling and the skills on disk at the version this package ships.
 *
 * Nothing here reads or writes a credential, and nothing is asked. The three
 * skill names belong to this package, so whatever holds one is replaced.
 */
export async function putArtifacts(integrations) {
  // The config home holds credentials only, nothing executable.
  await ensureDir(configHome(), 0o700);
  // .venv is uv's, not ours.
  await syncDir(path.join(packageRoot(), 'payload', 'tools'), toolsDir(), { keep: ['.venv'] });
  ok(`tooling installed at ${tildify(toolsDir())}`);

  const source = path.join(packageRoot(), 'payload', 'skills');
  for (const skill of SKILLS) {
    if (!integrations.includes(skill.integration)) {
      info(dim(`/${skill.name} not installed (integration not selected)`));
      continue;
    }
    await installSkill(skill.name, path.join(source, skill.name));
    ok(`/${skill.name} installed`);
  }
}

/**
 * Bring what is installed to the version this package ships.
 *
 * For a new release of the package: the artifacts are replaced and no credential
 * is read, written, or asked about.
 */
export async function updateCommand() {
  flowStart('ws-skills update');

  const chosen = configuredIntegrations(await readEnvFile(envFile()));
  await putArtifacts(chosen.length ? chosen : INTEGRATIONS);

  flowEnd('up to date — start a new session in your agent to pick it up');
  return 0;
}
