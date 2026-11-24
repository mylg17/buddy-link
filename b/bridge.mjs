#!/usr/bin/env node
/**
 * BuddyLink —— B 端桥接服务
 * 收到 A 下发的指令（原文），交给本机 CodeBuddy CLI 执行，并把过程与结果流式回传。
 * 无第三方依赖，Node >= 18。
 *
 * 配置来源（优先级从高到低）：
 *   1) 环境变量 BUDDY_*        2) 同目录 buddy-link.config.json        3) 默认值
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(await fsp.readFile(path.join(HERE, 'package.json'), 'utf8').catch(() => '{}'));

function loadFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'buddy-link.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const fileCfg = loadFileConfig();
const WORKDIR = path.resolve(process.env.BUDDY_WORKDIR || fileCfg.workdir || path.join(os.homedir(), 'buddy-workspace'));
const ENV_ROOTS = process.env.BUDDY_ALLOW_ROOTS
  ? process.env.BUDDY_ALLOW_ROOTS.split(path.delimiter === ';' ? ';' : ':').map((s) => s.trim()).filter(Boolean)
  : null;
const cfg = {
  token: process.env.BUDDY_TOKEN || fileCfg.token || '',
  host: process.env.BUDDY_HOST || fileCfg.host || '0.0.0.0',
  port: Number(process.env.BUDDY_PORT || fileCfg.port || 8765),
  workdir: WORKDIR,
  cliCommand: process.env.BUDDY_CLI || fileCfg.cliCommand || 'codebuddy',
  cliPrefixArgs: fileCfg.cliPrefixArgs || [],
  cliEnv: fileCfg.cliEnv || {},
  permissionMode: process.env.BUDDY_PERMISSION_MODE || fileCfg.permissionMode || 'acceptEdits',
  promptVia: process.env.BUDDY_PROMPT_VIA || fileCfg.promptVia || 'arg', // arg | stdin
  maxRunMs: Number(process.env.BUDDY_MAX_RUN_MS || fileCfg.maxRunMs || 45 * 60 * 1000),
  maxPromptChars: Number(fileCfg.maxPromptChars || 200000),
  allowReadRoots: [...new Set([WORKDIR, ...(ENV_ROOTS || fileCfg.allowReadRoots || [])].map((p) => path.resolve(p)))],
  platform: fileCfg.platform || process.platform,
  homeDir: fileCfg.homeDir || os.homedir(),
  nodeBin: fileCfg.nodeBin || process.execPath,
  autoDb: fileCfg.autoDb || path.join(fileCfg.homeDir || os.homedir(), '.workbuddy', 'workbuddy.db'),
  projectsDir: fileCfg.projectsDir || path.join(fileCfg.homeDir || os.homedir(), '.workbuddy', 'projects'),
};

if (!cfg.token) {
  console.error('[buddy-link] 缺少 token：请设置 BUDDY_TOKEN 或写入 buddy-link.config.json');
  process.exit(2);
}
fs.mkdirSync(cfg.workdir, { recursive: true });
const RUNS_DIR = path.join(cfg.workdir, '.buddy', 'runs');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const runs = new Map(); // runId -> { id, sessionId, startedAt, child, sse, text, stderrTail }
const startedAt = Date.now();

/* ---------------- 工具函数 ---------------- */

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function authOk(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.*)$/i.exec(h);
  return !!m && safeEqual(m[1], cfg.token);
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid JSON body: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

/** 把 CLI 的 stream-json 行归一化成统一事件 */
function normalizeLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return { type: 'raw', text: line };
  }
  if (obj.type === 'assistant' && obj.message?.content) {
    const text = obj.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (text) return { type: 'delta', text };
    const tools = obj.message.content.filter((c) => c.type === 'tool_use').map((c) => ({ name: c.name, input: c.input }));
    if (tools.length) return { type: 'tool_use', tools };
  }
  if (obj.type === 'user' && obj.message?.content) {
    const results = obj.message.content.filter((c) => c.type === 'tool_result');
    if (results.length) return { type: 'tool_result', results };
  }
  if (obj.type === 'stream_event' && obj.event?.delta?.text) {
    return { type: 'delta', text: obj.event.delta.text };
  }
  if (obj.type === 'system') return { type: 'system', subtype: obj.subtype, data: obj };
  if (obj.type === 'result') return { type: 'result', data: obj };
  return { type: 'event', data: obj };
}

function spawnCli(args) {
  const isWin = process.platform === 'win32';
  const cmd = cfg.cliCommand;
  const useShell = isWin && /\.(cmd|bat)$/i.test(cmd);
  return spawn(cmd, [...cfg.cliPrefixArgs, ...args], {
    cwd: cfg.workdir,
    windowsHide: true,
    shell: useShell,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CODEBUDDY_SKIP_UPDATE_CHECK: '1', ...cfg.cliEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

/* ---------------- 主流程：执行一次指令 ---------------- */

async function handleRun(req, res) {
  const body = await readBody(req);
  const prompt = String(body.prompt ?? '');
  if (!prompt.trim()) return json(res, 400, { ok: false, error: 'prompt 不能为空' });
  if (prompt.length > cfg.maxPromptChars) return json(res, 413, { ok: false, error: 'prompt 过长' });

  const runId = body.runId || crypto.randomUUID();
  const sessionId = body.sessionId || crypto.randomUUID();
  const permissionMode = body.permissionMode || cfg.permissionMode;
  const timeoutMs = Math.min(Number(body.timeoutMs || cfg.maxRunMs), cfg.maxRunMs);

  const args = ['-p'];
  if (cfg.promptVia === 'arg') args.push(prompt);
  args.push('--output-format', 'stream-json', '--permission-mode', permissionMode, '--session-id', sessionId);
  if (body.model) args.push('--model', String(body.model));
  if (body.maxTurns) args.push('--max-turns', String(body.maxTurns));

  const child = spawnCli(args);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-buddy-run-id': runId,
    'x-buddy-session-id': sessionId,
  });
  const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  const state = { id: runId, sessionId, startedAt: Date.now(), child, text: '', stderrTail: '', done: false, steps: [] };
  runs.set(runId, state);
  send({ type: 'accepted', runId, sessionId, host: os.hostname(), workdir: cfg.workdir, permissionMode });

  if (cfg.promptVia === 'stdin') {
    child.stdin.write(prompt + '\n');
  }
  child.stdin.end();

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const ev = normalizeLine(line);
      if (ev.type === 'delta') state.text += ev.text;
      if (ev.type === 'tool_use') {
        for (const t of ev.tools || []) {
          state.steps.push({ kind: 'tool', name: t.name, input: JSON.stringify(t.input || {}).slice(0, 300) });
        }
      }
      if (ev.type === 'tool_result') {
        const r = (ev.results || [])[0];
        if (r) state.steps.push({ kind: 'result', text: JSON.stringify(r.content ?? '').slice(0, 300) });
      }
      if (ev.type === 'result') {
        const r = ev.data?.result ?? ev.data?.message;
        if (typeof r === 'string' && r) state.text = r;
      }
      send(ev);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderrTail = (state.stderrTail + chunk).slice(-4000);
    send({ type: 'stderr', text: chunk.slice(0, 2000) });
  });

  const timer = setTimeout(() => {
    send({ type: 'error', error: 'timeout', timeoutMs });
    killTree(child);
  }, timeoutMs);

  const finish = async (code, signal) => {
    if (state.done) return;
    state.done = true;
    clearTimeout(timer);
    clearInterval(heartbeat);
    const record = {
      runId, sessionId, code, signal, ms: Date.now() - state.startedAt,
      workdir: cfg.workdir, permissionMode, text: state.text, stderr: state.stderrTail, steps: state.steps,
      finishedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(RUNS_DIR, runId + '.json'), JSON.stringify(record, null, 2)).catch(() => {});
    send({ type: 'done', ...record });
    res.end();
    runs.delete(runId);
  };

  child.on('error', (err) => {
    send({ type: 'error', error: 'spawn failed: ' + err.message, hint: '检查 BUDDY_CLI 是否指向可执行的 codebuddy' });
    finish(-1, null);
  });
  child.on('close', (code, signal) => finish(code, signal));

  req.on('close', () => {
    if (!state.done) {
      killTree(child);
      clearTimeout(timer);
      clearInterval(heartbeat);
      runs.delete(runId);
    }
  });
}

/* ---------------- 文件回传 ---------------- */

function withinRoot(p) {
  const abs = path.resolve(p);
  return cfg.allowReadRoots.some((root) => abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep));
}

async function handleFile(res, url) {
  const p = url.searchParams.get('path') || '';
  if (!p) return json(res, 400, { ok: false, error: '缺少 path' });
  const abs = path.isAbsolute(p) ? p : path.join(cfg.workdir, p);
  if (!withinRoot(abs)) return json(res, 403, { ok: false, error: '路径不在允许范围内', allowReadRoots: cfg.allowReadRoots });
  const st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) return json(res, 404, { ok: false, error: '文件不存在' });
  if (st.size > 200 * 1024 * 1024) return json(res, 413, { ok: false, error: '文件超过 200MB，请改用分片或清单' });
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'x-buddy-path': Buffer.from(abs).toString('base64'),
    'x-buddy-mtime': String(st.mtimeMs),
  });
  fs.createReadStream(abs).pipe(res);
}

async function handleList(res, url) {
  const p = url.searchParams.get('path') || '.';
  const abs = path.isAbsolute(p) ? p : path.join(cfg.workdir, p);
  if (!withinRoot(abs)) return json(res, 403, { ok: false, error: '路径不在允许范围内' });
  const items = await fsp.readdir(abs, { withFileTypes: true }).catch(() => null);
  if (!items) return json(res, 404, { ok: false, error: '目录不存在' });
  return json(res, 200, {
    ok: true, dir: abs,
    entries: items.slice(0, 500).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' })),
  });
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  try {
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true, name: 'buddy-link', version: PKG.version || '0.1.0',
        host: os.hostname(), platform: process.platform, workdir: cfg.workdir,
        permissionMode: cfg.permissionMode, cli: cfg.cliCommand,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000), activeRuns: [...runs.keys()],
      });
    }

    if (!authOk(req)) return json(res, 401, { ok: false, error: '未授权：缺少或错误的 Bearer token' });

    if (req.method === 'POST' && url.pathname === '/run') return await handleRun(req, res);

    if (req.method === 'POST' && url.pathname === '/cancel') {
      const body = await readBody(req);
      const st = runs.get(body.runId);
      if (!st) return json(res, 404, { ok: false, error: '没有这个 run' });
      killTree(st.child);
      return json(res, 200, { ok: true, cancelled: body.runId });
    }

    if (req.method === 'GET' && url.pathname === '/runs') {
      return json(res, 200, {
        ok: true,
        runs: [...runs.values()].map((s) => ({ id: s.id, sessionId: s.sessionId, startedAt: s.startedAt, chars: s.text.length })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/auto') {
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'prompt 不能为空' });
      const base = path.dirname(cfg.workdir);
      const promptFile = path.join(base, 'b', 'auto-prompt.txt');
      const helper = path.join(base, 'b', 'auto-run.mjs');
      const dbPath = (cfg.autoDb);
      await fsp.writeFile(promptFile, prompt, 'utf8');
      const waitMode = body.wait === true;
      const args = ['--experimental-sqlite', helper, promptFile, body.cwd || cfg.workdir, String(body.name || '').slice(0, 40), dbPath, waitMode ? 'wait' : 'nowait'];
      const child = spawn(cfg.nodeBin || 'node', args, { windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      const done = new Promise((resolve) => {
        child.on('close', (code) => resolve(code));
        setTimeout(() => { try { child.kill(); } catch {} resolve(-1); }, Math.min(Number(body.timeoutMs || 360000), 360000));
      });
      const code = await done;
      const lines = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{'));
      let last = {};
      for (const l of lines) { try { last = JSON.parse(l); } catch {} }
      return json(res, 200, {
        ok: !!last.ok,
        phase: last.phase || (code === 0 ? 'unknown' : 'failed'),
        sessionId: last.sessionId,
        status: last.status || last.sessionStatus || last.runStatus,
        title: last.title,
        automationId: last.automationId,
        text: last.text || '',
        stderr: err.slice(-400),
      });
    }

    if (req.method === 'POST' && url.pathname === '/upload') {
      const body = await readBody(req, 80 * 1024 * 1024);
      const name = path.basename(String(body.name || 'file.bin')).replace(/[^A-Za-z0-9._-]/g, '_');
      const dest = path.join(path.dirname(cfg.workdir), 'inbox', name);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, Buffer.from(String(body.data_b64 || ''), 'base64'));
      const st = await fsp.stat(dest);
      return json(res, 200, { ok: true, path: dest, bytes: st.size });
    }

    if (req.method === 'GET' && url.pathname === '/result') {
      const sid = url.searchParams.get('id') || url.searchParams.get('sessionId') || url.searchParams.get('automationId') || '';
      if (!/^[A-Za-z0-9-]+$/.test(sid)) return json(res, 400, { ok: false, error: 'bad id' });
      const helper = path.join(path.dirname(cfg.workdir), 'b', 'result.mjs');
      const child = spawn(cfg.nodeBin || 'node', ['--experimental-sqlite', helper, sid, cfg.autoDb, cfg.projectsDir], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => { child.on('close', r); setTimeout(() => { try { child.kill(); } catch {} r(); }, 15000); });
      try { return json(res, 200, JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { return json(res, 500, { ok: false, error: out.slice(0, 300) }); }
    }

    if (req.method === 'GET' && url.pathname === '/by-title') {
      const q = url.searchParams.get('q') || '';
      const helper = path.join(path.dirname(cfg.workdir), 'b', 'bytitle.mjs');
      const child = spawn(cfg.nodeBin || 'node', ['--experimental-sqlite', helper, q, cfg.autoDb], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => { child.on('close', r); setTimeout(() => { try { child.kill(); } catch {} r(); }, 12000); });
      try { return json(res, 200, JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { return json(res, 500, { ok: false, error: out.slice(0, 200) }); }
    }

    if (req.method === 'GET' && url.pathname === '/changes') {
      const since = url.searchParams.get('since') || '0';
      const helper = path.join(path.dirname(cfg.workdir), 'b', 'changes.mjs');
      const child = spawn(cfg.nodeBin || 'node', [helper, since, cfg.workdir], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => { child.on('close', r); setTimeout(() => { try { child.kill(); } catch {} r(); }, 20000); });
      try { return json(res, 200, JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { return json(res, 500, { ok: false, error: out.slice(0, 200) }); }
    }

    if (req.method === 'GET' && url.pathname === '/latest') {
      const since = url.searchParams.get('since') || '0';
      const helper = path.join(path.dirname(cfg.workdir), 'b', 'latest.mjs');
      const child = spawn(cfg.nodeBin || 'node', ['--experimental-sqlite', helper, since, cfg.autoDb], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => { child.on('close', r); setTimeout(() => { try { child.kill(); } catch {} r(); }, 12000); });
      try { return json(res, 200, JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { return json(res, 500, { ok: false, error: out.slice(0, 200) }); }
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const helper = path.join(path.dirname(cfg.workdir), 'b', 'sessions.mjs');
      const child = spawn(cfg.nodeBin || 'node', ['--experimental-sqlite', helper, cfg.autoDb], { windowsHide: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      await new Promise((r) => { child.on('close', r); setTimeout(() => { try { child.kill(); } catch {} r(); }, 15000); });
      try { return json(res, 200, JSON.parse(out.trim().split('\n').pop() || '{}')); } catch { return json(res, 500, { ok: false, error: out.slice(0, 300) }); }
    }

    if (req.method === 'POST' && url.pathname === '/cdp') {
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'prompt 不能为空' });
      const base = path.dirname(cfg.workdir);
      const promptFile = path.join(base, 'b', 'cdp-prompt.txt');
      const titleFile = path.join(base, 'b', 'cdp-title.txt');
      await fsp.mkdir(path.dirname(promptFile), { recursive: true });
      await fsp.writeFile(promptFile, prompt, 'utf8');
      const mode = body.title ? 'existing' : 'new';
      if (body.title) await fsp.writeFile(titleFile, String(body.title).slice(0, 40), 'utf8');
      const helper = path.join(base, 'b', 'cdp-send5.mjs');
      const child = spawn(cfg.nodeBin || 'node', [helper, mode, titleFile, promptFile], { windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      await new Promise((r) => { child.on('close', r); setTimeout(() => { try { child.kill(); } catch {} r(); }, 40000); });
      const last = out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}';
      let parsed = {};
      try { parsed = JSON.parse(last); } catch {}
      return json(res, 200, { ...parsed, mode, stderr: err.slice(-200), log: out.split('\n').slice(0, 3).join(' | ').slice(0, 200) });
    }

    if (req.method === 'POST' && url.pathname === '/ui') {
      const body = await readBody(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { ok: false, error: 'prompt 不能为空' });
      const base = path.dirname(cfg.workdir);
      const promptFile = path.join(base, 'b', 'ui-prompt.txt');
      const modeFile = path.join(base, 'b', 'ui-mode.txt');
      const logPath = path.join(base, 'b', 'logs', 'ui-click.log');
      await fsp.mkdir(path.dirname(promptFile), { recursive: true });
      await fsp.writeFile(promptFile, prompt, 'utf8');
      await fsp.writeFile(modeFile, String(body.mode || 'home'), 'utf8');
      await fsp.writeFile(logPath, 'queued', 'utf8').catch(() => {});
      const trigger = path.join(base, 'b', 'ui-trigger.cmd');
      await new Promise((resolve) => {
        const p = spawn(process.env.ComSpec || 'cmd.exe', ['/c', trigger], { windowsHide: true });
        p.on('close', resolve);
        p.on('error', resolve);
        setTimeout(resolve, 6000);
      });
      let log = '';
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        log = await fsp.readFile(logPath, 'utf8').catch(() => '');
        if (/done/.test(log) || /not-foreground/.test(log) || /no window/.test(log)) break;
      }
      const done = /done/.test(log);
      const notFg = /not-foreground/.test(log);
      return json(res, 200, {
        ok: true,
        delivered: done && !notFg,
        note: done && !notFg
          ? '已把指令输入到 B 的 WorkBuddy 并回车，B 端会话已开始执行'
          : notFg
            ? 'B 的 WorkBuddy 没能拿到前台焦点（可能锁屏或被别的窗口挡住）：请解锁/让 WorkBuddy 在前台后重试'
            : '未收到执行确认，检查 B 是否锁屏',
        log: log.split('\n').slice(-8).join('\n'),
      });
    }

    if (req.method === 'GET' && url.pathname === '/file') return await handleFile(res, url);
    if (req.method === 'GET' && url.pathname === '/files') return await handleList(res, url);

    if (req.method === 'GET' && url.pathname === '/run-result') {
      const id = url.searchParams.get('runId') || '';
      if (!/^[A-Za-z0-9-]+$/.test(id)) return json(res, 400, { ok: false, error: '非法 runId' });
      const p = path.join(RUNS_DIR, id + '.json');
      const raw = await fsp.readFile(p, 'utf8').catch(() => null);
      if (!raw) return json(res, 404, { ok: false, error: '结果不存在' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(raw);
    }

    return json(res, 404, { ok: false, error: 'unknown endpoint' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { ok: false, error: err?.message || String(err) });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log('[buddy-link] 监听 http://' + cfg.host + ':' + cfg.port);
  console.log('[buddy-link] 工作目录: ' + cfg.workdir);
  console.log('[buddy-link] CLI: ' + cfg.cliCommand + '  permissionMode=' + cfg.permissionMode + '  promptVia=' + cfg.promptVia);
  console.log('[buddy-link] 提示: 用 Tailscale IP 访问时，BUDDY_HOST 设成 0.0.0.0 或 tailscale0 的地址');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const s of runs.values()) killTree(s.child);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}