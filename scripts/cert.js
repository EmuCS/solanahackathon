// Self-signed HTTPS cert for this laptop's LAN IPs, so phone browsers allow the live camera.
// Phones show a one-time warning ("Advanced → Proceed") because the cert is self-signed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CERT_DIR } from '../src/config.js';

const ips = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4')
  .map((i) => i.address);
const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',');

fs.mkdirSync(CERT_DIR, { recursive: true });
const r = spawnSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', path.join(CERT_DIR, 'key.pem'),
    '-out', path.join(CERT_DIR, 'cert.pem'),
    '-subj', '/CN=FraudBusters dev',
    '-addext', `subjectAltName=${san}`,
  ],
  { stdio: 'inherit' },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`Cert written for ${san}`);
for (const ip of ips.filter((i) => i !== '127.0.0.1')) console.log(`Phone: https://${ip}:3443/capture.html`);
