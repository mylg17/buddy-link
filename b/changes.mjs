import fs from 'node:fs';
import path from 'node:path';
const [,, sinceArg, root] = process.argv;
const since = Number(sinceArg) || 0;
const out = [];
const skip = new Set(['node_modules', '.git', '.buddy']);
function walk(dir, rel) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { walk(p, r); continue; }
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= since && st.size > 0 && st.size <= 50 * 1024 * 1024) {
        out.push({ rel: r, size: st.size, mtime: st.mtimeMs });
      }
    } catch {}
    if (out.length > 40) return;
  }
}
walk(root, '');
out.sort((a, b) => a.mtime - b.mtime);
console.log(JSON.stringify({ ok: true, files: out.slice(0, 20), count: out.length }));
