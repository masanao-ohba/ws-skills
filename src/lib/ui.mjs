const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (text) => (useColor() ? `\u001b[${code}m${text}\u001b[0m` : text);

export const bold = wrap(1);
export const dim = wrap(2);
export const green = wrap(32);
export const yellow = wrap(33);
export const red = wrap(31);
export const cyan = wrap(36);

export function heading(text) {
  console.log(`\n${bold(text)}`);
}

export function info(text) {
  console.log(`  ${text}`);
}

export function ok(text) {
  console.log(`  ${green('✓')} ${text}`);
}

export function warn(text) {
  console.log(`  ${yellow('!')} ${text}`);
}

export function bad(text) {
  console.log(`  ${red('✗')} ${text}`);
}

export function fail(text) {
  console.error(`${red('error')} ${text}`);
}

export function step(text) {
  console.log(`${cyan('›')} ${text}`);
}
