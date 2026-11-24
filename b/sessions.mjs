import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
const rows = db.prepare("select id, title, status, datetime(created_at/1000,'unixepoch','localtime') as createdAt from sessions order by created_at desc limit 5").all();
console.log(JSON.stringify({ ok: true, sessions: rows }));
db.close();
