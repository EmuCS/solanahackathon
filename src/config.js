import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const IMG_DIR = path.join(DATA_DIR, 'img');
export const KEYS_DIR = path.join(ROOT, 'keys');

export const PORT = Number(process.env.PORT || 3000);
export const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
export const CLUSTER = process.env.CLUSTER || 'devnet';

// Pay.sh gateway that sits in front of POST /v1/verify (see paywall.yml)
export const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:1402';
export const PAY_SANDBOX = process.env.PAY_SANDBOX !== 'false';
export const PAY_BIN =
  process.env.PAY_BIN ||
  path.join(ROOT, 'node_modules', '@solana', 'pay', 'bin', process.platform === 'win32' ? 'pay.exe' : 'pay');

// Google Cloud Vision via Pay.sh catalog (solana-foundation/google/vision) — mainnet only
export const VISION_URL = process.env.VISION_URL || 'https://vision.google.gateway-402.com';
export const VISION_SANDBOX = process.env.VISION_SANDBOX === 'true';

export const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
export const CERT_DIR = path.join(ROOT, 'certs');
export const ORIG_DIR = path.join(DATA_DIR, 'originals');

// Capture must be signed within this many seconds of a server-issued challenge
export const CHALLENGE_TTL_S = Number(process.env.CHALLENGE_TTL_S || 120);

// Max differing bits (of 64) for two images to count as "the same photo"
export const MATCH_THRESHOLD = Number(process.env.MATCH_THRESHOLD || 10);

// Memo prefixes — the on-chain record format
export const MEMO_PHOTO = 'fraudbusters:photo:v1';
export const MEMO_CLAIM = 'fraudbusters:claim:v1';
export const MEMO_LINK = 'fraudbusters:link:v1';

// Written by `npm run setup`, per RPC (devnet vs sandbox have different mints);
// PAYOUT_MINT env overrides (e.g. Circle devnet USDC / EURC)
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
function readAll() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function runtimeConfig() {
  const saved = readAll()[RPC_URL] || {};
  return {
    payoutMint: process.env.PAYOUT_MINT || saved.payoutMint || null,
    payoutSymbol: process.env.PAYOUT_SYMBOL || saved.payoutSymbol || 'tUSDC',
  };
}

export function saveRuntimeConfig(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const all = readAll();
  all[RPC_URL] = { ...all[RPC_URL], ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(all, null, 2));
}
