// Rebuild the local index purely from Solana: the registry is the chain, the index is a cache.
// Reads every memo written by the service + treasury wallets and re-creates photos/claims.
import { connection, loadKeypair, MEMO_PROGRAM_ID } from '../src/solana.js';
import { MEMO_PHOTO, MEMO_CLAIM } from '../src/config.js';
import { photos, claims } from '../src/store.js';

async function memosFor(address) {
  const out = [];
  let before;
  for (;;) {
    const sigs = await connection.getSignaturesForAddress(address, { before, limit: 1000 });
    if (!sigs.length) break;
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      for (const ix of tx?.transaction.message.instructions || []) {
        if (ix.programId.equals(MEMO_PROGRAM_ID) && typeof ix.parsed === 'string') {
          out.push({ memo: ix.parsed, tx: s.signature, at: new Date((s.blockTime || 0) * 1000).toISOString() });
        }
      }
    }
    before = sigs.at(-1).signature;
  }
  return out;
}

const local = new Map(photos.all().map((p) => [p.tx, p]));
const localClaims = new Map(claims.all().map((c) => [c.tx, c]));
const all = [...(await memosFor(loadKeypair('service').publicKey)), ...(await memosFor(loadKeypair('treasury').publicKey))];

const rebuiltPhotos = [];
const rebuiltClaims = [];
for (const { memo, tx, at } of all.sort((a, b) => a.at.localeCompare(b.at))) {
  const parts = memo.split('|');
  if (parts[0] === MEMO_PHOTO) {
    const [, dhash, sha512, pubkey, signature] = parts;
    const prev = local.get(tx);
    rebuiltPhotos.push({ id: prev?.id || tx.slice(0, 12), dhash, sha512, pubkey, signature, tx, createdAt: prev?.createdAt || at });
  } else if (parts[0] === MEMO_CLAIM) {
    const [, dhash, insurer, id, status, photoId, amount, claimant] = parts;
    const prev = localClaims.get(tx) || {};
    rebuiltClaims.push({
      ...prev,
      id,
      insurer,
      dhash,
      status,
      photoId: photoId === '-' ? null : photoId,
      amount: Number(amount) || prev.amount || 0,
      claimant: claimant || prev.claimant || '',
      tx,
      createdAt: prev.createdAt || at,
    });
  }
}

photos.replaceAll(rebuiltPhotos);
claims.replaceAll(rebuiltClaims);
console.log(`Rebuilt from chain: ${rebuiltPhotos.length} photos, ${rebuiltClaims.length} claims`);
