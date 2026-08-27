import pc from 'picocolors';

export const log = {
  step: (n, msg) => console.log(`${pc.dim(String(n).padStart(2, '0'))} ${pc.bold(msg)}`),
  info: (msg) => console.log(`   ${msg}`),
  dim: (msg) => console.log(pc.dim(`   ${msg}`)),
  ok: (msg) => console.log(`   ${pc.green('OK')}  ${msg}`),
  warn: (msg) => console.log(`   ${pc.yellow('!')}   ${msg}`),
  fail: (msg) => console.log(`   ${pc.red('X')}   ${msg}`),
  blank: () => console.log('')
};
export { pc };
