import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, copyFile, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemo } from '../memo.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const sourceText = '01000001\t30000\t25000\n01000002\t30000\t25000\n';
const sourceId = createHash('sha256').update(sourceText).digest('hex').slice(0, 16);
function initialResults() {
  return Object.fromEntries([1, 2].map(line => [line, { status: 'saved', expectedPrice: 30000,
    targetPrice: 25000, message: '포털 저장 확인', offer: { id: String(line), code: String(line).padStart(6, '0'),
      currentPrice: 30000, channel: '롯데', store: '매장' } }]));
}

async function waitUntil(action) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Price edit test server did not become ready');
}

async function fixture(t, { results = initialResults(), rows, rowRevisions } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'price-edit-'));
  const data = path.join(directory, 'data');
  await mkdir(data);
  for (const file of ['server.mjs', 'memo.mjs', 'ledger.mjs', 'index.html', 'app.js', 'styles.css']) {
    await copyFile(path.join(project, file), path.join(directory, file));
  }
  await writeFile(path.join(directory, 'portal.mjs'), `
    import { appendFile } from 'node:fs/promises';
    import path from 'node:path';
    export function openPortal() { return {
      async close() {}, async ensureSearch() {},
      async query(code) {
        await new Promise(resolve => setTimeout(resolve, 60));
        return [{ id: String(Number(code)), code, currentPrice: 30000, channel: '롯데', store: '매장' }];
      },
      async stage(offer, expected, target, date, hour, options) {
        await appendFile(path.join(process.env.PRICE_CHANGER_DATA, 'fake-stages.jsonl'),
          JSON.stringify({ offer, expected, target, ...options }) + '\\n');
      }
    }; }
  `);
  const parsed = parseMemo(sourceText);
  const plan = { sourceText, ...parsed, rows: rows ?? parsed.rows,
    importedAt: '2026-11-01T10:20:30.000Z', sourceName: '가격표.txt' };
  await writeFile(path.join(data, 'price-plan.json'), JSON.stringify(plan));
  await writeFile(path.join(data, 'run-state.json'), JSON.stringify({ planId: sourceId, mode: 'discount', results, rowRevisions }));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const children = [];
  let child;
  function launch() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: directory, windowsHide: true,
      env: { ...process.env, PRICE_CHANGER_DATA: data, PRICE_CHANGER_PORT: String(port), PRICE_CHANGER_NO_OPEN: '1',
        PRICE_CHANGER_READY_FILE: path.join(data, 'desktop-session.txt') }, stdio: 'pipe' });
    children.push(child);
  }
  t.after(async () => {
    for (const process of children) {
      if (process.exitCode === null && process.signalCode === null) { process.kill(); await once(process, 'exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  launch();
  const launchUrl = await waitUntil(() => readFile(path.join(data, 'desktop-session.txt'), 'utf8'));
  const login = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(route, body) {
    return fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function state() { return (await request('/api/state')).json(); }
  async function idle() { return waitUntil(async () => { const next = await state(); return !next.busy && next; }); }
  async function restart() {
    child.kill(); await once(child, 'exit');
    launch();
    return waitUntil(async () => { const response = await request('/api/state'); return response.ok && response.json(); });
  }
  return { data, request, state, idle, restart };
}

const edit = (newPrice, expectedPrice = 25000, line = 1) => ({
  line, originalCode: '01' + String(line).padStart(6, '0'), newPrice, expectedPrice,
});

test('manual discount prices persist separately from uploaded originals and feed existing portal actions', async t => {
  const app = await fixture(t);
  const initial = await app.state();
  const currentId = initial.plan.archiveId;
  const archiveFile = path.join(app.data, 'price-plan-history', currentId + '.json');
  const archiveBytes = await readFile(archiveFile, 'utf8');
  const runFile = path.join(app.data, 'run-state.json');
  const originalRun = await readFile(runFile, 'utf8');
  assert.equal((await app.request('/api/plan/price', edit(25000))).status, 200);
  assert.equal(await readFile(runFile, 'utf8'), originalRun, 'Same-price edits preserve durable results');

  let response = await app.request('/api/plan/price', edit(22000));
  assert.equal(response.status, 200);
  let state = await response.json();
  assert.equal(state.plan.sourceText, sourceText);
  assert.equal(state.plan.rows[0].newPrice, 22000);
  assert.equal(state.plan.rows[0].uploadedNewPrice, 25000);
  assert.ok(Number.isFinite(Date.parse(state.plan.rows[0].priceUpdatedAt)));
  assert.match(state.plan.rows[0].priceRevision, /^[a-f0-9]{16}$/);
  assert.equal(state.results['1'], undefined);
  assert.deepEqual(state.results['2'], initial.results['2']);
  assert.match(state.message, /현재가를 다시 조회/);
  assert.equal((await app.request('/api/portal/stage', { line: 1, mode: 'discount' })).status, 400,
    'An edited row cannot stage a stale ready result');
  const revision = state.plan.rows[0].priceRevision;
  assert.equal((await app.request('/api/plan/price', edit(21000))).status, 409);
  assert.equal((await app.request('/api/plan/price', { ...edit(21000, 22000), originalCode: '01999999' })).status, 409);
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '21000', null, 31000]) {
    assert.equal((await app.request('/api/plan/price', edit(invalid, 22000))).status, 400);
  }
  assert.equal((await app.state()).plan.rows[0].priceRevision, revision);
  state = await (await app.request('/api/history/load', { id: currentId })).json();
  assert.equal(state.plan.rows[0].newPrice, 22000, 'Reloading the current archive keeps the current edited list');
  assert.deepEqual(state.results['2'], initial.results['2']);
  state = await app.restart();
  assert.equal(state.plan.rows[0].newPrice, 22000);
  assert.equal(state.results['1'], undefined);
  assert.deepEqual(state.results['2'], initial.results['2']);

  await app.request('/api/portal/check', { mode: 'discount' });
  assert.equal((await app.request('/api/plan/price', edit(21000, 22000))).status, 409, 'Busy requests cannot edit');
  state = await app.idle();
  assert.equal(state.results['1'].targetPrice, 22000);
  const future = new Date(Date.now() + 33 * 3600000).toISOString();
  const schedule = { mode: 'discount', date: future.slice(0, 10), hour: future.slice(11, 13) };
  response = await app.request('/api/portal/stage', { line: 1, ...schedule });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results['1'].status, 'pending');
  assert.equal((await app.request('/api/plan/price', edit(21000, 25000, 2))).status, 409,
    'A staged unsaved row blocks edits in other rows too');
  await app.request('/api/portal/check', { mode: 'discount' }); await app.idle();
  state = await (await app.request('/api/plan/price', edit(21000, 22000))).json();
  assert.equal(state.plan.rows[0].uploadedNewPrice, 25000, 'Repeated edits keep the original upload price');
  assert.notEqual(state.plan.rows[0].priceRevision, revision);
  await app.request('/api/portal/run', schedule);
  state = await app.idle();
  assert.equal(state.results['1'].status, 'saved');
  assert.equal(state.results['1'].targetPrice, 21000);
  const stages = (await readFile(path.join(app.data, 'fake-stages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(stages.map(item => [item.offer.code, item.target, item.save]),
    [['000001', 22000, false], ['000001', 21000, true], ['000002', 25000, true]]);

  state = await (await app.request('/api/plan/price', edit(9000, 21000))).json();
  assert.match(state.plan.rows[0].restriction, /9,900원 이하/);
  assert.equal(state.results['2'].status, 'saved');
  assert.equal(await readFile(archiveFile, 'utf8'), archiveBytes);
  assert.equal(await (await app.request('/api/history/' + currentId + '/download')).text(), sourceText);
  await app.request('/api/import', { sourceText: '01000003\t40000\t30000\n', sourceName: '다른목록.txt' });
  state = await (await app.request('/api/history/load', { id: currentId })).json();
  assert.equal(state.plan.rows[0].newPrice, 25000, 'Reusing an archive after another list starts from the original upload');
  assert.equal(state.plan.rows[0].uploadedNewPrice, undefined);
  assert.deepEqual(state.results, {});
  assert.equal(await readFile(archiveFile, 'utf8'), archiveBytes);

  const competing = await Promise.all([app.request('/api/plan/price', edit(22000)), app.request('/api/plan/price', edit(23000))]);
  assert.deepEqual(competing.map(item => item.status).sort(), [200, 409]);
  const committed = await competing.find(item => item.status === 200).json();
  assert.equal((await app.state()).plan.rows[0].newPrice, committed.plan.rows[0].newPrice);
});

test('failed price snapshots preserve state and stale run results cannot return after a partial commit', async t => {
  const app = await fixture(t);
  const before = await app.state();
  const planFile = path.join(app.data, 'price-plan.json');
  const backupFile = planFile + '.bak';
  const planBytes = await readFile(planFile, 'utf8');
  await rename(backupFile, backupFile + '.original');
  await mkdir(backupFile);
  assert.equal((await app.request('/api/plan/price', edit(22000))).status, 400);
  assert.deepEqual((await app.state()).plan, before.plan);
  assert.deepEqual((await app.state()).results, before.results);
  assert.equal(await readFile(planFile, 'utf8'), planBytes);
  await rm(backupFile, { recursive: true });
  await rename(backupFile + '.original', backupFile);

  const runFile = path.join(app.data, 'run-state.json');
  const oldRun = await readFile(runFile, 'utf8');
  await mkdir(runFile + '.tmp');
  const response = await app.request('/api/plan/price', edit(22000));
  assert.equal(response.status, 200, 'A durable price edit is successful even if secondary run-state writing fails');
  let state = await response.json();
  assert.match(state.message, /가격은 저장됐지만 작업 기록 갱신에 실패/);
  assert.equal(state.plan.rows[0].newPrice, 22000);
  assert.equal(state.results['1'], undefined);
  assert.deepEqual(state.results['2'], before.results['2']);
  assert.equal(JSON.parse(await readFile(planFile, 'utf8')).rows[0].newPrice, 22000);
  assert.equal(await readFile(runFile, 'utf8'), oldRun);
  state = await app.restart();
  assert.equal(state.plan.rows[0].newPrice, 22000);
  assert.equal(state.results['1'], undefined, 'Old saved results must not revive when the edited price commits first');
  assert.deepEqual(state.results['2'], before.results['2']);
  await rm(runFile + '.tmp', { recursive: true });
});

test('startup drops mismatched target results but retains uncertainty as a barrier to editing', async t => {
  const results = initialResults();
  results['1'].targetPrice = 24000;
  results['2'].targetPrice = 23000;
  results['2'].needsReview = true;
  const app = await fixture(t, { results });
  const state = await app.state();
  assert.equal(state.results['1'], undefined);
  assert.equal(state.results['2'].status, 'interrupted');
  assert.equal(state.results['2'].needsReview, true);
  assert.equal((await app.request('/api/plan/price', edit(22000))).status, 409);
});
