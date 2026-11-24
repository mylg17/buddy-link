#!/usr/bin/env node
// 真机 MCP 冒烟：以 WorkBuddy 的方式拉起 remote-buddy.mjs，走完 initialize → tools → buddy_run
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const env = {
  ...process.env,
  BUDDY_URL: 'http://192.168.1.10:8765',
  BUDDY_TOKEN: process.argv[2],
  BUDDY_STATE: '/tmp/buddy-live-state.json',
  BUDDY_INBOX: '/tmp/buddy-live-inbox',
};
const child = spawn(process.execPath, [new URL('../a/remote-buddy.mjs', import.meta.url).pathname], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
rl.on('line', (l) => { try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} });
let id = 1;
const call = (method, params) => new Promise((res, rej) => {
  const n = id++; pending.set(n, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  setTimeout(() => { if (pending.has(n)) { pending.delete(n); rej(new Error('timeout ' + method)); } }, 180000);
});
const ok = (name, cond, extra) => console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + String(extra).slice(0, 120) : ''));

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live', version: '1' } });
ok('MCP initialize', init?.result?.serverInfo?.name === 'buddy-link');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const ping = await call('tools/call', { name: 'buddy_ping', arguments: {} });
ok('buddy_ping 真机', String(ping?.result?.content?.[0]?.text || '').includes('B 在线'), ping?.result?.content?.[0]?.text?.slice(0, 80));

const run = await call('tools/call', { name: 'buddy_run', arguments: { prompt: '用 PowerShell 在 C:\\buddy-link\\work 下创建 hello.txt，内容写 BuddyLink OK，然后回复完成', canvas: 'live' } });
const text = String(run?.result?.content?.[0]?.text || '');
ok('buddy_run 真机', text.includes('[B 执行完成]'), text.slice(0, 120));

const get = await call('tools/call', { name: 'buddy_get', arguments: { path: 'hello.txt', destName: 'hello-from-B.txt' } });
ok('buddy_get 拉回 hello.txt', String(get?.result?.content?.[0]?.text || '').includes('hello-from-B.txt'), get?.result?.content?.[0]?.text);
console.log('LOCAL FILE:', (await import('node:fs')).readFileSync('/tmp/buddy-live-inbox/hello-from-B.txt', 'utf8').trim());
child.kill();
process.exit(0);