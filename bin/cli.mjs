#!/usr/bin/env node
import { run } from '../src/cli.mjs';
import { closePrompt } from '../src/lib/prompt.mjs';
import { fail } from '../src/lib/ui.mjs';

try {
  const code = await run(process.argv.slice(2));
  closePrompt();
  process.exit(code ?? 0);
} catch (err) {
  closePrompt();
  fail(err?.message ?? String(err));
  if (process.env.WS_SKILLS_DEBUG) console.error(err);
  process.exit(1);
}
