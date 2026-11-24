#!/usr/bin/env node
// 假 CodeBuddy CLI：模拟 stream-json 输出，用于本机端到端自测
import fs from 'node:fs';

const args = process.argv.slice(2);
let prompt = '';
const i = args.indexOf('-p');
if (i >= 0) {
  const next = args[i + 1];
  if (next && !next.startsWith('--')) prompt = next;
}
if (!prompt) {
  const chunks = [];
  await new Promise((res) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', res);
  });
  prompt = Buffer.concat(chunks).toString('utf8').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

emit({ type: 'system', subtype: 'init', session_id: 'fake-session', cwd: process.cwd() });
await sleep(60);
emit({ type: 'assistant', message: { content: [{ type: 'text', text: '收到指令：' + prompt.slice(0, 80) }] } });
await sleep(60);
emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } });
await sleep(60);
fs.writeFileSync('report.md', 'fake report for: ' + prompt + '\n');
emit({ type: 'assistant', message: { content: [{ type: 'text', text: '已完成：生成 report.md' }] } });
await sleep(40);
emit({ type: 'result', subtype: 'success', result: '最终：已完成，共处理 1 个文件' });
process.exit(0);
