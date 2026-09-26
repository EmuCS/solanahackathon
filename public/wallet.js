// Phantom / Solflare through the providers they inject: the browser extension on desktop, or the
// wallet app's own browser on phones (Safari can't reach wallet apps, so we open the page there).
// Wallets only sign messages here; payments are settled by the insurer's treasury.
import { b58, esc, short, signWithDevice, post } from '/device.js';

export const WALLETS = {
  Phantom: {
    get: () => (window.phantom?.solana?.isPhantom ? window.phantom.solana : null),
    browse: (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`,
    install: 'https://phantom.com/download',
  },
  Solflare: {
    get: () => (window.solflare?.isSolflare ? window.solflare : null),
    browse: (url) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`,
    install: 'https://solflare.com/download',
  },
};
export const available = () => Object.keys(WALLETS).filter((n) => WALLETS[n].get());
// iPadOS Safari reports a Mac user agent; a touch screen gives it away
export const isMobile = () =>
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 0);

export async function connect(name, opts) {
  const p = WALLETS[name]?.get();
  if (!p) throw new Error(`${name} is not available in this browser`);
  const r = await p.connect(opts);
  const pk = r?.publicKey || p.publicKey;
  if (!pk) throw new Error(`${name} did not share an address`);
  return { name, provider: p, address: pk.toString() };
}

export async function signText(w, text) {
  const r = await w.provider.signMessage(new TextEncoder().encode(text), 'utf8');
  return b58(new Uint8Array(r?.signature || r));
}

// Claimant: which wallet receives this device's claim payments.
// compact: status + "Change" link to the profile; full (profile page): connect / switch / disconnect.
// onAddress(address) fires with the current payout address (linked wallet or the device key).
export function mountPayoutWallet(el, me, onAddress = () => {}, { compact = false } = {}) {
  let link = null;
  let poll = null;
  let pending = null; // phone: { name, href, url } while the claimant finishes in the wallet app

  async function refresh() {
    const prev = link?.wallet;
    link = (await fetch(`/api/link/${me}`).then((r) => r.json())).link;
    onAddress(link?.wallet || me);
    if (link?.wallet !== prev) pending = null;
    if (!pending) {
      clearInterval(poll);
      poll = null;
    }
    render();
  }

  function render(msg = '') {
    const status = `
      <p class="muted small" style="margin:0">Claim payments go to</p>
      <p style="margin:4px 0 0"><b>${link ? `${esc(link.walletName)} wallet` : 'This device’s built-in wallet'}</b>
        <span class="mono muted">${esc(short(link?.wallet || me))}</span>
        ${link ? ` · <a href="${esc(link.explorer)}" target="_blank" rel="noopener">record</a>` : ''}
        ${compact ? ` · <a href="/profile.html">Change</a>` : ''}</p>`;
    if (compact) return (el.innerHTML = status);

    const buttons = Object.keys(WALLETS)
      .filter((n) => n !== link?.walletName)
      .map((n) => `<button class="btn secondary" type="button" data-w="${n}">${link ? `Switch to ${n}` : `Connect ${n}`}</button>`)
      .join('');
    el.innerHTML = `${status}
      ${link ? '' : '<p class="muted small" style="margin:6px 0 0">Connect Phantom or Solflare to receive payments in your own wallet.</p>'}
      <div class="row" style="margin-top:12px">${buttons}${link ? '<button class="btn danger" type="button" id="unlink">Disconnect wallet</button>' : ''}</div>
      ${pending ? `<div class="notice" style="margin-top:12px">
          <p style="margin:0 0 10px"><b>Finish in ${esc(pending.name)}</b>: tap below, approve the message there, then come back here.</p>
          <a class="btn" href="${esc(pending.href)}">Open in ${esc(pending.name)}</a>
          <p class="small" style="margin:12px 0 6px">Nothing happens? Copy the link, open the ${esc(pending.name)} app, tap its browser (search) tab and paste it.</p>
          <button class="btn secondary" type="button" id="copyLink">Copy link</button>
        </div>` : ''}
      <p class="small muted" data-msg style="margin:8px 0 0">${msg}</p>`;
    el.querySelectorAll('button[data-w]').forEach((b) => (b.onclick = () => start(b.dataset.w)));
    if (el.querySelector('#unlink')) el.querySelector('#unlink').onclick = unlink;
    if (el.querySelector('#copyLink')) {
      el.querySelector('#copyLink').onclick = async () => {
        try {
          await navigator.clipboard.writeText(pending.url);
          el.querySelector('[data-msg]').textContent = 'Link copied. Paste it in the wallet app’s browser.';
        } catch {
          el.querySelector('[data-msg]').textContent = pending.url;
        }
      };
    }
  }

  async function start(name) {
    const say = (m) => (el.querySelector('[data-msg]').innerHTML = m);
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const { token, message, url } = await post('/api/link/start', { device: me, ts, signature: signWithDevice(`fraudbusters:link-start:v1:${me}:${ts}`) });
      if (WALLETS[name].get()) {
        say(`Approve the message in ${esc(name)}…`);
        const w = await connect(name);
        await post('/api/link/finish', { device: me, token, wallet: w.address, walletName: name, signature: await signText(w, message) });
        return refresh();
      }
      if (!isMobile()) return say(`${esc(name)} is not installed in this browser. <a href="${WALLETS[name].install}" target="_blank" rel="noopener">Get ${esc(name)}</a>`);
      // Phone: iOS only opens another app from a link the user taps, so show one (plus a copyable URL)
      const full = new URL(url, location.origin).href;
      pending = { name, url: full, href: WALLETS[name].browse(full) };
      clearInterval(poll);
      poll = setInterval(refresh, 3000);
      render();
    } catch (e) {
      say(esc(e.message || String(e)));
    }
  }

  async function unlink() {
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      await post('/api/link/unlink', { device: me, ts, signature: signWithDevice(`fraudbusters:unlink:v1:${me}:${ts}`) });
      await refresh();
    } catch (e) {
      render(esc(e.message || String(e)));
    }
  }

  render();
  refresh();
  document.addEventListener('visibilitychange', () => !document.hidden && refresh());
}

// Adjuster: the wallet that signs decisions, remembered per browser. onChange(wallet | null).
const ADJ_KEY = 'fraudbusters.adjuster.wallet';
export async function mountAdjusterWallet(el, onChange = () => {}) {
  let adj = null;
  const set = (w) => {
    adj = w;
    onChange(adj);
    render();
  };
  function render(msg = '') {
    if (adj) {
      el.innerHTML = `<span class="small">Signing as <b>${esc(adj.name)}</b> <span class="mono muted">${esc(short(adj.address))}</span></span>
        <a href="#" class="small" data-off>Disconnect</a>`;
      el.querySelector('[data-off]').onclick = (e) => {
        e.preventDefault();
        adj.provider.disconnect?.();
        try { localStorage.removeItem(ADJ_KEY); } catch {}
        set(null);
      };
      return;
    }
    el.innerHTML = `<span class="small muted">Sign decisions with your wallet</span>
      ${Object.keys(WALLETS).map((n) => `<button class="btn secondary" type="button" data-w="${n}">Connect ${n}</button>`).join('')}
      ${msg ? `<div class="small muted" style="flex-basis:100%">${msg}</div>` : ''}`;
    el.querySelectorAll('button[data-w]').forEach((b) => (b.onclick = async () => {
      const n = b.dataset.w;
      if (!WALLETS[n].get()) return render(`${esc(n)} is not installed in this browser. <a href="${WALLETS[n].install}" target="_blank" rel="noopener">Get ${esc(n)}</a>`);
      try {
        const w = await connect(n);
        try { localStorage.setItem(ADJ_KEY, n); } catch {}
        set(w);
      } catch (e) {
        render(esc(e.message || String(e)));
      }
    }));
  }
  // Reconnect silently if this browser already trusts the site
  try {
    const n = localStorage.getItem(ADJ_KEY);
    if (n && WALLETS[n]?.get()) adj = await connect(n, { onlyIfTrusted: true }).catch(() => null);
  } catch {}
  onChange(adj);
  render();
  return () => adj;
}
