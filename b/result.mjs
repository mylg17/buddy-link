import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const [,, rawId, dbArg, projectsArg] = process.argv;
const db = new DatabaseSync(dbArg);
let s = db.prepare('select id,title,status,updated_at from sessions where id = ? limit 1').get(rawId);
if (!s) {
  const a = db.prepare('select name, created_at from automations where id = ? limit 1').get(rawId);
  if (a) s = db.prepare('select id,title,status,updated_at from sessions where title = ? and created_at >= ? order by created_at desc limit 1').get(a.name, a.created_at - 5000);
  if (!s && a) s = db.prepare('select id,title,status,updated_at from sessions where title = ? order by created_at desc limit 1').get(a.name);
}
if (!s) { console.log(JSON.stringify({ ok: false, phase: 'pending' })); db.close(); process.exit(0); }
let text = '';
const projects = projectsArg || path.join(os.homedir(), '.workbuddy', 'projects');
try {
  for (const d of fs.readdirSync(projects)) {
    const f = path.join(projects, d, s.id + '.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const c = o && o.content;
      if (Array.isArray(c)) {
        const t = c.filter((x) => x && (x.type === 'output_text' || x.type === 'text')).map((x) => x.text).join('').trim();
        if (t && (!o.role || o.role === 'assistant')) text = t;
      }
    }
    break;
  }
} catch {}
console.log(JSON.stringify({ ok: true, sessionId: s.id, title: s.title, status: s.status, updatedAt: s.updated_at, text }));
db.close();