// End-to-end smoke test against a running server: acts as a phone (device key),
// captures, claims, double-claims, big claim, and verifies a compressed copy.
// Usage: node scripts/e2e.js [baseUrl]
import crypto from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import sharp from 'sharp';

const BASE = process.argv[2] || 'http://localhost:3000';
const device = nacl.sign.keyPair();
const pubkey = bs58.encode(device.publicKey);

// Random blocky "scene" upscaled + blurred: structurally distinct per call, like different real photos
async function photo() {
  const small = Buffer.from(Array.from({ length: 12 * 9 * 3 }, () => Math.floor(Math.random() * 256)));
  return sharp(small, { raw: { width: 12, height: 9, channels: 3 } })
    .resize(800, 600, { kernel: 'cubic' })
    .blur(4)
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function post(path, fields, image) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (image) fd.append('image', new Blob([image], { type: 'image/jpeg' }), 'photo.jpg');
  const r = await fetch(BASE + path, { method: 'POST', body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}

// Claimants only get a receipt; the insurer view has the full claim file
async function submit(fields) {
  const { receipt } = await post('/api/claims', fields);
  return fetch(`${BASE}/api/claims/${receipt.id}`).then((r) => r.json());
}

// Stands in for the adjuster's Phantom / Solflare wallet: signs the server-issued decision text
const adjuster = nacl.sign.keyPair();
async function decide(id, action, amount) {
  const d = await fetch(`${BASE}/api/claims/${id}/decision-message?action=${action}&amount=${amount ?? ''}`).then((r) => r.json());
  const signature = bs58.encode(nacl.sign.detached(Buffer.from(d.message), adjuster.secretKey));
  const r = await fetch(`${BASE}/api/claims/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: d.action, amount: d.amount, message: d.message, signature, wallet: bs58.encode(adjuster.publicKey), walletName: 'Phantom' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j.claim;
}

async function capture(img) {
  const { challenge } = await fetch(BASE + '/api/challenge').then((r) => r.json());
  const sha = crypto.createHash('sha512').update(img).digest('hex');
  const sig = nacl.sign.detached(Buffer.from(`fraudbusters:v1:${sha}:${challenge}`), device.secretKey);
  return (await post('/api/register', { pubkey, signature: bs58.encode(sig), challenge }, img)).photo;
}

const line = (label, c) =>
  console.log(`${label.padEnd(28)} → ${c.status.padEnd(13)} ${c.reason}\n${' '.repeat(31)}${c.explorer}`);

const img1 = await photo();
const p1 = await capture(img1);
console.log(`capture                      → anchored ${p1.explorer}`);

const c1 = await submit({ pubkey, insurer: 'liffey', amount: '450', photoId: p1.id });
line('claim €450 Liffey', c1);
const c1b = await decide(c1.id, 'approve');
console.log(`adjuster approves            → ${c1b.status.padEnd(13)} ${c1b.reason}`);

const c2 = await submit({ pubkey, insurer: 'harbour', amount: '450', photoId: p1.id });
line('same photo, Harbour', c2);

const p2 = await capture(await photo());
const c3 = await submit({ pubkey, insurer: 'liffey', amount: '2000', photoId: p2.id });
line('claim €2000 (new photo)', c3);
const c3b = await decide(c3.id, 'reject');
console.log(`adjuster rejects             → ${c3b.status}`);

const other = bs58.encode(nacl.sign.keyPair().publicKey);
const p3 = await capture(await photo());
const c4 = await submit({ pubkey: other, insurer: 'liffey', amount: '100', photoId: p3.id });
line("someone else's photo", c4);

const compressed = await sharp(img1).resize(360).jpeg({ quality: 40 }).toBuffer();
const v = await post('/api/check', {}, compressed);
console.log(`verify compressed copy       → ${v.tier}`);
for (const c of v.checks) console.log(`   ${c.status.padEnd(5)} ${c.label}: ${c.detail}`);

const bal = await fetch(`${BASE}/api/balance/${pubkey}`).then((r) => r.json());
console.log(`claimant balance             → ${bal.amount} ${bal.symbol}`);
