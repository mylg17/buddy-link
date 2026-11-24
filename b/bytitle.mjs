import { DatabaseSync } from 'node:sqlite';
const [,, q, dbArg] = process.argv;
const db = new DatabaseSync(dbArg);
const s = db.prepare('select id,title,status from sessions where title like ? order by created_at desc limit 1').get(q + '%');
console.log(JSON.stringify(s ? { ok: true, sessionId: s.id, title: s.title, status: s.status } : { ok: false, phase: 'pending' }));
db.close();
