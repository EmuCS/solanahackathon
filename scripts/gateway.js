// Keeps the Pay.sh gateway alive: on Windows it has been seen exiting silently
// (exit 0, nothing logged), so restart it whenever it stops.
import { spawn } from 'node:child_process';
import { PAY_BIN, PAY_SANDBOX, ROOT } from '../src/config.js';

const args = [...(PAY_SANDBOX ? ['--sandbox'] : []), 'gate', 'api', 'paywall.yml'];

function start() {
  const started = Date.now();
  const p = spawn(PAY_BIN, args, { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'] });
  p.on('close', (code) => {
    const up = Math.round((Date.now() - started) / 1000);
    console.log(`\n[gateway] exited (code ${code}) after ${up}s — restarting`);
    setTimeout(start, up < 5 ? 3000 : 500);
  });
}
start();
