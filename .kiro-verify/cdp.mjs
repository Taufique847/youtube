// Temporary verification harness (deleted after testing).
// Drives an already-running headless Chrome over the DevTools protocol.
// Usage: node cdp.mjs <step> <step> ...
//   nav:<url>  click:<id>  wait:<ms>  select:<id>=<value>  type:<id>=<text with \n>
//   state  shot:<file.png>  frames  close
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageWsUrl() {
  for (let i = 0; i < 75; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('No CDP page target found');
}

const ws = new WebSocket(await pageWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
const events = [];
const consoleMsgs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (!msg.method) return;
  events.push(msg);
  const p = msg.params || {};
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleMsgs.push(`[console.${p.type}] ` + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push(`[exception] ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`);
  } else if (msg.method === 'Log.entryAdded') {
    consoleMsgs.push(`[log.${p.entry.level}] ${p.entry.text} ${p.entry.url || ''}`);
  }
};

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const STATE_JS = `(() => ({
  protocol: location.protocol,
  status: document.getElementById('status')?.textContent,
  playing: document.getElementById('playingCount')?.textContent,
  total: document.getElementById('totalTime')?.textContent,
  banner: (document.getElementById('fileWarning') && getComputedStyle(document.getElementById('fileWarning')).display !== 'none') ? 'visible' : 'hidden/absent',
  boxes: [...document.querySelectorAll('.video-box')].filter(b => getComputedStyle(b).display !== 'none').map(b => ({
    cls: b.className,
    size: Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height),
    status: b.querySelector('.box-status')?.textContent,
    time: b.querySelector('[id^=time-]')?.textContent,
    vid: b.querySelector('[id^=vid-]')?.textContent,
    iframe: b.querySelector('iframe') ? b.querySelector('iframe').src.split('?')[0] : null,
    note: b.querySelector('.box-msg')?.textContent || null
  })),
  hiddenIframes: [...document.querySelectorAll('.video-box')].filter(b => getComputedStyle(b).display === 'none' && b.querySelector('iframe')).length,
  log: [...document.querySelectorAll('#debugLog > div')].map(d => d.className + ': ' + d.textContent)
}))()`;

// Reads the YouTube error text shown inside each player iframe (cross-origin).
async function frameTexts() {
  const { targetInfos } = await send('Target.getTargets');
  const out = [];
  for (const t of targetInfos.filter((x) => x.type === 'iframe')) {
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await send('Runtime.evaluate', {
        expression: `(() => { const e = document.querySelector('.ytp-error'); const v = document.querySelector('video');
          return { error: e ? e.innerText.replace(/\\s+/g,' ').trim() : null, videoPaused: v ? v.paused : null, currentTime: v ? Math.round(v.currentTime) : null }; })()`,
        returnByValue: true,
      }, sessionId);
      out.push({ url: t.url.split('?')[0], ...r.result.value });
      await send('Target.detachFromTarget', { sessionId });
    } catch (e) {
      out.push({ url: t.url, err: String(e.message || e) });
    }
  }
  return out;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false });

for (const step of process.argv.slice(2)) {
  const i = step.indexOf(':');
  const cmd = i === -1 ? step : step.slice(0, i);
  const arg = i === -1 ? '' : step.slice(i + 1);
  if (cmd === 'nav') {
    const before = events.length;
    await send('Page.navigate', { url: arg });
    while (!events.slice(before).some((e) => e.method === 'Page.loadEventFired')) await sleep(100);
    console.log(`> nav ${arg}`);
  } else if (cmd === 'click') {
    await evaluate(`document.getElementById(${JSON.stringify(arg)}).click()`);
    console.log(`> click ${arg}`);
  } else if (cmd === 'wait') {
    await sleep(Number(arg));
    console.log(`> wait ${arg}ms`);
  } else if (cmd === 'select') {
    const [id, value] = arg.split('=');
    await evaluate(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
    console.log(`> select ${id}=${value}`);
  } else if (cmd === 'type') {
    const eq = arg.indexOf('=');
    const id = arg.slice(0, eq);
    const text = arg.slice(eq + 1).replace(/\\n/g, '\n');
    await evaluate(`(() => { const t = document.getElementById(${JSON.stringify(id)}); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
    console.log(`> type ${id}`);
  } else if (cmd === 'state') {
    console.log('> state ' + JSON.stringify(await evaluate(STATE_JS), null, 2));
  } else if (cmd === 'frames') {
    console.log('> frames ' + JSON.stringify(await frameTexts(), null, 2));
  } else if (cmd === 'shot') {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(arg, Buffer.from(shot.data, 'base64'));
    console.log(`> shot ${arg}`);
  } else if (cmd === 'close') {
    try { await send('Browser.close'); } catch {}
  }
}

console.log('> console/errors:\n' + (consoleMsgs.join('\n') || '(none)'));
ws.close();
process.exit(0);
