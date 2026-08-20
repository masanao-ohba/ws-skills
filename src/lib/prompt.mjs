import readline from 'node:readline';

import { bold, cyan, dim, green } from './ui.mjs';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

// The gutter down the left of a question block, and its asking/answered markers.
const BAR = () => dim('│');
const ASKING = () => cyan('◆');
const ANSWERED = () => green('◇');

let rl = null;
let muted = false;

function iface() {
  if (rl) return rl;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // While muted, echo nothing: the prompt itself is already on stdout.
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

function canUseRawMode() {
  return typeof process.stdin.setRawMode === 'function' && process.stdin.isTTY;
}

const columns = () => process.stdout.columns || 80;

// Cursor arithmetic counts rendered rows, not lines: a line wraps in a narrow pane.
const ANSI = /\u001b\[[0-9;]*m/g;
const rows = (line) => Math.max(1, Math.ceil(line.replace(ANSI, '').length / columns()));
const totalRows = (lines) => lines.reduce((sum, line) => sum + rows(line), 0);

/** Print the head of a question block. Returns the rows printed under the marker. */
function openBlock(question, hint, note) {
  const head = `${ASKING()}  ${bold(question)}${note ? dim(`  ${note}`) : ''}`;
  const out = [`${BAR()}`, head];
  if (hint) out.push(`${BAR()}  ${dim(hint)}`);
  console.log(out.join('\n'));
  // The marker sits on the first row of `head`; everything after it is below.
  return rows(head) - 1 + totalRows(out.slice(2));
}

/** Turn the ◆ of a finished question into ◇, rewriting only that marker. */
function closeBlock(rowsBelowMarker, answerRows = 1) {
  const up = rowsBelowMarker + 1 + answerRows;
  process.stdout.write(`\u001b[${up}A\r${ANSWERED()}\u001b[${up}B\r`);
}

const answerRows = (text) => rows(`   ${text}`);

/** Free-text question. `def` is used when the answer is blank. */
export async function ask(question, { def = '', hint = '' } = {}) {
  requireTTY();
  const guide = [hint, def ? 'press Enter to accept' : ''].filter(Boolean).join(' · ');
  const below = openBlock(question, guide, def ? `[${def}]` : '');
  const answer = await new Promise((resolve) => iface().question(`${BAR()}  `, resolve));
  closeBlock(below, answerRows(answer));
  return answer.trim() || def;
}

/**
 * Question whose answer is masked as it is typed. Returns '' when left blank.
 *
 * Every character shows as a dot rather than echoing nothing.
 */
export async function askSecret(question, { keep = false, hint = '' } = {}) {
  requireTTY();
  const guide = [hint, keep ? 'press Enter to keep the current one' : ''].filter(Boolean).join(' · ');
  const below = openBlock(question, guide, keep ? '[keep current]' : '');
  process.stdout.write(`${BAR()}  `);

  if (!canUseRawMode()) {
    muted = true;
    const answer = await new Promise((resolve) => iface().question('', resolve));
    muted = false;
    process.stdout.write('\n');
    closeBlock(below);
    return answer.trim();
  }

  const value = await maskedInput();
  closeBlock(below, answerRows(value));
  return value;
}

function maskedInput(mask = '•') {
  const input = process.stdin;
  const output = process.stdout;

  closePrompt();
  readline.emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();

  let value = '';
  return new Promise((resolve) => {
    const stop = () => {
      input.off('keypress', onKey);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
    };
    const erase = (n) => output.write('\b \b'.repeat(n));

    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        stop();
        output.write('\n');
        process.exit(130);
      }
      if (key.name === 'return' || key.name === 'enter') {
        stop();
        output.write('\n');
        resolve(value.trim());
        return;
      }
      if (key.name === 'backspace') {
        if (value) {
          value = value.slice(0, -1);
          erase(1);
        }
        return;
      }
      if (key.ctrl && key.name === 'u') {
        erase(value.length);
        value = '';
        return;
      }
      if (key.ctrl || key.meta || !str || str.charCodeAt(0) < 32) return;
      value += str;
      output.write(mask.repeat(str.length));
    };
    input.on('keypress', onKey);
  });
}

/** A keyboard-driven block: arrow keys to move, space to toggle, enter to confirm. */
function keyboardBlock({ question, hint, options, multi, inline, selected, cursor = 0 }) {
  const input = process.stdin;
  const output = process.stdout;

  // Line-mode readline and raw-mode keypresses cannot share stdin.
  closePrompt();
  readline.emitKeypressEvents(input);
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();
  output.write(HIDE_CURSOR);

  const keys = multi
    ? 'space toggle · a all · enter confirm'
    : inline
      ? 'y / n or ←→ · enter confirm'
      : '↑↓ move · enter confirm';

  let drawn = 0;
  const draw = (done = false) => {
    if (drawn) output.write(`\u001b[${drawn}A\u001b[0J`);
    const lines = [`${BAR()}`, `${done ? ANSWERED() : ASKING()}  ${bold(question)}`];
    if (hint) lines.push(`${BAR()}  ${dim(hint)}`);

    const mark = (i) => (selected.has(i) ? (multi ? '◉' : '●') : multi ? '◯' : '○');
    if (inline) {
      const cells = options.map((option, i) => {
        const cell = `${mark(i)} ${option.label}`;
        return !done && i === cursor ? cyan(bold(cell)) : dim(cell);
      });
      lines.push(`${BAR()}  ${cells.join('   ')}`);
    } else {
      options.forEach((option, i) => {
        const here = !done && i === cursor;
        const body = `${mark(i)} ${option.label}${option.hint ? dim(`  ${option.hint}`) : ''}`;
        lines.push(`${BAR()}  ${here ? `${cyan('❯')} ${bold(body)}` : `  ${body}`}`);
      });
    }
    if (!done) lines.push(`${BAR()}  ${dim(keys)}`);

    output.write(lines.join('\n') + '\n');
    drawn = totalRows(lines);
  };

  const stop = () => {
    input.off('keypress', onKey);
    if (!wasRaw) input.setRawMode(false);
    input.pause();
    output.write(SHOW_CURSOR);
  };

  let onKey;
  return new Promise((resolve) => {
    const finish = () => {
      if (!multi) selected = new Set([cursor]);
      draw(true);
      stop();
      resolve([...selected].sort((a, b) => a - b).map((i) => options[i].value));
    };

    onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        stop();
        output.write('\n');
        process.exit(130);
      }
      const back = key.name === 'up' || key.name === 'left' || str === 'k';
      const forward = key.name === 'down' || key.name === 'right' || str === 'j';

      if (back) cursor = (cursor - 1 + options.length) % options.length;
      else if (forward) cursor = (cursor + 1) % options.length;
      else if (key.name === 'space' || str === ' ') {
        if (multi) selected.has(cursor) ? selected.delete(cursor) : selected.add(cursor);
        else selected = new Set([cursor]);
      } else if (multi && (str === 'a' || str === 'A')) {
        if (selected.size === options.length) selected.clear();
        else options.forEach((_, i) => selected.add(i));
      } else if (key.name === 'return' || key.name === 'enter') {
        return finish();
      } else if (inline && /^[yn]$/i.test(str ?? '')) {
        // Selects but does not submit — the Enter people type next belongs here.
        cursor = options.findIndex((o) => o.value === /^y$/i.test(str));
        selected = new Set([cursor]);
      } else if (!inline && /^[1-9]$/.test(str ?? '')) {
        const index = Number(str) - 1;
        if (index < options.length) {
          cursor = index;
          if (multi) selected.has(index) ? selected.delete(index) : selected.add(index);
          else selected = new Set([index]);
        }
      }
      draw();
    };
    draw();
    input.on('keypress', onKey);
  });
}

export async function confirm(question, def = true, { hint = '' } = {}) {
  requireTTY();
  const options = [
    { value: true, label: 'yes' },
    { value: false, label: 'no' },
  ];
  if (canUseRawMode()) {
    const index = def ? 0 : 1;
    const [value] = await keyboardBlock({
      question,
      hint,
      options,
      multi: false,
      inline: true,
      selected: new Set([index]),
      cursor: index,
    });
    return value;
  }
  const below = openBlock(question, hint, def ? '[yes]' : '[no]');
  const answer = (await new Promise((resolve) => iface().question(`${BAR()}  `, resolve)))
    .trim()
    .toLowerCase();
  closeBlock(below);
  return answer ? answer.startsWith('y') : def;
}

/** Pick exactly one option. `options` is [{ value, label, hint? }]. */
export async function selectOne(question, options, def = 0) {
  requireTTY();
  if (canUseRawMode()) {
    const [value] = await keyboardBlock({
      question,
      options,
      multi: false,
      selected: new Set([def]),
      cursor: def,
    });
    return value;
  }
  return typedOne(question, options, def);
}

/** Pick any number of options. */
export async function selectMany(question, options, defaults = []) {
  requireTTY();
  if (canUseRawMode()) {
    const preset = new Set(
      options.map((o, i) => (defaults.includes(o.value) ? i : -1)).filter((i) => i >= 0),
    );
    return keyboardBlock({ question, options, multi: true, selected: preset });
  }
  return typedMany(question, options, defaults);
}

// --- fallbacks for terminals that cannot do raw mode ------------------------

async function typedOne(question, options, def) {
  openBlock(question, '', '');
  options.forEach((o, i) => {
    console.log(`${BAR()}  ${i + 1}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`);
  });
  while (true) {
    const raw = await new Promise((resolve) =>
      iface().question(`${BAR()}  ${dim(`[${def + 1}]`)} `, resolve),
    );
    const index = raw.trim() ? Number.parseInt(raw.trim(), 10) - 1 : def;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index].value;
    }
    console.log(`${BAR()}  ${dim(`enter a number between 1 and ${options.length}`)}`);
  }
}

async function typedMany(question, options, defaults) {
  openBlock(question, 'comma separated, "all", "none"', '');
  options.forEach((o, i) => {
    const mark = defaults.includes(o.value) ? '*' : ' ';
    console.log(`${BAR()}  ${mark}${i + 1}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}`);
  });
  const shown = defaults.length ? defaults.join(', ') : 'none';
  while (true) {
    const raw = (
      await new Promise((resolve) => iface().question(`${BAR()}  ${dim(`[${shown}]`)} `, resolve))
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
    console.log(`${BAR()}  ${dim('enter numbers from the list, "all", or "none"')}`);
  }
}
