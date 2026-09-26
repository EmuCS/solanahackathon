import fs from 'node:fs';
import path from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { RPC_URL, CLUSTER, KEYS_DIR } from './config.js';

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const connection = new Connection(RPC_URL, 'confirmed');

export function keyPath(name) {
  return path.join(KEYS_DIR, `${name}.json`);
}

export function loadKeypair(name) {
  const raw = JSON.parse(fs.readFileSync(keyPath(name), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function loadOrCreateKeypair(name) {
  if (fs.existsSync(keyPath(name))) return loadKeypair(name);
  const kp = Keypair.generate();
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(keyPath(name), JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

export function memoIx(text) {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') });
}

export async function writeMemo(payer, text) {
  const tx = new Transaction().add(memoIx(text));
  return sendAndConfirmTransaction(connection, tx, [payer]);
}

// Stablecoin transfer + claim memo in one atomic transaction
export async function payout({ treasury, mint, to, amount, memo }) {
  const mintInfo = await getMint(connection, mint);
  const fromAta = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  const toAta = getAssociatedTokenAddressSync(mint, to);
  const raw = BigInt(Math.round(amount * 10 ** mintInfo.decimals));
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(treasury.publicKey, toAta, to, mint),
    createTransferCheckedInstruction(fromAta, mint, toAta, treasury.publicKey, raw, mintInfo.decimals),
    memoIx(memo),
  );
  return sendAndConfirmTransaction(connection, tx, [treasury]);
}

const clusterQuery = CLUSTER === 'custom' ? `cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}` : `cluster=${CLUSTER}`;
export const explorerTx = (sig) => `https://explorer.solana.com/tx/${sig}?${clusterQuery}`;
export const explorerAddr = (addr) => `https://explorer.solana.com/address/${addr}?${clusterQuery}`;
