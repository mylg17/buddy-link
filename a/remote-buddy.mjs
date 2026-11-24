#!/usr/bin/env node
/**
 * BuddyLink —— A 端 MCP 工具
 * 把 A 侧会话里的指令原文发给 B 的桥接服务，取回 B 的执行结果。
 * 无第三方依赖，Node >= 18。
 *
 * 环境变量：
 *   BUDDY_URL      例如 http://100.64.1.23:8765
 *   BUDDY_TOKEN    与 B 端一致的 token
 *   BUDDY_STATE    默认 ~/.buddy-link/sessions.json（记住每个画布的 B 会话 id）
 *   BUDDY_INBOX    默认 ~/Downloads/buddy-inbox（文件拉回目录）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const BUDDY_URL = (process.env.BUDDY_URL || '').replace(/\/+$/, '');
const BUDDY_TOKEN = process.env.BUDDY_TOKEN || '';
const STATE_FILE = process.env.BUDDY_STATE || path.join(os.homedir(), '.buddy-link', 'sessions.json');
const INBOX = process.env.BUDDY_INBOX || path.join(os.homedir(), 'Downloads', 'buddy-inbox');

if (!BUDDY_URL || !BUDDY_TOKEN) {
  process.stderr.write('[buddy-link] 缺少 BUDDY_URL / BUDDY_TOKEN\n');
  process.exit(2);
}

const SERVER_INFO = { name: 'buddy-link', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { canvases: {} };
  }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function api(pathname, { method = 'GET', body, signal } = {}) {
  const res = await fetch(BUDDY_URL + pathname, {
    method,
    headers: {
      authorization: 'Bearer ' + BUDDY_TOKEN,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 400));
  }
  const json = await res.json();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (json.error || JSON.stringify(json)));
  return json;
}

/** 消费 SSE，聚合最终结果 */
async function runRemote({ prompt, sessionId, permissionMode, model, timeoutMs, onProgress }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('client timeout')), timeoutMs || 45 * 60 * 1000);
  let buf = '';
  let text = '';
  let final = null;
  let accepted = null;
  const steps = [];
  const errors = [];
  try {
    const res = await fetch(BUDDY_URL + '/run', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + BUDDY_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, sessionId, permissionMode, model, timeoutMs }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error('run failed HTTP ' + res.status + ': ' + t.slice(0, 400));
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLines = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;
        let ev;
        try { ev = JSON.parse(dataLines.join('\n')); } catch { continue; }
        if (ev.type === 'accepted') accepted = ev;
        else if (ev.type === 'delta') { text += ev.text; onProgress?.(ev.text); }
        else if (ev.type === 'tool_use') {
          for (const t of ev.tools || []) steps.push({ kind: 'tool', name: t.name, input: JSON.stringify(t.input || {}).slice(0, 300) });
          onProgress?.('  [调用工具] ' + (ev.tools || []).map((t) => t.name).join(', '));
        } else if (ev.type === 'tool_result') {
          const r = (ev.results || [])[0];
          if (r) steps.push({ kind: 'result', text: JSON.stringify(r.content ?? '').slice(0, 300) });
        }
        else if (ev.type === 'error') errors.push(ev.error || JSON.stringify(ev));
        else if (ev.type === 'done') { final = ev; if (ev.text) text = ev.text; }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!final && errors.length) throw new Error('B 返回错误: ' + errors.join(' | '));
  return { text: text || final?.text || '', sessionId: final?.sessionId || accepted?.sessionId, runId: final?.runId || accepted?.runId, code: final?.code, steps: final?.steps || steps };
}

const TOOLS = [
  {
    name: 'buddy_ping',
    description: '检查 B 端桥接服务是否在线，返回主机名、平台、工作目录、版本和当前权限模式。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'buddy_run',
    description:
      '把一条指令原样交给 B 端执行，并等待结果。默认续接同一画布上一次的 B 会话；要开新会话传 newSession=true。' +
      '指令原文透传：不要改写、总结或补充用户的话，除非用户要求你这么做。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要原样发给 B 的指令全文' },
        canvas: { type: 'string', description: '画布标识（默认 default），用于隔离不同会话的续接关系' },
        sessionId: { type: 'string', description: '显式指定 B 端会话 id；不传则用该画布记住的会话' },
        newSession: { type: 'boolean', description: 'true 表示开一个新的 B 会话，不续接' },
        permissionMode: { type: 'string', enum: ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto', 'fullAccess'] },
        model: { type: 'string', description: '可选，指定 B 端模型' },
        timeoutMs: { type: 'number', description: '超时（毫秒），默认 45 分钟' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'buddy_auto',
    description:
      '在 B 的 WorkBuddy 里创建一条真实会话并让它执行指令（写一次性的定时任务，B 的桌面端会立即建会话、锁屏也能跑）。' +
      '这是首选方式：指令原文透传，B 界面能看到会话在动。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要交给 B 执行的指令原文' },
        name: { type: 'string', description: '可选，会话标题' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'buddy_ui',
    description:
      '把指令直接粘贴进 B 的 WorkBuddy 输入框并回车，让 B 的界面里出现这个会话并执行（需要 B 未锁屏）。' +
      '用于“必须在 B 的 WorkBuddy 上看到会话在动”的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要粘贴进 B 的 WorkBuddy 的指令原文' },
        mode: { type: 'string', enum: ['home', 'chat'], description: 'home=先在 B 上新建任务再输入；chat=在当前会话里继续（默认 home）' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'buddy_cancel',
    description: '取消 B 端正跑着的任务。',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
  },
  {
    name: 'buddy_runs',
    description: '列出 B 端正在执行的任务。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'buddy_ls',
    description: '列出 B 端工作目录（默认允许范围内）的文件。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'buddy_get',
    description: '把 B 端的一个文件拉到 A 本地，返回本地路径。适合取回 B 生成的报告、截图等。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'B 端文件路径（相对工作目录或绝对路径）' },
        destName: { type: 'string', description: '保存到 A 本地的文件名，默认沿用原名' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  args = args || {};
  if (name === 'buddy_ping') {
    const h = await api('/health');
    return 'B 在线：' + JSON.stringify(h);
  }
  if (name === 'buddy_run') {
    const state = loadState();
    const canvas = args.canvas || 'default';
    const sessionId = args.newSession ? undefined : args.sessionId || state.canvases[canvas]?.sessionId;
    const out = await runRemote({
      prompt: String(args.prompt ?? ''),
      sessionId,
      permissionMode: args.permissionMode,
      model: args.model,
      timeoutMs: args.timeoutMs,
      onProgress: (chunk) => process.stderr.write(chunk),
    });
    if (out.sessionId) {
      state.canvases[canvas] = { sessionId: out.sessionId, lastRunId: out.runId, updatedAt: new Date().toISOString() };
      saveState(state);
    }
    const header = '[B 执行完成] sessionId=' + out.sessionId + ' runId=' + out.runId + ' exit=' + out.code;
    const trail = (out.steps || []).slice(0, 40).map((s, i) => s.kind === 'tool'
      ? (i + 1) + '. 调用 ' + s.name + ' ' + s.input
      : '   ↳ 结果 ' + s.text).join('\n');
    const body = (out.text || '（B 没有返回文本，请查看 B 端日志）');
    return header + '\n\n' + (trail ? '【B 的执行步骤】\n' + trail + '\n\n【B 的输出】\n' : '') + body;
  }
  if (name === 'buddy_auto') {
    const r = await api('/auto', { method: 'POST', body: { prompt: String(args.prompt ?? ''), name: args.name } });
    if (!r.ok) return '下发失败：' + JSON.stringify(r).slice(0, 300);
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const s = await api('/result?id=' + encodeURIComponent(r.automationId));
      if (s && s.ok && s.text) return '[B 已完成] ' + s.title + '\n\n' + s.text;
      if (s && s.ok && s.status && s.status !== 'working' && s.status !== 'running') {
        return '[B 已完成但无文本输出] ' + s.title + ' status=' + s.status;
      }
      await new Promise((res) => setTimeout(res, 4000));
    }
    return '已下发到 B（会话：' + (r.title || '') + '），240 秒内未出结果；automationId=' + r.automationId;
  }
  if (name === 'buddy_ui') {
    const r = await api('/ui', { method: 'POST', body: { prompt: String(args.prompt ?? ''), mode: args.mode || 'home' } });
    return (r.delivered ? '已在 B 的 WorkBuddy 中下发：' : '未送达：') + r.note + '\n' + (r.log || '');
  }
  if (name === 'buddy_cancel') return JSON.stringify(await api('/cancel', { method: 'POST', body: { runId: args.runId } }));
  if (name === 'buddy_runs') return JSON.stringify(await api('/runs'));
  if (name === 'buddy_ls') return JSON.stringify(await api('/files?path=' + encodeURIComponent(args.path || '.')));
  if (name === 'buddy_get') {
    const res = await fetch(BUDDY_URL + '/file?path=' + encodeURIComponent(String(args.path || '')), {
      headers: { authorization: 'Bearer ' + BUDDY_TOKEN },
    });
    if (!res.ok) throw new Error('取文件失败 HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    fs.mkdirSync(INBOX, { recursive: true });
    const name = args.destName || path.basename(String(args.path)) || 'file.bin';
    const dest = path.join(INBOX, name);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return '已保存到：' + dest;
  }
  throw new Error('unknown tool: ' + name);
}

/* ---------------- JSON-RPC over stdio ---------------- */

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function reply(id, result) { writeMsg({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { writeMsg({ jsonrpc: '2.0', id, error: { code, message } }); }

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      const text = await callTool(name, args);
      return reply(id, { content: [{ type: 'text', text }], isError: false });
    }
    if (method === 'shutdown') return reply(id, {});
    if (id === undefined) return;
    return fail(id, -32601, 'method not found: ' + method);
  } catch (err) {
    if (id === undefined) return;
    return reply(id, { content: [{ type: 'text', text: '错误：' + (err?.message || String(err)) }], isError: true });
  }
});
