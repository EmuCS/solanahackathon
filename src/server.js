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
  ROOT, IMG_DIR, ORIG_DIR, CERT_DIR, PORT, HTTPS_PORT, MEMO_PHOTO, MEMO_CLAIM, MEMO_LINK,
  CHALLENGE_TTL_S, runtimeConfig,
} from './config.js';
import { connection, loadKeypair, writeMemo, payout, explorerTx, explorerAddr } from './solana.js';
import { dhash, hamming, thumbnail } from './phash.js';
import { photos, claims, links, findPhoto, findClaims, SAME_THRESHOLD } from './store.js';
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

// Public half of the local HTTPS cert, so a phone can install and trust it (Settings → Profile).
// Home-screen web apps need a trusted cert; the private key never leaves certs/.
app.get('/fraudbusters.crt', (_req, res) => {
  const file = path.join(CERT_DIR, 'cert.pem');
  if (!fs.existsSync(file)) return res.status(404).send('Run npm run cert first');
  res.type('application/x-x509-ca-cert').send(fs.readFileSync(file));
});

const service = () => loadKeypair('service');
const treasury = () => loadKeypair('treasury');
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex');
const newId = () => crypto.randomBytes(6).toString('hex');
const check = (id, label, status, detail, link) => ({ id, label, status, detail, ...(link ? { link } : {}) });

// Server secret for capture challenges (per process; restarting invalidates open challenges)
const CHALLENGE_KEY = crypto.randomBytes(32);
const mac = (s) => crypto.createHmac('sha256', CHALLENGE_KEY).update(s).digest('base64url').slice(0, 22);

// Guided capture set: wide shot, close-up, then a shot from a side the server picks at random, so
// the claimant has to be standing at the real object. Set ids carry a MAC: they can't be invented.
export const SHOTS = ['wide', 'close', 'angle'];
const SHOT_LABEL = { wide: 'Wide', close: 'Close-up', angle: 'Side' };
const setMac = (r) => crypto.createHmac('sha256', CHALLENGE_KEY).update(`set:${r}`).digest('hex');
const validSet = (id) => /^[a-f0-9]{16}$/.test(id) && setMac(id.slice(0, 10)).slice(0, 6) === id.slice(10);
const sideOf = (id) => (parseInt(setMac(id.slice(0, 10)).slice(6, 8), 16) % 2 ? 'left' : 'right');
const SET_MAX_SPAN_S = 600;

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
    ...(p.set ? { set: p.set, shot: p.shot, side: p.side || null } : {}),
  };
}

// What the claimant sees: never the fraud signals (that would teach fraudsters what to avoid)
const CLAIMANT_STATUS = { paid: 'Paid', rejected: 'Declined', offered: 'Offer received' };
function claimantView(c) {
  return {
    id: c.id,
    insurerName: INSURERS[c.insurer] || c.insurer,
    amount: c.amount,
    // The adjuster's offer and note are addressed to the claimant; fraud signals stay insurer-side
    offer: c.status === 'offered' ? { amount: c.offerAmount, note: c.offerNote || '' } : null,
    paidAmount: c.status === 'paid' ? (c.paidAmount ?? c.amount) : null,
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
  const link = linkFor(c.claimant);
  return {
    ...c,
    payoutTo: c.paidTo || payoutAddress(c),
    payoutWallet: c.paidTo ? c.paidToWallet || null : link?.walletName || null,
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

// Provenance of a guided set: all three shots live-captured by the claimant's device, distinct, and
// taken in one session. Whether they show the same object is the AI's call (see contentCheck.js).
function setCheck(set, claimant) {
  const label = 'Multi-angle capture (3 shots)';
  const others = set.filter((s) => s.pubkey !== claimant);
  if (others.length) return check('set', label, 'fail', `${others.map((s) => SHOT_LABEL[s.shot]).join(', ')} shot taken by a different device`);
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      if (hamming(set[i].dhash, set[j].dhash) <= SAME_THRESHOLD) {
        return check('set', label, 'fail', `${SHOT_LABEL[set[i].shot]} and ${SHOT_LABEL[set[j].shot]} shots are the same picture`);
      }
    }
  }
  const times = set.map((s) => Date.parse(s.createdAt));
  const span = Math.round((Math.max(...times) - Math.min(...times)) / 1000);
  const side = set.find((s) => s.shot === 'angle')?.side;
  const what = `Wide, close-up and ${side ? `${side}-side (picked at random)` : 'side'} shots, each signed live and anchored on Solana`;
  return span > SET_MAX_SPAN_S
    ? check('set', label, 'warn', `${what}, but taken ${Math.round(span / 60)} min apart`)
    : check('set', label, 'pass', `${what}, within ${span} s`);
}

async function assess(buf, { claimant, description, amount, set } = {}) {
  // AI photo assessment (claims only) runs in parallel with the paid registry check
  const images = set ? set.map((s) => ({ buf: s.buf, label: `Shot: ${SHOT_LABEL[s.shot]}${s.side ? ` (from the ${s.side})` : ''}` })) : [{ buf }];
  const content = description !== undefined ? assessPhoto(images, description, amount) : null;
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

  if (set) checks.push(setCheck(set, claimant));
  // With a set, every shot is checked against the registry, not only the primary close-up
  const extraPrior = (set || [])
    .filter((s) => s.buf !== buf)
    .flatMap((s) => findClaims(s.dhash, s.id).same.map((c) => ({ shot: s.shot, c })));
  checks.push(v.priorClaims.length
    ? check('reuse', 'Not claimed before', 'fail',
      `Already used in ${v.priorClaims.length} claim(s), first at ${v.priorClaims[0].insurer} on ${new Date(v.priorClaims[0].at).toLocaleString('en-IE')}`,
      v.priorClaims[0].explorer)
    : extraPrior.length
      ? check('reuse', 'Not claimed before', 'fail',
        `${SHOT_LABEL[extraPrior[0].shot]} shot already used in a claim at ${INSURERS[extraPrior[0].c.insurer] || extraPrior[0].c.insurer} on ${new Date(extraPrior[0].c.createdAt).toLocaleString('en-IE')}`,
        extraPrior[0].c.tx ? explorerTx(extraPrior[0].c.tx) : undefined)
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

// 0b. Start a guided capture set; the side for the third shot is random and fixed by the server
app.get('/api/capture-set', (_req, res) => {
  const r = crypto.randomBytes(5).toString('hex');
  const id = r + setMac(r).slice(0, 6);
  res.json({ set: id, side: sideOf(id), shots: SHOTS });
});

// 1. Capture: device signs sha512(photo)+challenge; we anchor fingerprint + signature on Solana
app.post('/api/register', upload.single('image'), async (req, res) => {
  const buf = requireImage(req);
  const { pubkey, signature, challenge = '', set = '', shot = '' } = req.body;
  if ((set || shot) && !(validSet(set) && SHOTS.includes(shot))) {
    return res.status(400).json({ error: 'Capture set not recognised (it expires when the server restarts): start over' });
  }
  if (set && photos.all().some((p) => p.set === set && p.shot === shot)) {
    return res.status(409).json({ error: `${SHOT_LABEL[shot]} shot already recorded for this set` });
  }
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
  if (existing && set) return res.status(409).json({ error: 'This photo is already recorded: take a new one' });
  if (existing) return res.json({ photo: photoView(existing), duplicate: true });

  const dh = await dhash(buf);
  const id = newId();
  const inSet = set ? { set, shot, ...(shot === 'angle' ? { side: sideOf(set) } : {}) } : {};
  // Set membership is part of the on-chain record (7th field; older records have 6)
  const memo = [MEMO_PHOTO, dh, sha, pubkey, signature, challenge, ...(set ? [`${set}:${shot}`] : [])].join('|');
  const tx = await writeMemo(service(), memo);
  fs.writeFileSync(path.join(ORIG_DIR, `${id}.jpg`), buf);
  fs.writeFileSync(path.join(IMG_DIR, `${id}.jpg`), await thumbnail(buf));
  const photo = photos.add({
    id, dhash: dh, sha512: sha, pubkey, signature, challenge, challengeAgeS: age, tx, createdAt: new Date().toISOString(), ...inSet,
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
  const { pubkey, insurer, description = '', photoId, setId } = req.body;
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
  let set = null;
  if (setId) {
    const by = Object.fromEntries(photos.all().filter((p) => p.set === String(setId)).map((p) => [p.shot, p]));
    if (SHOTS.some((s) => !by[s])) return res.status(400).json({ error: 'Capture set incomplete: all three shots are needed' });
    set = SHOTS.map((s) => ({ ...by[s], buf: fs.readFileSync(path.join(ORIG_DIR, `${by[s].id}.jpg`)) }));
    buf = set[1].buf; // the close-up is the primary evidence
  } else if (photoId) {
    const file = path.join(ORIG_DIR, `${String(photoId).replace(/[^a-f0-9]/g, '')}.jpg`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Capture not found' });
    buf = fs.readFileSync(file);
  } else {
    buf = requireImage(req);
  }

  const a = await assess(buf, { claimant: claimant.toBase58(), description: String(description), amount, set });
  const { status, reason } = triage(a);

  const id = newId();
  fs.writeFileSync(path.join(ORIG_DIR, `claim-${id}.jpg`), buf);
  // Registering the claim on-chain is what lets every other insurer detect reuse of this photo
  const memo = [MEMO_CLAIM, a.verification.dhash, insurer, id, status, a.verification.photo?.id || '-', amount, claimant.toBase58(), ...(set ? [setId] : [])].join('|');
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
    ...(set
      ? {
          setId,
          shotIds: set.map((s) => s.id),
          shotHashes: set.map((s) => s.dhash),
          shots: set.map((s) => ({ shot: s.shot, side: s.side || null, image: `/img/${s.id}.jpg`, explorer: explorerTx(s.tx) })),
        }
      : {}),
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

// Wallets. A claimant links Phantom / Solflare once (the device asks, the wallet signs), and payouts go
// there instead of the device key. Adjusters sign every decision with their own wallet. The wallets only
// sign messages, so this works on any cluster, including test networks the wallet apps can't display.
const linkFor = (device) => links.all().filter((l) => l.device === device).at(-1) || null;
const payoutAddress = (c) => linkFor(c.claimant)?.wallet || c.claimant;
const WALLET_NAMES = ['Phantom', 'Solflare'];
const verifyText = (text, signature, signer) => {
  try {
    return nacl.sign.detached.verify(Buffer.from(text), bs58.decode(String(signature)), new PublicKey(signer).toBytes());
  } catch {
    return false;
  }
};
const now = () => Math.floor(Date.now() / 1000);
const linkText = (device, token) =>
  `FraudBusters: send my claim payments to this wallet.\nDevice: ${device}\nCode: ${token}`;

// The claimant's device asks for a one-time link code (signed by the device key, so nobody else can
// redirect its payouts), then the wallet signs a message containing that code.
app.post('/api/link/start', (req, res) => {
  const { device, ts, signature } = req.body || {};
  const age = now() - Number(ts);
  if (!(age >= -30 && age <= 120) || !verifyText(`fraudbusters:link-start:v1:${device}:${ts}`, signature, device)) {
    return res.status(403).json({ error: 'Device signature missing or expired' });
  }
  const t = String(now());
  const token = `${t}.${mac(`link:${device}:${t}`)}`;
  res.json({ token, message: linkText(device, token), url: `/link.html?device=${device}&token=${encodeURIComponent(token)}` });
});

app.get('/api/link/message', (req, res) => res.json({ message: linkText(String(req.query.device), String(req.query.token)) }));

app.post('/api/link/finish', async (req, res) => {
  const { device, token = '', wallet, walletName, signature } = req.body || {};
  const [t, tag] = String(token).split('.');
  if (!t || tag !== mac(`link:${device}:${t}`) || now() - Number(t) > 900) {
    return res.status(400).json({ error: 'Link code expired: start again from the FraudBusters app' });
  }
  if (!verifyText(linkText(device, token), signature, wallet)) return res.status(403).json({ error: 'Wallet signature does not match' });
  const name = WALLET_NAMES.includes(walletName) ? walletName : 'Wallet';
  const tx = await writeMemo(service(), [MEMO_LINK, device, wallet, signature].join('|'));
  const link = links.add({ device, wallet, walletName: name, signature, tx, at: new Date().toISOString() });
  res.json({ link: { ...link, explorer: explorerTx(tx) } });
});

// Back to the device's built-in wallet: also signed by the device, also on the record
app.post('/api/link/unlink', async (req, res) => {
  const { device, ts, signature } = req.body || {};
  const age = now() - Number(ts);
  if (!(age >= -30 && age <= 120) || !verifyText(`fraudbusters:unlink:v1:${device}:${ts}`, signature, device)) {
    return res.status(403).json({ error: 'Device signature missing or expired' });
  }
  if (!linkFor(device)?.wallet) return res.json({ link: null });
  const tx = await writeMemo(service(), [MEMO_LINK, device, '-', signature].join('|'));
  links.add({ device, wallet: null, walletName: null, signature, tx, at: new Date().toISOString() });
  res.json({ link: null });
});

app.get('/api/link/:device', (req, res) => {
  const l = linkFor(req.params.device);
  res.json({ link: l?.wallet ? { wallet: l.wallet, walletName: l.walletName, at: l.at, explorer: explorerTx(l.tx) } : null });
});

// 4. Adjuster decision: approve the full amount, send a lower offer, or reject.
// Approve → stablecoin payout + decision memo in one atomic tx (settles in seconds).
// The adjuster's wallet signs a server-issued, human-readable decision (claim, amount, payee); the
// signature and wallet are recorded on Solana with the decision. Prototype: any wallet may sign;
// production: an allowlist of each insurer's adjuster wallets.
const settling = new Set(); // one payout per claim at a time (adjuster and claimant can race)
const money = (n) => `€${n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const decisionMemo = (c, status, extra = []) =>
  [MEMO_CLAIM, c.dhash, c.insurer, c.id, status, c.photoId || '-', c.amount, c.claimant, ...extra].join('|');

async function settle(c, amount, memo) {
  const { payoutMint } = runtimeConfig();
  if (!payoutMint) throw new Error('No payout mint configured: run `npm run setup`');
  const to = payoutAddress(c);
  const tx = await payout({ treasury: treasury(), mint: new PublicKey(payoutMint), to: new PublicKey(to), amount, memo });
  return { tx, paidTo: to, paidToWallet: linkFor(c.claimant)?.walletName || null };
}

// Offering the full amount is an approval; reject carries no amount
function normalise(c, action, amount) {
  amount = Math.round(Number(amount) * 100) / 100;
  if (action === 'offer' && amount >= c.amount) action = 'approve';
  if (action === 'approve') amount = c.amount;
  if (action === 'reject') amount = 0;
  return { action, amount };
}
function decisionText(c, action, amount, ts) {
  const what = { approve: `Approve and pay ${money(c.amount)}`, offer: `Offer ${money(amount)} (claimed ${money(c.amount)})`, reject: 'Reject the claim' }[action];
  return [
    'FraudBusters adjuster decision',
    `Insurer: ${INSURERS[c.insurer] || c.insurer}`,
    `Claim: ${c.id}`,
    `Decision: ${what}`,
    ...(action === 'reject' ? [] : [`Payment to: ${payoutAddress(c)}`]),
    `Ref: ${ts}.${mac(`decision:${c.id}:${action}:${amount.toFixed(2)}:${ts}`)}`,
  ].join('\n');
}

app.get('/api/claims/:id/decision-message', (req, res) => {
  const c = claims.all().find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Claim not found' });
  if (!['approve', 'offer', 'reject'].includes(req.query.action)) return res.status(400).json({ error: 'action must be approve, offer or reject' });
  const { action, amount } = normalise(c, req.query.action, req.query.amount);
  if (action === 'offer' && !(amount > 0)) return res.status(400).json({ error: 'Offer must be more than €0' });
  res.json({ action, amount, message: decisionText(c, action, amount, String(now())) });
});

async function withClaim(id, res, fn) {
  if (settling.has(id)) return res.status(409).json({ error: 'A decision on this claim is already in progress' });
  settling.add(id);
  try {
    const c = claims.all().find((x) => x.id === id);
    if (!c) return res.status(404).json({ error: 'Claim not found' });
    await fn(c);
  } finally {
    settling.delete(id);
  }
}

app.post('/api/claims/:id/decision', (req, res) =>
  withClaim(req.params.id, res, async (c) => {
    if (['paid', 'rejected'].includes(c.status)) return res.status(409).json({ error: `Claim already ${c.status}` });
    const body = req.body || {};
    const note = String(body.note || '').slice(0, 280);
    if (!['approve', 'offer', 'reject'].includes(body.action)) return res.status(400).json({ error: 'action must be approve, offer or reject' });
    const { action, amount } = normalise(c, body.action, body.amount);
    if (action === 'offer' && !(amount > 0)) return res.status(400).json({ error: 'Offer must be more than €0' });
    // The signed text must be exactly the one we issued for this claim, action and amount, and recent
    const ts = String(body.message || '').match(/\nRef: (\d+)\./)?.[1];
    if (!ts || now() - Number(ts) > 300 || body.message !== decisionText(c, action, amount, ts)) {
      return res.status(400).json({ error: 'Decision not signed or expired: sign it again in your wallet' });
    }
    if (!verifyText(body.message, body.signature, body.wallet)) return res.status(403).json({ error: 'Wallet signature does not match' });
    const adjuster = { wallet: String(body.wallet), walletName: WALLET_NAMES.includes(body.walletName) ? body.walletName : 'Wallet', signature: String(body.signature) };
    const signedBy = [`adj:${adjuster.wallet}`, `adjsig:${adjuster.signature}`];

    const at = new Date().toISOString();
    if (action === 'offer') {
      const tx = await writeMemo(service(), decisionMemo(c, 'offered', [`offer:${amount.toFixed(2)}`, ...signedBy]));
      const updated = claims.update(c.id, {
        status: 'offered',
        statusBeforeOffer: c.status === 'offered' ? c.statusBeforeOffer : c.status,
        offerAmount: amount,
        offerNote: note,
        offeredAt: at,
        offerTx: tx,
        offers: [...(c.offers || []), { amount, note, at, tx, adjuster }],
        offeredBy: adjuster,
        reason: `Offer of ${money(amount)} sent (claimed ${money(c.amount)}); waiting for the claimant to accept.`,
      });
      return res.json({ claim: claimView(updated) });
    }
    const status = action === 'approve' ? 'paid' : 'rejected';
    const memo = decisionMemo(c, status, signedBy);
    const paid = status === 'paid' ? await settle(c, c.amount, memo) : null;
    const decisionTx = paid ? paid.tx : await writeMemo(service(), memo);
    const updated = claims.update(c.id, {
      status,
      decisionTx,
      decisionNote: note,
      decidedAt: at,
      decidedBy: adjuster,
      ...(paid ? { paidAmount: c.amount, paidTo: paid.paidTo, paidToWallet: paid.paidToWallet } : {}),
      reason: status === 'paid' ? `Approved by adjuster; ${money(c.amount)} settled in stablecoins.` : 'Rejected by adjuster.',
    });
    res.json({ claim: claimView(updated) });
  }),
);

// 5. Claimant answers an offer. The device key that captured the evidence (and receives the payment)
// signs the answer, so only the claimant can accept, and only the exact amount offered.
app.post('/api/my-claims/:id/respond', (req, res) =>
  withClaim(req.params.id, res, async (c) => {
    const { action, signature } = req.body || {};
    if (c.status !== 'offered') return res.status(409).json({ error: 'There is no open offer on this claim' });
    if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'action must be accept or decline' });
    let ok = false;
    try {
      ok = nacl.sign.detached.verify(
        Buffer.from(`fraudbusters:offer:v1:${c.id}:${action}:${c.offerAmount.toFixed(2)}`),
        bs58.decode(String(signature)),
        new PublicKey(c.claimant).toBytes(),
      );
    } catch {}
    if (!ok) return res.status(403).json({ error: 'Signature does not match the claimant device' });

    const at = new Date().toISOString();
    const offers = (c.offers || []).map((o, i, a) => (i === a.length - 1 ? { ...o, response: action, respondedAt: at } : o));
    if (action === 'decline') {
      const memo = decisionMemo(c, 'offer-declined', [`offer:${c.offerAmount.toFixed(2)}`]);
      const tx = await writeMemo(service(), memo);
      const updated = claims.update(c.id, {
        status: c.statusBeforeOffer || 'review',
        offers,
        offerDeclinedTx: tx,
        reason: `Claimant declined the offer of ${money(c.offerAmount)}: back with the adjuster.`,
      });
      return res.json({ receipt: claimantView(updated) });
    }
    const paid = await settle(c, c.offerAmount, decisionMemo(c, 'paid', [`paid:${c.offerAmount.toFixed(2)}`]));
    const updated = claims.update(c.id, {
      status: 'paid',
      paidAmount: c.offerAmount,
      paidTo: paid.paidTo,
      paidToWallet: paid.paidToWallet,
      decisionTx: paid.tx,
      decidedBy: c.offeredBy || null,
      decidedAt: at,
      offers,
      reason: `Offer of ${money(c.offerAmount)} accepted by the claimant; settled in stablecoins.`,
    });
    res.json({ receipt: claimantView(updated) });
  }),
);

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
