import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecorder } from '../flows/openai/dom-recorder.js';

// 假 page：url() 返回固定地址；evaluate 区分「抓 outerHTML」与「collectSignals 信号」；
// screenshot 真写一个占位文件到磁盘。recorder 其余走真实 fs，验证落盘/清理行为。
function mockPage(url = 'https://chatgpt.com/') {
  return {
    url: () => url,
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes('outerHTML')) return '<html><head></head><body>mock dom</body></html>';
      return { hasEmail: true }; // 作为 collectSignals 的 DOM 信号
    },
    async screenshot({ path: p }) { await fs.writeFile(p, 'PNGDATA'); },
  };
}

async function tmpDir(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), `rec-${tag}-`));
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

test('dir 为空 → no-op 记录器，record/finalize 不建任何文件、不抛', async () => {
  const rec = createRecorder({ dir: '', page: mockPage() });
  assert.equal(rec.enabled, false);
  await rec.record('x', { note: 'n' });
  const r = await rec.finalize({ success: false });
  assert.equal(r.kept, false);
});

test('record 落盘：manifest.jsonl + 每步 html/png + 附带状态机 pageState', async () => {
  const dir = await tmpDir('write');
  const rec = createRecorder({ dir, page: mockPage(), keep: 'all' });
  assert.equal(rec.enabled, true);
  await rec.record('step-a', { note: '第一步' });
  await rec.record('step-b', { note: '第二步' });

  const lines = (await fs.readFile(path.join(dir, 'manifest.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.seq, 1);
  assert.equal(first.stepId, 'step-a');
  assert.equal(first.note, '第一步');
  assert.ok(first.pageState, '应附带状态机 pageState');
  assert.ok(await exists(path.join(dir, first.html)), 'html 快照应落盘');
  assert.ok(await exists(path.join(dir, first.png)), 'png 截图应落盘');

  await fs.rm(dir, { recursive: true, force: true });
});

test('finalize(success=true, keep=fail) → 成功即删整个目录，省存储', async () => {
  const dir = await tmpDir('success');
  const rec = createRecorder({ dir, page: mockPage(), keep: 'fail' });
  await rec.record('s1');
  const r = await rec.finalize({ success: true });
  assert.equal(r.kept, false);
  assert.equal(await exists(dir), false, '成功后目录应被清理');
});

test('finalize(success=false, keep=fail) → 失败留证并生成 recording.html 回放页', async () => {
  const dir = await tmpDir('fail');
  const rec = createRecorder({ dir, page: mockPage(), keep: 'fail' });
  await rec.record('s1', { note: '出错前一步' });
  const r = await rec.finalize({ success: false });
  assert.equal(r.kept, true);
  assert.equal(r.steps, 1);
  assert.ok(await exists(path.join(dir, 'recording.html')), '失败应生成回放页');

  await fs.rm(dir, { recursive: true, force: true });
});
