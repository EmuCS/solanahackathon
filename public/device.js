// Device key = ed25519 keypair kept on this device. Its public key is also a Solana
// address, so the device that captured a photo is the wallet that gets paid.
// Uses tweetnacl (global `nacl`, loaded from /vendor) — no secure context needed.
const KEY = 'fraudbusters.device.v1';
const LEGACY_KEY = 'realshot.device.v1';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let memoryKey = null;
export function getDevice() {
  let stored = null;
  try {
    stored = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
    if (stored) localStorage.setItem(KEY, stored);
  } catch {}
  if (stored) return nacl.sign.keyPair.fromSecretKey(fromB64(stored));
  if (memoryKey) return memoryKey;
  memoryKey = nacl.sign.keyPair();
  try {
    localStorage.setItem(KEY, toB64(memoryKey.secretKey));
  } catch {}
  return memoryKey;
}

export const deviceAddress = () => b58(getDevice().publicKey);
export const short = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '');

// Signs sha512(photo) bound to a one-time server challenge fetched at shutter time
export async function signPhoto(blob, challenge) {
  const kp = getDevice();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha = hex(nacl.hash(bytes)); // SHA-512
  const sig = nacl.sign.detached(new TextEncoder().encode(`fraudbusters:v1:${sha}:${challenge}`), kp.secretKey);
  return { sha, signature: b58(sig), pubkey: b58(kp.publicKey) };
}

// Simulates what WhatsApp / X / a screenshot does: downscale, re-encode, strip metadata
export async function degradedCopy(blob, maxDim = 720, quality = 0.45) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
}

export async function post(path, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(path, {
    method: 'POST',
    body: isForm ? body : JSON.stringify(body),
    headers: isForm ? {} : { 'content-type': 'application/json' },
  });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export function setStep(list, i, state) {
  const li = list.children[i];
  if (li) li.className = state;
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' });
}

export const eur = (n) => `€${Number(n || 0).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Claim statuses (legacy test values mapped onto current ones)
const STATUS_MAP = { fast_track: 'verified', manual_review: 'review' };
export const STATUS = {
  verified: { label: 'Evidence verified', title: 'Evidence verified: awaiting adjuster' },
  review: { label: 'Standard review', title: 'Standard review' },
  flagged: { label: 'Flagged', title: 'Flagged for fraud review' },
  paid: { label: 'Paid', title: 'Approved and paid' },
  rejected: { label: 'Rejected', title: 'Rejected' },
};
export const statusKey = (s) => STATUS_MAP[s] || s;
export const badge = (s) => {
  const k = statusKey(s);
  return `<span class="badge ${k}">${esc(STATUS[k]?.label || s)}</span>`;
};

function paymentHtml(p) {
  const ref = p.reference ? ` · <span class="mono">${esc(short(p.reference))}</span>` : '';
  const link = p.receiptUrl ? ` · <a href="${esc(p.receiptUrl)}" target="_blank" rel="noopener">receipt</a>` : '';
  return `<li>${esc(p.service || 'Check')}: ${esc(p.price)} USDC, ${esc(p.network)}, ${p.ms} ms${ref}${link}</li>`;
}
export function paymentsHtml(list = []) {
  return list.length ? `<ul class="payments">${list.map(paymentHtml).join('')}</ul>` : '';
}

const ICON = { pass: '✓', fail: '✕', warn: '!', info: 'i' };
export function checksHtml(checks = []) {
  return `<ul class="checks">${checks
    .map(
      (c) => `<li class="${c.status}"><span class="ic">${ICON[c.status]}</span><div><b>${esc(c.label)}</b><div class="d">${esc(c.detail)}${
        c.link ? ` <a href="${esc(c.link)}" target="_blank" rel="noopener">View&nbsp;record</a>` : ''
      }</div></div></li>`,
    )
    .join('')}</ul>`;
}

// Logo marks. Blue facets are fixed; neutral strokes use currentColor (white on the dark header,
// ink on light backgrounds). Compare them at /logos.html; the choice is remembered per browser.
const SHIELD = 'M24 2.5 L43 8.5 V21.5 C43 33.5 35 42 24 45.5 C13 42 5 33.5 5 21.5 V8.5 Z';
export const LOGOS = {
  // Faceted shield with a strike cut clean through it: fraud stopped
  strike: (id = 'm') => `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
    <defs><mask id="${id}"><rect width="48" height="48" fill="#fff"/><path d="M33.5 9 L38.5 9 L14.5 40 L9.5 40 Z" fill="#000"/></mask></defs>
    <g mask="url(#${id})">
      <path d="M24 2.5 L5 8.5 V21.5 C5 33.5 13 42 24 45.5 Z" fill="#3a6df0"/>
      <path d="M24 2.5 L43 8.5 V21.5 C43 33.5 35 42 24 45.5 Z" fill="#1f45c7"/>
    </g>
  </svg>`,
  // Umbrella canopy with a fanged edge and a blade-like handle
  fang: () => `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M24 5 L3 28 L8.25 24 L13.5 28 L18.75 24 L24 28 Z" fill="#3a6df0"/>
    <path d="M24 5 L45 28 L39.75 24 L34.5 28 L29.25 24 L24 28 Z" fill="#1f45c7"/>
    <path d="M24 28 V40 L19.5 44.5 L16 41" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linejoin="miter" stroke-linecap="square"/>
  </svg>`,
  // Bastion: the umbrella held inside a shield wall
  bastion: () => `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">
    <path d="${SHIELD}" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linejoin="miter"/>
    <path d="M24 12 L36 25.5 L32 23 L28 25.5 L24 23 L20 25.5 L16 23 L12 25.5 Z" fill="#3a6df0"/>
    <path d="M24 24 V36" stroke="currentColor" stroke-width="3" stroke-linecap="square"/>
  </svg>`,
};
export function currentLogo() {
  try {
    const k = localStorage.getItem('fraudbusters.logo');
    if (k && LOGOS[k]) return k;
  } catch {}
  return 'strike';
}

// Two separate products: the claimant's app and the insurer's portal
const ROLES = {
  claimant: {
    label: 'Claimant app',
    links: [
      ['/capture.html', 'Capture'],
      ['/claim.html', 'Submit claim'],
      ['/my-claims.html', 'My claims'],
    ],
  },
  insurer: {
    label: 'Insurer portal',
    links: [
      ['/adjuster.html', 'Claims queue'],
      ['/verify.html', 'Verify a photo'],
    ],
  },
  public: {
    label: 'Test network',
    links: [
      ['/capture.html', 'Claimant app'],
      ['/adjuster.html', 'Insurer portal'],
    ],
  },
};

export function nav(active, role = 'public') {
  if (!document.querySelector('link[rel=icon]')) {
    document.head.insertAdjacentHTML('beforeend', '<link rel="icon" type="image/svg+xml" href="/logo.svg" />');
  }
  const r = ROLES[role] || ROLES.public;
  document.body.dataset.role = role;
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<header class="topbar"><div class="inner">
      <a class="brand" href="/">${LOGOS[currentLogo()]('fb-nav')}<span class="word">FRAUDBUSTERS</span></a>
      <nav>${r.links.map(([h, t]) => `<a href="${h}"${h === active ? ' class="active"' : ''}>${t}</a>`).join('')}</nav>
      <span class="env role-${role}">${r.label}</span>
    </div></header>`,
  );
}

// Claimant-facing statuses (never the fraud signals)
export const claimantBadge = (s) => {
  const cls = { Paid: 'paid', Declined: 'rejected' }[s] || 'review';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
};
