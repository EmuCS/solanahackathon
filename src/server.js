import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  ROOT, IMG_DIR, ORIG_DIR, CERT_DIR, PORT, HTTPS_PORT, MEMO_PHOTO, MEMO_CLAIM,
  CHALLENGE_TTL_S, runtimeConfig,
} from './config.js';
import { connection, loadKeypair, writeMemo, payout, explorerTx, explorerAddr } from './solana.js';
import { dhash, thumbnail } from './phash.js';
import { photos, claims, findPhoto, findClaims } from './store.js';
import { paidVerify, reverseImageSearch } from './payClient.js';
import { aiLabelCheck, metadataChecks } from './signals.js';
import { assessPhoto } from './contentCheck.js';

export const INSURERS = {
  liffey: 'Liffey Mutual',
  harbour: 'Harbour Assurance',
};

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(ORIG_DIR, { recursive: true });
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'tweetnacl')));
app.use('/img', express.static(IMG_DIR));
// Prototype: originals are served without auth. Production: private bucket, insurer-scoped access.
app.use('/originals', express.static(ORIG_DIR));

const service = () => loadKeypair('service');
const treasury = () => loadKeypair('treasury');
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex');
const newId = () => crypto.randomBytes(6).toString('hex');
const check = (id, label, status, detail, link) => ({ id, label, status, detail, ...(link ? { link } : {}) });

// Server secret for capture challenges (per process; restarting invalidates open challenges)
const CHALLENGE_KEY = crypto.randomBytes(32);
const mac = (s) => crypto.createHmac('sha256', CHALLENGE_KEY).update(s).digest('base64url').slice(0, 22);

function requireImage(req) {
  if (!req.file) throw Object.assign(new Error('Missing multipart field "image"'), { status: 400 });
  return req.file.buffer;
}

function photoView(p) {
  return {
    id: p.id,
    device: p.pubkey,
    capturedAt: p.createdAt,
    signedAfterChallengeS: p.challengeAgeS ?? null,
    tx: p.tx,
    explorer: explorerTx(p.tx),
    image: `/img/${p.id}.jpg`,
  };
}

// What the claimant sees: never the fraud signals (that would teach fraudsters what to avoid)
const CLAIMANT_STATUS = { paid: 'Paid', rejected: 'Declined' };
function claimantView(c) {
  return {
    id: c.id,
    insurerName: INSURERS[c.insurer] || c.insurer,
    amount: c.amount,
    currency: c.currency,
    description: c.description,
    status: CLAIMANT_STATUS[c.status] || 'Under review',
    createdAt: c.createdAt,
    decidedAt: c.decidedAt || null,
    image: c.image,
    paymentExplorer: c.status === 'paid' && c.decisionTx ? explorerTx(c.decisionTx) : null,
  };
}

function claimView(c) {
  return {
    ...c,
    insurerName: INSURERS[c.insurer] || c.insurer,
    explorer: c.tx ? explorerTx(c.tx) : null,
    decisionExplorer: c.decisionTx ? explorerTx(c.decisionTx) : null,
  };
}

async function verifyImage(buf) {
  const dh = await dhash(buf);
  const hit = findPhoto(dh);
  const { same, similar } = findClaims(dh, hit?.photo.id);
  const brief = (c) => ({
    id: c.id,
    insurer: INSURERS[c.insurer] || c.insurer,
    status: c.status,
    at: c.createdAt,
    explorer: c.tx ? explorerTx(c.tx) : null,
  });
  return {
    verified: !!hit,
    dhash: dh,
    distance: hit?.distance ?? null,
    exact: hit ? hit.photo.sha512 === sha512(buf) : false,
    photo: hit ? photoView(hit.photo) : null,
    priorClaims: same.map(brief),
    similarClaims: similar.map(brief),
    checkedAt: new Date().toISOString(),
  };
}

// Full assessment the insurer's agent runs: paid registry check + local signals + paid reverse search.
// Every check carries a human-readable reason.
// What this claimant has claimed before, at ANY insurer: the shared registry's view no single insurer has
function claimantHistory(claimant) {
  const since = Date.now() - 30 * 864e5;
  const prior = claims.all().filter((c) => c.claimant === claimant && Date.parse(c.createdAt) >= since);
  const insurers = new Set(prior.map((c) => c.insurer));
  const bad = prior.filter((c) => ['flagged', 'rejected'].includes(c.status));
  const list = prior.slice(-5).reverse().map((c) => ({
    at: c.createdAt,
    insurer: INSURERS[c.insurer] || c.insurer,
    amount: c.amount,
    status: c.status,
    explorer: c.tx ? explorerTx(c.tx) : null,
  }));
  const label = 'Claimant history (all insurers)';
  if (!prior.length) return { check: check('history', label, 'pass', 'No earlier claims from this claimant on the shared registry in the last 30 days'), list };
  const detail = `${prior.length} earlier claim(s) in 30 days at ${insurers.size} insurer(s)${bad.length ? `, ${bad.length} flagged or declined` : ''}`;
  const risky = insurers.size >= 2 || bad.length > 0 || prior.length >= 3;
  return { check: check('history', label, risky ? 'warn' : 'info', detail), list };
}

async function assess(buf, { claimant, description, amount } = {}) {
  // AI photo assessment (claims only) runs in parallel with the paid registry check
  const content = description !== undefined ? assessPhoto(buf, description, amount) : null;
  const { result: v, payment } = await paidVerify(buf);
  const payments = [payment];
  const checks = [];
  const tier = v.verified ? 'verified' : 'upload';

  if (v.verified) {
    checks.push(check('capture', 'Capture record on Solana', 'pass',
      `Signed by device ${v.photo.device.slice(0, 6)}… and anchored ${new Date(v.photo.capturedAt).toLocaleString('en-IE')}`, v.photo.explorer));
    checks.push(v.exact
      ? check('integrity', 'Unedited since capture', 'pass', 'Byte-identical to the signed original (SHA-512 match)')
      : check('integrity', 'Unedited since capture', 'warn', `Modified copy of a signed photo (${v.distance}/64 fingerprint bits differ): re-encoded, resized or edited`));
    if (v.photo.signedAfterChallengeS != null) {
      checks.push(check('fresh', 'Live capture', 'pass', `Signed ${v.photo.signedAfterChallengeS}s after a one-time server challenge, live camera only`));
    }
    if (claimant) {
      checks.push(v.photo.device === claimant
        ? check('owner', 'Claimant took the photo', 'pass', 'Capturing device = claimant wallet')
        : check('owner', 'Claimant took the photo', 'fail', `Captured by a different device (${v.photo.device.slice(0, 6)}…)`));
    }
  } else {
    checks.push(check('capture', 'Capture record on Solana', 'warn', 'Not captured in FraudBusters: origin cannot be proven'));
  }

  checks.push(v.priorClaims.length
    ? check('reuse', 'Not claimed before', 'fail',
      `Already used in ${v.priorClaims.length} claim(s), first at ${v.priorClaims[0].insurer} on ${new Date(v.priorClaims[0].at).toLocaleString('en-IE')}`,
      v.priorClaims[0].explorer)
    : v.similarClaims?.length
      ? check('reuse', 'Not claimed before', 'warn',
        `Not the same photo, but visually similar to ${v.similarClaims.length} earlier claim photo(s) (first at ${v.similarClaims[0].insurer}): possible re-shoot of the same damage`,
        v.similarClaims[0].explorer)
      : check('reuse', 'Not claimed before', 'pass', 'No earlier claim with this photo at any insurer on the shared registry'));

  let assessment = null;
  if (content) {
    const r = await content;
    checks.push(...r.checks);
    assessment = r.assessment;
  }
  let history = null;
  if (claimant) {
    const h = claimantHistory(claimant);
    checks.push(h.check);
    history = h.list;
  }
  checks.push(aiLabelCheck(buf));

  if (tier === 'upload') {
    checks.push(...(await metadataChecks(buf)));
    const rs = await reverseImageSearch(buf);
    if (!rs.ran) {
      checks.push(check('web', 'Reverse image search', 'info', `Not run: ${rs.reason}`));
    } else {
      payments.push(rs.payment);
      if (rs.fullMatches || rs.pages.length) {
        checks.push(check('web', 'Reverse image search', 'fail',
          `Found online: ${rs.fullMatches} exact match(es) on ${rs.pages.length} page(s)${rs.pages[0] ? ` e.g. “${rs.pages[0].title}”` : ''}`,
          rs.pages[0]?.url));
      } else if (rs.partialMatches) {
        checks.push(check('web', 'Reverse image search', 'warn', `${rs.partialMatches} partial match(es) online (crops/edits of this image)`));
      } else {
        checks.push(check('web', 'Reverse image search', 'pass', 'No copies found online (Google Vision web detection)'));
      }
    }
  } else {
    checks.push(check('web', 'Reverse image search', 'info', 'Not needed: captured live in-app and anchored at capture'));
  }

  return { verification: v, checks, tier, payments, assessment, history };
}

// Triage only. We verify the *evidence* (authentic, unedited, not reused); whether the photo actually
// shows covered damage is a human decision, so nothing is paid until an adjuster approves.
function triage({ checks, tier }) {
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  if (fails.length) return { status: 'flagged', reason: `Fraud review: ${fails.map((f) => f.label.toLowerCase()).join(', ')} failed.` };
  if (tier === 'verified' && !warns.length) {
    return { status: 'verified', reason: 'Evidence verified: authentic, unedited, first use. Priority queue for adjuster approval.' };
  }
  return {
    status: 'review',
    reason: `${tier === 'upload' ? 'Not captured in FraudBusters' : 'Verified with warnings'}: standard review with ${warns.length} risk signal(s) attached.`,
  };
}

// 0. One-time challenge the capture page requests at the moment the shutter is pressed
app.get('/api/challenge', (_req, res) => {
  const ts = Math.floor(Date.now() / 1000).toString();
  res.json({ challenge: `${ts}.${mac(ts)}` });
});

// 1. Capture: device signs sha512(photo)+challenge; we anchor fingerprint + signature on Solana
app.post('/api/register', upload.single('image'), async (req, res) => {
  const buf = requireImage(req);
  const { pubkey, signature, challenge = '' } = req.body;
  const [ts, tag] = challenge.split('.');
  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (!ts || tag !== mac(ts) || !(age >= 0 && age <= CHALLENGE_TTL_S)) {
    return res.status(400).json({ error: 'Capture challenge missing or expired: photos must be taken live in the app' });
  }
  const sha = sha512(buf);
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(
      Buffer.from(`fraudbusters:v1:${sha}:${challenge}`),
      bs58.decode(signature),
      new PublicKey(pubkey).toBytes(),
    );
  } catch {}
  if (!ok) return res.status(400).json({ error: 'Device signature does not match this photo' });

  const existing = photos.all().find((p) => p.sha512 === sha);
  if (existing) return res.json({ photo: photoView(existing), duplicate: true });

  const dh = await dhash(buf);
  const id = newId();
  const memo = [MEMO_PHOTO, dh, sha, pubkey, signature, challenge].join('|');
  const tx = await writeMemo(service(), memo);
  fs.writeFileSync(path.join(ORIG_DIR, `${id}.jpg`), buf);
  fs.writeFileSync(path.join(IMG_DIR, `${id}.jpg`), await thumbnail(buf));
  const photo = photos.add({
    id, dhash: dh, sha512: sha, pubkey, signature, challenge, challengeAgeS: age, tx, createdAt: new Date().toISOString(),
  });
  res.json({ photo: photoView(photo), memo });
});

app.get('/api/photos', (req, res) => {
  const device = String(req.query.device || '');
  res.json(photos.all().filter((p) => !device || p.pubkey === device).reverse().map(photoView));
});

// 2. Verify — the paid endpoint. Reached through the Pay.sh gateway (paywall.yml).
app.get('/v1/health', (_req, res) => res.json({ ok: true }));
app.post('/v1/verify', upload.single('image'), async (req, res) => {
  res.json(await verifyImage(requireImage(req)));
});

// Browser-facing check: the server acts as an agent and pays via Pay.sh
app.post('/api/check', upload.single('image'), async (req, res) => {
  res.json(await assess(requireImage(req)));
});

// 3. Claim: insurer's agent assesses the evidence and triages it with reasons (no payout here)
app.post('/api/claims', upload.single('image'), async (req, res) => {
  const { pubkey, insurer, description = '', photoId } = req.body;
  const amount = Number(req.body.amount);
  if (!INSURERS[insurer]) return res.status(400).json({ error: 'Unknown insurer' });
  if (!(amount > 0 && amount <= 10000)) return res.status(400).json({ error: 'Amount must be between 0 and 10000' });
  let claimant;
  try {
    claimant = new PublicKey(pubkey);
  } catch {
    return res.status(400).json({ error: 'Invalid claimant wallet' });
  }

  let buf;
  if (photoId) {
    const file = path.join(ORIG_DIR, `${String(photoId).replace(/[^a-f0-9]/g, '')}.jpg`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Capture not found' });
    buf = fs.readFileSync(file);
  } else {
    buf = requireImage(req);
  }

  const a = await assess(buf, { claimant: claimant.toBase58(), description: String(description), amount });
  const { status, reason } = triage(a);

  const id = newId();
  fs.writeFileSync(path.join(ORIG_DIR, `claim-${id}.jpg`), buf);
  // Registering the claim on-chain is what lets every other insurer detect reuse of this photo
  const memo = [MEMO_CLAIM, a.verification.dhash, insurer, id, status, a.verification.photo?.id || '-', amount, claimant.toBase58()].join('|');
  const tx = await writeMemo(service(), memo);
  const { payoutSymbol } = runtimeConfig();

  const claim = claims.add({
    id,
    insurer,
    amount,
    currency: payoutSymbol,
    description: String(description).slice(0, 280),
    claimant: claimant.toBase58(),
    dhash: a.verification.dhash,
    photoId: a.verification.photo?.id || null,
    tier: a.tier,
    status,
    reason,
    checks: a.checks,
    payments: a.payments,
    assessment: a.assessment,
    history: a.history,
    image: `/originals/claim-${id}.jpg`,
    tx,
    createdAt: new Date().toISOString(),
  });
  res.json({ receipt: claimantView(claim) });
});

app.get('/api/claims', (req, res) => {
  const insurer = String(req.query.insurer || '');
  res.json(claims.all().filter((c) => !insurer || c.insurer === insurer).reverse().map(claimView));
});

app.get('/api/my-claims/:claimant', (req, res) => {
  res.json(claims.all().filter((c) => c.claimant === req.params.claimant).reverse().map(claimantView));
});

app.get('/api/claims/:id', (req, res) => {
  const c = claims.all().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Claim not found' });
  res.json(claimView(c));
});

// 4. Adjuster decision. Approve → stablecoin payout + decision memo in one atomic tx (settles in seconds).
// Prototype: no adjuster auth. Production: insurer SSO + role checks.
app.post('/api/claims/:id/decision', async (req, res) => {
  const c = claims.all().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Claim not found' });
  if (c.status === 'paid' || c.status === 'rejected') return res.status(409).json({ error: `Claim already ${c.status}` });
  const { action, note = '' } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });

  const status = action === 'approve' ? 'paid' : 'rejected';
  const memo = [MEMO_CLAIM, c.dhash, c.insurer, c.id, status, c.photoId || '-', c.amount, c.claimant].join('|');
  let decisionTx;
  if (status === 'paid') {
    const { payoutMint } = runtimeConfig();
    if (!payoutMint) throw new Error('No payout mint configured: run `npm run setup`');
    decisionTx = await payout({ treasury: treasury(), mint: new PublicKey(payoutMint), to: new PublicKey(c.claimant), amount: c.amount, memo });
  } else {
    decisionTx = await writeMemo(service(), memo);
  }
  const updated = claims.update(c.id, {
    status,
    decisionTx,
    decisionNote: String(note).slice(0, 280),
    decidedAt: new Date().toISOString(),
    reason: status === 'paid' ? `Approved by adjuster; €${c.amount.toFixed(2)} settled in stablecoins.` : 'Rejected by adjuster.',
  });
  res.json({ claim: claimView(updated) });
});

app.get('/api/feed', (_req, res) => {
  res.json({
    photos: photos.all().slice(-12).reverse().map(photoView),
    claims: claims.all().slice(-12).reverse().map(claimView),
    insurers: INSURERS,
  });
});

app.get('/api/balance/:owner', async (req, res) => {
  const { payoutMint, payoutSymbol } = runtimeConfig();
  const owner = new PublicKey(req.params.owner);
  let amount = 0;
  if (payoutMint) {
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(payoutMint), owner);
      amount = (await connection.getTokenAccountBalance(ata)).value.uiAmount ?? 0;
    } catch {}
  }
  res.json({ owner: owner.toBase58(), amount, symbol: payoutSymbol, explorer: explorerAddr(owner.toBase58()) });
});

app.get('/api/config', (_req, res) => {
  const { payoutMint, payoutSymbol } = runtimeConfig();
  res.json({ payoutMint, payoutSymbol, insurers: INSURERS, service: service().publicKey.toBase58() });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || String(err) });
});

// Longer keep-alive than clients' idle reuse window, avoiding ECONNRESET races on reused sockets
const keepAlive = (srv) => Object.assign(srv, { keepAliveTimeout: 65000, headersTimeout: 66000 });
keepAlive(http.createServer(app)).listen(PORT, '0.0.0.0', () => console.log(`FraudBusters on http://localhost:${PORT}`));

// HTTPS for phones: browsers only allow the live camera on secure origins (run `npm run cert` once)
const keyFile = path.join(CERT_DIR, 'key.pem');
const certFile = path.join(CERT_DIR, 'cert.pem');
if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
  keepAlive(https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app))
    .listen(HTTPS_PORT, '0.0.0.0', () => console.log(`FraudBusters on https://<LAN-IP>:${HTTPS_PORT} (self-signed)`));
}
