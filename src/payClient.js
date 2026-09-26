// The insurer's claims agent buys services per request through Pay.sh with the `pay` CLI
// (HTTP 402 → wallet signs → retry): our own verifier, and Google Cloud Vision reverse search.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PAY_BIN, PAY_SANDBOX, GATEWAY_URL, VISION_URL, VISION_SANDBOX } from './config.js';

function runPay(args, cwd, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(PAY_BIN, args, { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');

// `curl -i` output → final response's headers + body
function parseHttp(raw) {
  const blocks = raw.split(/\r?\n\r?\n/);
  let i = blocks.length - 1;
  while (i > 0 && !/^HTTP\//.test(blocks[i - 1])) i--;
  const head = i > 0 ? blocks[i - 1] : '';
  const body = blocks.slice(i).join('\n\n');
  const headers = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const k = line.indexOf(':');
    if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
  }
  return { status: Number(head.split(' ')[1]) || 0, headers, body };
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fraudbusters-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

export function paidVerify(imageBuf) {
  return withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'photo.jpg'), imageBuf);
    const started = Date.now();
    // `pay curl -i` exposes the receipt headers but needs curl on PATH (pay can't find it when the
    // server is launched from PowerShell). `pay fetch` is built in; used as the fallback.
    let { code, stdout, stderr } = await runPay(
      [...(PAY_SANDBOX ? ['--sandbox'] : []), 'curl', '-s', '-i', '-F', 'image=@photo.jpg', `${GATEWAY_URL}/v1/verify`],
      dir,
    );
    let parsed = parseHttp(stripAnsi(stdout));
    if (/Command not found: curl/.test(stdout + stderr)) {
      ({ code, stdout, stderr } = await runPay(
        [...(PAY_SANDBOX ? ['--sandbox'] : []), 'fetch', '-X', 'POST', '--form-file', 'image=photo.jpg', `${GATEWAY_URL}/v1/verify`],
        dir,
      ));
      parsed = { status: code === 0 ? 200 : 0, headers: {}, body: stripAnsi(stdout).trim().split(/\r?\n/).pop() };
    }
    const { status, headers, body } = parsed;
    let result;
    try {
      result = JSON.parse(body);
    } catch {}
    if (code !== 0 || status !== 200 || !result || !('verified' in result)) {
      throw new Error(`Pay.sh verify failed (exit ${code}, HTTP ${status}): ${stripAnsi(stderr || body).slice(0, 400)}`);
    }
    let receipt = null;
    try {
      receipt = JSON.parse(Buffer.from(headers['payment-receipt'], 'base64').toString('utf8'));
    } catch {}
    return {
      result,
      payment: {
        service: 'FraudBusters registry check',
        price: '$0.01',
        receiptUrl: headers['payment-receipt-url'] || null,
        reference: receipt?.reference || null,
        network: PAY_SANDBOX ? 'sandbox' : 'mainnet',
        ms: Date.now() - started,
      },
    };
  });
}

// Google Cloud Vision WEB_DETECTION through Pay.sh — "has this image been online before?"
export function reverseImageSearch(imageBuf) {
  // Opt-in: each search is a real mainnet payment that needs a local approval (slow for live demos)
  if (process.env.REVERSE_SEARCH !== 'on') return Promise.resolve({ ran: false, reason: 'switched off for this demo (set REVERSE_SEARCH=on)' });
  return withTempDir(async (dir) => {
    const small = await sharp(imageBuf).rotate().resize(800, 800, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
    const body = { requests: [{ image: { content: small.toString('base64') }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }] }] };
    fs.writeFileSync(path.join(dir, 'body.json'), JSON.stringify(body));
    const started = Date.now();
    const args = [
      ...(VISION_SANDBOX ? ['--sandbox'] : []),
      'fetch', '-X', 'POST', '--body-file', 'body.json', '--content-type', 'application/json',
      `${VISION_URL}/v1/images:annotate`,
    ];
    let res;
    try {
      res = await runPay(args, dir, 90000); // time for the human to approve the real payment
    } catch (e) {
      return { ran: false, reason: e.message };
    }
    const lastJson = (s) => {
      try {
        return JSON.parse(stripAnsi(s).trim().split(/\r?\n/).pop());
      } catch {
        return null;
      }
    };
    const json = lastJson(res.stdout);
    const wd = json?.responses?.[0]?.webDetection;
    if (res.code !== 0 || !json || json.error || !json.responses) {
      const err = json?.error || lastJson(res.stderr)?.error;
      let msg = err?.message || stripAnsi(res.stderr || res.stdout).trim() || `exit ${res.code}`;
      if (/No account configured for network `mainnet`/.test(msg)) msg = 'no Pay.sh mainnet account yet (run `pay setup --redeem <code>`)';
      return { ran: false, reason: msg.split('\n')[0].slice(0, 200) };
    }
    return {
      ran: true,
      fullMatches: wd?.fullMatchingImages?.length || 0,
      partialMatches: wd?.partialMatchingImages?.length || 0,
      pages: (wd?.pagesWithMatchingImages || []).slice(0, 5).map((p) => ({ url: p.url, title: p.pageTitle?.replace(/<[^>]+>/g, '') || p.url })),
      bestGuess: wd?.bestGuessLabels?.[0]?.label || null,
      payment: { service: 'Google Cloud Vision (web detection)', price: '$0.0015', network: VISION_SANDBOX ? 'sandbox' : 'mainnet', ms: Date.now() - started },
    };
  });
}
