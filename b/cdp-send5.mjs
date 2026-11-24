import fs from 'node:fs';
const mode = process.argv[2];           // 'new' | 'existing'
const titleFile = process.argv[3];      // existing 时的会话标题文件
const promptFile = process.argv[4];
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) { console.log(JSON.stringify({ ok: false, error: 'no page' })); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 10000); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await new Promise((r) => (ws.onopen = r));
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) return 'EX:' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text); return r.result && r.result.value; };
const prompt = fs.readFileSync(promptFile, 'utf8').trim();
let ok = false;
if (mode === 'existing') {
  const title = fs.readFileSync(titleFile, 'utf8').trim();
  await ev('window.__bt=' + JSON.stringify(title) + '; 1');
  const found = await ev("(() => { const bs = [...document.querySelectorAll('[role=button]')].filter(b => (b.innerText || '').includes(window.__bt)); if (!bs.length) return 'no-session'; bs[0].click(); return 'clicked'; })()");
  console.log('session:', found);
  ok = found === 'clicked';
  await new Promise((r) => setTimeout(r, 2000));
} else {
  await ev("(() => { const b = [...document.querySelectorAll('[role=tab],[role=button]')].find(x => (x.innerText||'').trim().startsWith('新建任务')); if (b) b.click(); return 1; })()");
  await new Promise((r) => setTimeout(r, 1500));
  ok = true;
}
await ev("(() => { const ed = [...document.querySelectorAll('[contenteditable]')].find(e => e.isContentEditable); if (ed) ed.focus(); return 1; })()");
await send('Input.insertText', { text: prompt });
await new Promise((r) => setTimeout(r, 700));
const sendRes = await ev("(() => { const b = document.querySelector('[aria-label=\"发送\"]'); if (!b) return 'no-send'; b.click(); return 'sent'; })()");
await new Promise((r) => setTimeout(r, 2500));
const left = await ev("(() => { const ed = [...document.querySelectorAll('[contenteditable]')].find(e => e.isContentEditable); return ed ? ed.innerText.length : -1; })()");
console.log(JSON.stringify({ ok: ok && sendRes === 'sent', mode, send: sendRes, leftChars: left }));
ws.close();