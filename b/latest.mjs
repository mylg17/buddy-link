import { DatabaseSync } from 'node:sqlite';
const [,, sinceArg, dbArg] = process.argv;
const db = new DatabaseSync(dbArg);
const since = Number(sinceArg) || 0;
const row = db.prepare('select id,title,status,created_at from sessions where created_at >= ? order by created_at desc limit 1').get(since);
console.log(JSON.stringify(row ? { ok: true, sessionId: row.id, title: row.title, status: row.status } : { ok: false, phase: 'pending' }));
db.close();
