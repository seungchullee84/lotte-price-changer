import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemo } from '../memo.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));

async function waitUntil(action) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('History test server did not become ready');
}

test('imports remain reusable and downloadable by upload time across identical imports and restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'price-history-'));
  const data = path.join(directory, 'data');
  const archive = path.join(data, 'price-plan-history');
  await mkdir(archive, { recursive: true });
  for (const file of ['server.mjs', 'memo.mjs', 'ledger.mjs', 'index.html', 'app.js', 'styles.css']) {
    await copyFile(path.join(project, file), path.join(directory, file));
  }
  await writeFile(path.join(directory, 'portal.mjs'), `export function openPortal() {
    return { async close() {}, async open() { throw new Error('Portal must not be opened by history actions'); } };
  }`);
  const olderText = '01000001\t20,000\t15,000\r\n';
  const currentText = '01000002\t30000\t25000\n';
  const older = { sourceText: olderText, ...parseMemo(olderText), importedAt: '2026-10-01T09:12:13.000Z', sourceName: '첫목록.xlsx' };
  const current = { sourceText: currentText, ...parseMemo(currentText), importedAt: '2026-11-01T10:20:30.000Z', sourceName: '가격표.txt' };
  const olderId = createHash('sha256').update(olderText).digest('hex').slice(0, 16);
  const olderFile = path.join(archive, olderId + '.json');
  const olderBytes = JSON.stringify(older);
  await writeFile(olderFile, olderBytes);
  await writeFile(path.join(data, 'price-plan.json'), JSON.stringify(current));
  const savedResults = { 1: { status: 'saved', expectedPrice: 30000, targetPrice: 25000,
    message: '포털 저장 확인', offer: { code: '000002', id: 'product-2', channel: '롯데', store: '매장', currentPrice: 30000 } } };
  const initialRunState = JSON.stringify({
    planId: createHash('sha256').update(currentText).digest('hex').slice(0, 16),
    mode: 'discount', results: savedResults,
  });
  await writeFile(path.join(data, 'run-state.json'), initialRunState);

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const children = [];
  function launch() {
    const child = spawn(process.execPath, ['server.mjs'], { cwd: directory, windowsHide: true,
      env: { ...process.env, PRICE_CHANGER_DATA: data, PRICE_CHANGER_PORT: String(port), PRICE_CHANGER_NO_OPEN: '1',
        PRICE_CHANGER_READY_FILE: path.join(data, 'desktop-session.txt') }, stdio: 'pipe' });
    children.push(child);
    return child;
  }
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    }
    await rm(directory, { recursive: true, force: true });
  });

  const first = launch();
  const launchUrl = await waitUntil(() => readFile(path.join(data, 'desktop-session.txt'), 'utf8'));
  const login = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(route, body) {
    return fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }
  let state = await (await request('/api/state')).json();
  assert.equal(state.history.length, 2);
  assert.equal(state.history.filter(item => item.current).length, 1);
  assert.equal(state.plan.importedAt, current.importedAt);
  const currentId = state.plan.archiveId;
  assert.match(currentId, /^[a-f0-9]{16}$/);
  assert.equal(state.history.find(item => item.id === currentId).sourceName, current.sourceName);
  assert.equal(state.history.find(item => item.id === currentId).rowCount, 1);
  assert.deepEqual(state.results, savedResults, 'Archiving a legacy current list preserves its saved results');

  const sameCurrent = await request('/api/history/load', { id: currentId });
  assert.equal(sameCurrent.status, 200);
  state = await sameCurrent.json();
  assert.deepEqual(state.results, savedResults, 'Selecting the current archive must not clear results');
  assert.match(state.message, /기존 조회·저장 결과를 유지/);
  assert.equal(await readFile(path.join(data, 'run-state.json'), 'utf8'), initialRunState,
    'Selecting the current archive must not overwrite durable results');

  const firstImport = await request('/api/import', { sourceText: currentText, sourceName: '가격표.txt' });
  assert.equal(firstImport.status, 200);
  state = await firstImport.json();
  const firstImportId = state.plan.archiveId;
  const firstImportedAt = state.plan.importedAt;
  assert.notEqual(firstImportId, currentId);
  const repeatedImport = await request('/api/import', { sourceText: currentText, sourceName: '가격표.txt' });
  state = await repeatedImport.json();
  assert.equal(state.history.length, 4);
  assert.notEqual(state.plan.archiveId, firstImportId);
  assert.equal(state.history.find(item => item.id === firstImportId).importedAt, firstImportedAt);

  const reloaded = await request('/api/history/load', { id: olderId });
  assert.equal(reloaded.status, 200);
  state = await reloaded.json();
  assert.equal(state.plan.sourceText, olderText);
  assert.equal(state.plan.sourceName, older.sourceName);
  assert.equal(state.plan.importedAt, older.importedAt);
  assert.equal(state.plan.archiveId, olderId);
  assert.equal(state.history.length, 4);
  assert.equal(state.history.find(item => item.id === olderId).current, true);
  assert.deepEqual(state.results, {});
  assert.equal(await readFile(olderFile, 'utf8'), olderBytes, 'Legacy archive stays unchanged');

  const downloadUrl = state.history.find(item => item.id === olderId).downloadUrl;
  const download = await request(downloadUrl);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type'), /^text\/plain; charset=utf-8$/);
  assert.match(download.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''/);
  assert.equal(await download.text(), olderText);
  assert.equal((await fetch(base + downloadUrl)).status, 403);
  assert.equal((await request('/api/history/0000000000000000/download')).status, 404);
  assert.equal((await request('/api/history/load', { id: '../price-plan' })).status, 400);

  first.kill(); await once(first, 'exit');
  launch();
  state = await waitUntil(async () => {
    const response = await request('/api/state');
    return response.ok && response.json();
  });
  assert.equal(state.history.length, 4, 'Restarts must not generate duplicate imports');
  assert.equal(state.plan.archiveId, olderId);
  assert.equal(state.plan.importedAt, older.importedAt);
  assert.equal((await request(downloadUrl)).status, 200);
});
