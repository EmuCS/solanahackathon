// Local index for fast lookup. It is a cache: every record is also a memo on Solana
// and can be rebuilt with `npm run reindex`.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, MATCH_THRESHOLD } from './config.js';
import { hamming } from './phash.js';

const file = (name) => path.join(DATA_DIR, `${name}.json`);

function load(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return [];
  }
}

function save(name, rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify(rows, null, 2));
}

function table(name) {
  return {
    all: () => load(name),
    add(row) {
      const rows = load(name);
      rows.push(row);
      save(name, rows);
      return row;
    },
    update(id, patch) {
      const rows = load(name);
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return null;
      rows[i] = { ...rows[i], ...patch };
      save(name, rows);
      return rows[i];
    },
    replaceAll: (rows) => save(name, rows),
  };
}

export const photos = table('photos');
export const claims = table('claims');
// Device key → external wallet (Phantom / Solflare) that receives the claimant's payouts
export const links = table('links');

export function findPhoto(dh) {
  let best = null;
  for (const p of photos.all()) {
    const d = hamming(dh, p.dhash);
    if (d <= MATCH_THRESHOLD && (!best || d < best.distance)) best = { photo: p, distance: d };
  }
  return best;
}

// Same claim photo = same on-chain capture record, or a near-identical fingerprint.
// Merely similar images (e.g. a re-shoot of the same dent) are returned separately as a warning.
// Claims made with a guided set match on any of their three shots.
export const SAME_THRESHOLD = 4;
export function findClaims(dh, photoId) {
  const same = [];
  const similar = [];
  for (const c of claims.all()) {
    const d = Math.min(...[c.dhash, ...(c.shotHashes || [])].map((h) => hamming(dh, h)));
    if ((photoId && (c.photoId === photoId || c.shotIds?.includes(photoId))) || d <= SAME_THRESHOLD) same.push(c);
    else if (d <= MATCH_THRESHOLD && !(photoId && c.photoId)) similar.push(c);
  }
  return { same, similar };
}
