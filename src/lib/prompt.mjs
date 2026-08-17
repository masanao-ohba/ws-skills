import readline from 'node:readline';

import { bold, dim } from './ui.mjs';

let rl = null;
let muted = false;

function iface() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // While muted, echo nothing at all: the prompt is written directly to stdout
  // beforehand, so the line still reads normally, but the secret never appears.
  rl._writeToOutput = (str) => {
    if (!muted) rl.output.write(str);
  };
  rl.on('SIGINT', () => {
    closePrompt();
    process.stdout.write('\n');
    process.exit(130);
  });
  return rl;
}

export function closePrompt() {
  if (rl) rl.close();
  rl = null;
}

export function interactive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function requireTTY() {
  if (!interactive()) {
    throw new Error(
      'this step needs an interactive terminal. Run it without piping stdin, or ' +
        'pre-fill the settings in the environment and re-run.',
    );
  }
}

/** Free-text question. `def` is offered as the value when the answer is blank. */
export async function ask(question, { def = '', hint = '' } = {}) {
  requireTTY();
  const suffix = def ? dim(` [${def}]`) : '';
  const line = hint ? `${question}${suffix}\n  ${dim(hint)}\n> ` : `${question}${suffix}\n> `;
  const answer = await new Promise((resolve) => iface().question(line, resolve));
  return answer.trim() || def;
}

/** Question whose answer is never echoed. Returns '' when left blank. */
export async function askSecret(question, { keep = false } = {}) {
  requireTTY();
  const suffix = keep ? dim(' [keep current]') : '';
  process.stdout.write(`${question}${suffix}\n> `);
  muted = true;
  const answer = await new Promise((resolve) => iface().question('', resolve));
  muted = false;
  process.stdout.write('\n');
  return answer.trim();
}

export async function confirm(question, def = true) {
  requireTTY();
  const choices = def ? 'Y/n' : 'y/N';
  const answer = (await new Promise((resolve) =>
    iface().question(`${question} ${dim(`(${choices})`)} `, resolve),
  ))
    .trim()
    .toLowerCase();
  if (!answer) return def;
  return answer.startsWith('y');
}

/** Pick exactly one option. `options` is [{ value, label, hint? }]. */
export async function selectOne(question, options, def = 0) {
  requireTTY();
  console.log(`\n${bold(question)}`);
  options.forEach((o, i) => {
    console.log(`  ${i + 1}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`);
  });
  while (true) {
    const raw = await new Promise((resolve) =>
      iface().question(`> ${dim(`[${def + 1}]`)} `, resolve),
    );
    const index = raw.trim() ? Number.parseInt(raw.trim(), 10) - 1 : def;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index].value;
    }
    console.log(dim(`  enter a number between 1 and ${options.length}`));
  }
}

/** Pick any number of options. Answer: comma separated numbers, "all", or "none". */
export async function selectMany(question, options, defaults = []) {
  requireTTY();
  console.log(`\n${bold(question)}`);
  options.forEach((o, i) => {
    const mark = defaults.includes(o.value) ? '*' : ' ';
    console.log(`  ${mark}${i + 1}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`);
  });
  const shown = defaults.length ? defaults.join(', ') : 'none';
  while (true) {
    const raw = (
      await new Promise((resolve) =>
        iface().question(`> ${dim(`comma separated, "all", "none" [${shown}]`)} `, resolve),
      )
    ).trim();
    if (!raw) return defaults;
    if (raw.toLowerCase() === 'all') return options.map((o) => o.value);
    if (raw.toLowerCase() === 'none') return [];
    const picked = raw
      .split(',')
      .map((p) => Number.parseInt(p.trim(), 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
      .map((i) => options[i].value);
    if (picked.length) return [...new Set(picked)];
    console.log(dim('  enter numbers from the list, "all", or "none"'));
  }
}
