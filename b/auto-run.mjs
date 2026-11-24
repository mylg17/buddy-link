import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import os from 'node:os';

const [,, promptFile, cwdArg, nameArg, dbArg, modeArg] = process.argv;
const cwd = cwdArg || 'C:\\buddy-link\\work';
const name = nameArg || '';
const dbPath = dbArg || path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
const mode = modeArg || 'nowait';
const prompt = fs.readFileSync(promptFile, 'utf8').trim();
if (!prompt) { console.log(JSON.stringify({ ok: false, error: 'empty prompt' })); process.exit(1); }

const title = (name || prompt).slice(0, 40);
const db = new DatabaseSync(dbPath);
const now = Date.now();
const tpl = db.prepare('select * from automations order by rowid asc limit 1').get();
if (!tpl) { console.log(JSON.stringify({ ok: false, error: 'no template' })); process.exit(1); }
try { db.prepare("delete from automations where name like 'BuddyLink%' and created_at < ?").run(now - 180000); } catch {}

const id = crypto.randomUUID();
const row = { ...tpl, id, name: title, prompt, status: 'ACTIVE', schedule_type: 'once', rrule: '',
  scheduled_at: new Date(now + 2000).toISOString(), next_run_at: now + 2000, last_run_at: null,
  cwds: JSON.stringify([cwd]), created_at: now, updated_at: now, deleted_at: null };
const keys = Object.keys(row);
db.prepare('insert into automations (' + keys.map((k) => '"' + k + '"').join(',') + ') values (' + keys.map(() => '?').join(',') + ')').run(...keys.map((k) => row[k]));
console.log(JSON.stringify({ ok: true, phase: 'inserted', automationId: id, title, cwd }));

function findSessionId() {
  const run = db.prepare('select thread_id from automation_runs where automation_id = ? order by created_at desc limit 1').get(id);
  return run && run.thread_id ? run.thread_id : null;
}
function sessionStatus(sid) {
  const s = db.prepare('select status from sessions where id = ? limit 1').get(sid);
  return s ? s.status : null;
}
function readLastAssistant(sid) {
  const home = os.homedir();
  const projects = path.join(home, '.workbuddy', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return ''; }
  for (const d of dirs) {
    const f = path.join(projects, d, sid + '.jsonl');
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    let out = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'message' && o.role === 'assistant' && Array.isArray(o.content)) {
        const t = o.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('').trim();
        if (t) out = t;
      }
    }
    return out;
  }
  return '';
}

if (mode === 'nowait') { db.close(); process.exit(0); }

const deadline = Date.now() + 300000;
let sid = null;
while (Date.now() < deadline) {
  if (!sid) sid = findSessionId();
  if (sid) {
    const st = sessionStatus(sid);
    if (st && (st === 'completed' || st === 'error' || st === 'failed' || st === 'idle')) {
      const text = readLastAssistant(sid);
      db.close();
      console.log(JSON.stringify({ ok: true, phase: 'done', sessionId: sid, status: st, text }));
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
}
db.close();
console.log(JSON.stringify({ ok: sid != null, phase: sid ? 'running' : 'timeout', sessionId: sid }));