#!/usr/bin/env node
// 本机端到端自测：bridge(假 CLI) + MCP 工具，全链路断言
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');
const TMP = '/tmp/buddy-link-e2e';
const PORT = 18765;
const TOKEN = 'test-token-0123456789';
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  ' + detail : '')); };

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'work'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'bin'), { recursive: true });
const wrapper = path.join(TMP, 'bin', 'fake-codebuddy');
fs.writeFileSync(wrapper, '#!/bin/sh\nexec node "' + path.join(ROOT, 'test', 'fake-codebuddy.mjs') + '" "$@"\n');
fs.chmodSync(wrapper, 0o755);

const bridge = spawn(process.execPath, [path.join(ROOT, 'b', 'bridge.mjs')], {
  env: {
    ...process.env,
    BUDDY_TOKEN: TOKEN,
    BUDDY_PORT: String(PORT),
    BUDDY_HOST: '127.0.0.1',
    BUDDY_WORKDIR: path.join(TMP, 'work'),
    BUDDY_CLI: wrapper,
    BUDDY_PROMPT_VIA: 'arg',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bridgeLog = '';
bridge.stdout.on('data', (d) => (bridgeLog += d));
bridge.stderr.on('data', (d) => (bridgeLog += d));

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/health');
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const health = await waitHealth();
check('bridge /health 可达', !!health, health ? JSON.stringify(health).slice(0, 120) : bridgeLog.slice(-300));

if (health) {
  const unauth = await fetch('http://127.0.0.1:' + PORT + '/runs');
  check('无 token 被拒 401', unauth.status === 401, 'status=' + unauth.status);

  const res = await fetch('http://127.0.0.1:' + PORT + '/run', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '测试指令：生成 report.md', permissionMode: 'acceptEdits' }),
  });
  check('POST /run 返回 SSE', (res.headers.get('content-type') || '').includes('text/event-stream'));
  const raw = await res.text();
  const events = raw.split('\n\n').filter((b) => b.includes('data:')).map((b) => {
    const line = b.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse(line.slice(5).trim());
  });
  const kinds = events.map((e) => e.type);
  check('事件序列含 accepted/delta/done', kinds.includes('accepted') && kinds.includes('delta') && kinds.includes('done'), kinds.join(','));
  const done = events.find((e) => e.type === 'done');
  check('done 文本为最终结果', !!done && String(done.text).includes('最终：已完成'), done ? String(done.text).slice(0, 60) : '');
  check('done 带 sessionId', !!done && !!done.sessionId, done?.sessionId);
  check('执行退出码为 0', !!done && done.code === 0, 'code=' + (done && done.code));

  const fileRes = await fetch('http://127.0.0.1:' + PORT + '/file?path=report.md', { headers: { authorization: 'Bearer ' + TOKEN } });
  const fileText = await fileRes.text();
  check('/file 能取回 B 端产物', fileRes.ok && fileText.includes('fake report'), 'status=' + fileRes.status);

  const outside = await fetch('http://127.0.0.1:' + PORT + '/file?path=/etc/passwd', { headers: { authorization: 'Bearer ' + TOKEN } });
  check('/file 越界被拒', outside.status === 403, 'status=' + outside.status);

  // ---- MCP 工具 ----
  const mcp = spawn(process.execPath, [path.join(ROOT, 'a', 'remote-buddy.mjs')], {
    env: {
      ...process.env,
      BUDDY_URL: 'http://127.0.0.1:' + PORT,
      BUDDY_TOKEN: TOKEN,
      BUDDY_STATE: path.join(TMP, 'state.json'),
      BUDDY_INBOX: path.join(TMP, 'inbox'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rl = readline.createInterface({ input: mcp.stdout });
  const pending = new Map();
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch {}
  });
  let nextId = 1;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
  });

  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  check('MCP initialize', init?.result?.serverInfo?.name === 'buddy-link', JSON.stringify(init?.result?.serverInfo));
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await call('tools/list', {});
  const names = (list?.result?.tools || []).map((t) => t.name);
  check('MCP 暴露核心工具', ['buddy_ping','buddy_run','buddy_auto','buddy_ui','buddy_get','buddy_cancel'].every((n) => names.includes(n)), names.join(','));

  const ping = await call('tools/call', { name: 'buddy_ping', arguments: {} });
  check('buddy_ping 可用', String(ping?.result?.content?.[0]?.text || '').includes('B 在线'));

  const run = await call('tools/call', { name: 'buddy_run', arguments: { prompt: '第二条：再生成一次', canvas: 'e2e' } });
  const runText = String(run?.result?.content?.[0]?.text || '');
  check('buddy_run 返回结果', runText.includes('[B 执行完成]') && runText.includes('最终：已完成'), runText.slice(0, 80));
  check('canvas 记住 sessionId', !!JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8')).canvases?.e2e?.sessionId);

  const cont = await call('tools/call', { name: 'buddy_run', arguments: { prompt: '第三条', canvas: 'e2e' } });
  const s1 = (runText.match(/sessionId=(\S+)/) || [])[1];
  const s2 = (String(cont?.result?.content?.[0]?.text || '').match(/sessionId=(\S+)/) || [])[1];
  check('多轮续接同一 session', !!s1 && s1 === s2, s1 + ' vs ' + s2);

  const get = await call('tools/call', { name: 'buddy_get', arguments: { path: 'report.md' } });
  const inboxFile = path.join(TMP, 'inbox', 'report.md');
  check('buddy_get 拉回文件', fs.existsSync(inboxFile) && fs.readFileSync(inboxFile, 'utf8').includes('fake report'), String(get?.result?.content?.[0]?.text || '').slice(0, 80));

  mcp.kill();
}

bridge.kill();
const failed = results.filter((r) => !r.ok);
console.log('');
console.log('通过 ' + (results.length - failed.length) + '/' + results.length);
if (failed.length) { console.log('失败项：' + failed.map((f) => f.name).join(', ')); process.exit(1); }
process.exit(0);