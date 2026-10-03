/* =====================================================================
 * verify/proto-shots.mjs — PROTOTYPE 用証跡撮影（issue #15 / 捨て分支専用）
 * Edge headless + 生 CDP（ゼロ依存・Node24 内蔵 WebSocket）で
 * src/prototype-dark.html の 変体 A/B/C（拍 12 で凍結）と 配置ページ示意
 * の 4 枚を .cross-review/issue-15/shots/ へ出力する。
 * 使い方:  node verify/proto-shots.mjs   （MSEDGE_PATH で Edge 経路を上書き可）
 * 注意:    コンソールは cp932 のため ASCII のみ出力する。
 * ===================================================================== */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE_URL = pathToFileURL(join(ROOT, 'src', 'prototype-dark.html')).href;
const OUT_DIR = join(ROOT, '.cross-review', 'issue-15', 'shots');
const EDGE = process.env.MSEDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });

let PORT = 9333;
async function pickPort() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(800) });
    PORT = 9343;
  } catch { /* 未使用ならそのまま */ }
}
async function findPageTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
      lastErr = 'no page target';
    } catch (e) { lastErr = String((e && e.message) || e); }
    await sleep(300);
  }
  throw new Error('devtools endpoint not reachable: ' + lastErr);
}
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP timeout: ' + method)); }, 30000);
            pending.set(id, (msg) => {
              clearTimeout(timer);
              if (msg.error) rej(new Error('CDP error ' + method + ': ' + JSON.stringify(msg.error)));
              else res(msg.result);
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { try { ws.close(); } catch { /* ignore */ } }
      });
    });
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) { const fn = pending.get(msg.id); pending.delete(msg.id); fn(msg); }
    });
    ws.addEventListener('error', () => reject(new Error('websocket error')));
  });
}
async function evalJS(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  }
  return r.result.value;
}

let proc = null, userDataDir = null, cdp = null;
function cleanup() {
  try { if (cdp) cdp.close(); } catch { /* ignore */ }
  try { if (proc && proc.pid) execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function shot(cdp, name) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(260);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = join(OUT_DIR, name + '.png');
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('shot: ' + p);
}

async function main() {
  await pickPort();
  userDataDir = mkdtempSync(join(tmpdir(), 'edge-proto-'));
  proc = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
    '--window-size=1920,1080', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-gpu', 'about:blank'
  ], { stdio: 'ignore' });
  proc.on('error', (err) => { console.error('EDGE_LAUNCH_FAILED: ' + String(err.message)); process.exit(2); });

  const target = await findPageTarget(30000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable').catch(() => {});
  await cdp.send('Page.navigate', { url: PAGE_URL });
  await sleep(1200);

  const ready = await evalJS(cdp, '!!window.__protoState && !!window.__protoGoto');
  if (!ready) throw new Error('prototype page not ready (hooks missing)');

  // 変体 A/B/C：拍 12（初の倒地直後）で凍結して撮影
  for (const v of ['A', 'B', 'C']) {
    await evalJS(cdp, `location.hash = 'variant=${v}'`);
    await sleep(350);
    await evalJS(cdp, 'window.__protoGoto(12)');
    await sleep(500);
    const st = await evalJS(cdp, 'JSON.stringify(window.__protoState)');
    if (!st) throw new Error('state hook missing at variant ' + v);
    await shot(cdp, v);
  }
  // 配置ページ示意（変体 B のアクセントで）
  await evalJS(cdp, "location.hash = 'variant=B&view=config'");
  await sleep(450);
  await shot(cdp, 'config');

  console.log('DONE 4 shots -> ' + OUT_DIR);
  return 0;
}

try {
  const code = await main();
  cleanup();
  process.exit(code);
} catch (e) {
  console.error('FATAL: ' + String((e && e.message) || e));
  cleanup();
  process.exit(2);
}
