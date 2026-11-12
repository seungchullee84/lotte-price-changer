import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const stubPortal = `
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
export function openPortal() {
  return {
    async open() { return {status:'ready'}; }, async close() {}, async ensureSearch() {},
    async query(code) {
      await new Promise(resolve => setTimeout(resolve, 40));
      return [{code, id:code, currentPrice:code==='000002'?15000:20000,
        scheduledStatus:code==='000003'?'진행 중':'', scheduledPrice:'15,000',channel:'롯데',store:'매장'}];
    },
    async stage(offer, expected, target, date, hour, {save}) {
      if(offer.code==='000004') throw Object.assign(new Error('이미 적용'),{
        code:'OFFER_ALREADY',offer:{...offer,currentPrice:target},progress:{status:'already',message:'이미 적용 · 건너뜀'}});
      await appendFile(path.join(process.env.PRICE_CHANGER_DATA,'fake-saves.jsonl'),JSON.stringify({ ...offer, expected, target, date, hour, save })+'\\n');
    }
  };
}`;

async function waitUntil(action) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not become ready');
}

test('server skips applied/pending rows, persists outcomes and reuses authentication', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'price-stability-'));
  const data = path.join(directory, 'data');
  await mkdir(data);
  for (const file of ['server.mjs', 'memo.mjs', 'ledger.mjs', 'index.html', 'app.js', 'styles.css']) {
    await copyFile(path.join(project, file), path.join(directory, file));
  }
  await writeFile(path.join(directory, 'portal.mjs'), stubPortal);
  const auditFile = path.join(data, 'price-change-audit.jsonl');
  await writeFile(auditFile, JSON.stringify({
    mode: 'discount', originalCode: '01000002', code: '000002', productId: '000002',
    channel: '롯데', store: '매장', fromPrice: 20000, toPrice: 15000,
    effectiveAt: '2000-01-02T12:00:00+09:00', verifiedAt: '2000-01-01T00:00:00Z',
  }) + '\n');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const children = [];
  function launch() {
    const child = spawn(process.execPath, ['server.mjs'], { cwd: directory, windowsHide: true,
      env: {...process.env, PRICE_CHANGER_DATA:data, PRICE_CHANGER_PORT:String(port), PRICE_CHANGER_NO_OPEN:'1',
        PRICE_CHANGER_READY_FILE:path.join(data,'desktop-session.txt')}, stdio:'pipe' });
    children.push(child);
    return child;
  }
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive:true, force:true });
  });
  const first = launch();
  const launchUrl = await waitUntil(() => readFile(path.join(data, 'desktop-session.txt'), 'utf8'));
  const login = await fetch(launchUrl, {redirect:'manual'});
  assert.equal(login.status,303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function request(route, body) {
    return fetch(base + route, {method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,
      'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  }
  assert.equal((await fetch(base+'/api/state')).status,403);
  const portalOpen = await request('/api/portal/open', {});
  assert.equal(portalOpen.status, 200);
  assert.match((await portalOpen.json()).message, /가격관리 화면을 열었습니다/);
  assert.equal((await request('/api/import', {sourceText:[1,2,3,4,5].map(n=>
    '01'+String(n).padStart(6,'0')+'\t20000\t15000').join('\n')})).status,200);
  const future = new Date(Date.now()+9*3600000+24*3600000).toISOString();
  const schedule = {mode:'discount',date:future.slice(0,10),hour:future.slice(11,13)};
  assert.equal((await request('/api/portal/check-and-run',schedule)).status,200);
  assert.equal((await request('/api/portal/check',{mode:'discount'})).status,409);
  const state = await waitUntil(async()=>{const s=await (await request('/api/state')).json();return !s.busy&&s;});
  assert.deepEqual(Object.values(state.results).map(r=>r.status),['saved','already','scheduled','already','saved']);
  assert.equal((await readFile(path.join(data,'fake-saves.jsonl'),'utf8')).trim().split('\n').length,2);
  // Repeat standard run only sees completed rows and must not repeat any save.
  await request('/api/portal/run',schedule);
  await waitUntil(async()=>!(await (await request('/api/state')).json()).busy);
  assert.equal((await readFile(path.join(data,'fake-saves.jsonl'),'utf8')).trim().split('\n').length,2);
  const second = launch();
  assert.equal((await once(second,'exit'))[0],0);
  first.kill(); await once(first,'exit');
  const running = launch();
  const restarted = await waitUntil(async()=>{const response=await request('/api/state');return response.ok&&response.json();});
  assert.equal(restarted.results['1'].status,'saved');
  assert.equal(restarted.results['5'].status,'saved');
  assert.equal(await readFile(path.join(data,'desktop-session.txt'),'utf8'),launchUrl);
  assert.equal((await request('/api/portal/run',{mode:'discount',date:'2020-01-01',hour:'00'})).status,400);

  assert.equal((await request('/api/plan/price', {
    line: 2, originalCode: '01000002', expectedPrice: 15000, newPrice: 14000,
  })).status, 200);
  const idle = () => waitUntil(async () => {
    const next = await (await request('/api/state')).json();
    return !next.busy && next;
  });
  const readStages = async () => (await readFile(path.join(data, 'fake-saves.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal((await request('/api/portal/check', { mode: 'restore' })).status, 200);
  const restoredCheck = await idle();
  assert.equal(restoredCheck.results['2'].status, 'ready');
  assert.equal(restoredCheck.results['2'].expectedPrice, 15000);
  assert.equal(restoredCheck.results['2'].targetPrice, 20000);
  assert.equal(restoredCheck.results['3'].status, 'pending_change');
  assert.equal((await readStages()).length, 2, 'Restoration lookup has no price writes');
  const restoreSchedule = { ...schedule, mode: 'restore' };
  assert.equal((await request('/api/portal/run', restoreSchedule)).status, 200);
  const restored = await idle();
  assert.equal(restored.results['2'].status, 'saved');
  assert.match(restored.message, /원가격 복구 예약 완료.*1건/);
  const stages = await readStages();
  assert.equal(stages.length, 3);
  const { code, expected, target, date, hour, save } = stages.at(-1);
  assert.deepEqual({ code, expected, target, date, hour, save }, {
    code: '000002', expected: 15000, target: 20000, date: schedule.date, hour: schedule.hour, save: true,
  });
  const receipt = JSON.parse((await readFile(auditFile, 'utf8')).trim().split('\n').at(-1));
  assert.equal(receipt.mode, 'restore');
  assert.equal(receipt.effectiveAt, schedule.date + 'T' + schedule.hour + ':00:00+09:00');
  assert.equal((await request('/api/portal/run', restoreSchedule)).status, 200);
  await idle();
  assert.equal((await readStages()).length, 3, 'A saved restoration is not submitted twice');

  running.kill();
  await once(running, 'exit');
  launch();
  const recovered = await idle();
  assert.equal(recovered.results['2'].status, 'saved');
  assert.equal(recovered.results['2'].expectedPrice, 15000);
  assert.equal(recovered.plan.rows[1].newPrice, 14000);

  const boundaryRows = ['01000006\t7001\t7000', '01000007\t7000\t7001',
    '01000008\t50000\t7001', '01000009\t18000\t21000'];
  assert.equal((await request('/api/import', { sourceText: boundaryRows.join('\n') })).status, 200);
  assert.equal((await request('/api/portal/check', { mode: 'discount' })).status, 200);
  const discount = await idle();
  assert.deepEqual(Object.values(discount.results).map(result => result.status), ['blocked', 'ready', 'ready', 'ready']);
  assert.match(discount.results[1].message, /7,000원 이하/);
  assert.equal(discount.results[3].expectedPrice, 20000);
  assert.equal((await request('/api/portal/stage', { ...schedule, line: 1 })).status, 400);
  assert.equal((await readStages()).length, 3);
  assert.equal((await request('/api/portal/check-and-run', schedule)).status, 200);
  await idle();
  assert.deepEqual((await readStages()).slice(3).map(({code, expected, target}) => [code, expected, target]),
    [['000007', 20000, 7001], ['000008', 20000, 7001], ['000009', 20000, 21000]]);

  assert.equal((await request('/api/portal/check', { mode: 'restore' })).status, 200);
  const restore = await idle();
  assert.deepEqual(Object.values(restore.results).map(result => result.status), ['ready', 'blocked', 'ready', 'ready']);
  assert.match(restore.plan.rows[1].restoreRestriction, /7,000원 이하/);
  assert.equal(restore.results[1].targetPrice, 7001);
  assert.equal((await readStages()).length, 6);
});
