const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (text) => (useColor() ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = wrap(1);
export const dim = wrap(2);
export const green = wrap(32);
export const yellow = wrap(33);
export const red = wrap(31);
export const cyan = wrap(36);

/** Whether a flow's left gutter is open — everything printed hangs off it. */
let flowOpen = false;
const lead = () => (flowOpen ? `${dim('│')}  ` : '  ');

export function flowStart(title) {
  console.log(`\n${cyan('┌')}  ${bold(title)}`);
  flowOpen = true;
}

export function flowEnd(text = '') {
  flowOpen = false;
  console.log(`${cyan('└')}  ${text}`);
}

/** A named step or section inside the flow (a plain heading outside one). */
export function heading(title, note = '') {
  const tail = note ? dim(` — ${note}`) : '';
  if (flowOpen) console.log(`${dim('│')}\n${dim('│')}  ${bold(`▸ ${title}`)}${tail}`);
  else console.log(`\n${bold(title)}${tail}`);
}

export function info(text) {
  console.log(`${lead()}${text}`);
}

export function bar(text = '') {
  console.log(text ? `${lead()}${text}` : dim('│'));
}

export function ok(text) {
  console.log(`${lead()}${green('✓')} ${text}`);
}

export function warn(text) {
  console.log(`${lead()}${yellow('!')} ${text}`);
}

export function bad(text) {
  console.log(`${lead()}${red('✗')} ${text}`);
}

export function fail(text) {
  console.error(`${red('error')} ${text}`);
}

const LEVELS = { ok, warn, bad, info };

/** Print one line of a description — see `describeInstall` in skills.mjs. */
export function emit({ level, text, note }) {
  LEVELS[level](note ? `${text} ${dim(`(${note})`)}` : text);
}
