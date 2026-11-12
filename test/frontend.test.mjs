import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

let browser;
let server;
let baseUrl;
const downloadableAssets = new Map();

before(async () => {
  const assets = new Map(await Promise.all([
    ['/', '../index.html', 'text/html'],
    ['/app.js', '../app.js', 'text/javascript'],
    ['/styles.css', '../styles.css', 'text/css'],
  ].map(async ([route, file, type]) => [route, {body: await readFile(new URL(file, import.meta.url)), type}])));
  server = createServer((req, res) => {
    const download = downloadableAssets.get(req.url);
    if (download !== undefined) {
      download.requests.push({method: req.method, endpoint: req.url});
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="earlier.txt"',
        'Content-Length': Buffer.byteLength(download.body),
      }).end(download.body);
      return;
    }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': asset.type + '; charset=utf-8'}).end(asset.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({channel: 'chrome', headless: true});
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

function fixtureState() {
  return {
    plan: {
      sourceText: '01001234\t49800\t44200',
      importedAt: new Date().toISOString(),
      sourceName: 'fixture.txt',
      rows: [{line: 1, originalCode: '01001234', code: '001234', currentPrice: 49800, newPrice: 44200}],
      errors: [],
    },
    mode: 'discount', results: {}, busy: false, message: '조회 준비', history: [],
    defaultDate: '2099-01-01', defaultHour: '12',
  };
}

async function openFixture(t, handler) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/api/**', handler);
  await page.goto(baseUrl);
  return page;
}

async function respond(route, state) {
  await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(state)});
}

test('initial connection failure recovers without reopening or losing the saved list', async t => {
  let attempts = 0;
  const state = fixtureState();
  const page = await openFixture(t, async route => {
    attempts += 1;
    if (attempts === 1) return route.abort('connectionrefused');
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 1);
  assert.equal(await page.locator('#error-message').isVisible(), false);
  assert.ok(attempts >= 2);
});

test('idle polling detects another window starting a job and preserves a local draft', async t => {
  const state = fixtureState();
  const page = await openFixture(t, route => respond(route, state));
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('#import-heading').click();
  const draft = '01001234\t49800\t43000';
  await page.locator('#source-text').fill(draft);
  state.busy = true;
  state.message = '포털 조회 중';
  await page.waitForFunction(() => document.querySelector('#status-message').textContent === '포털 조회 중');
  assert.equal(await page.locator('#source-text').inputValue(), draft);
  assert.equal(await page.locator('#source-text').isDisabled(), true);
  state.busy = false;
  state.message = '조회 완료';
  await page.waitForFunction(() => !document.querySelector('#source-text').disabled);
  assert.equal(await page.locator('#source-text').inputValue(), draft);
  assert.equal(await page.locator('#save-plan').isEnabled(), true);
});

test('lost POST response is reconciled by GET and never retries the operation', async t => {
  const state = fixtureState();
  let posts = 0;
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') {
      posts += 1;
      state.busy = true;
      state.message = '가격 변경 처리 중';
      return route.abort('connectionreset');
    }
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#run-prices').disabled);
  await page.locator('#run-prices').click();
  await page.waitForFunction(() => document.querySelector('#status-message').textContent === '가격 변경 처리 중');
  await page.locator('#run-prices').dispatchEvent('click');
  assert.equal(await page.locator('#run-prices').isDisabled(), true);
  assert.equal(posts, 1);
  state.busy = false;
  state.results = {1: {status: 'saved', message: '포털 저장 확인'}};
  state.message = '저장 확인 1건';
  await page.waitForFunction(() => !document.querySelector('#run-prices').disabled);
  assert.match(await page.locator('#work-count').innerText(), /저장 확인 1건/);
  assert.equal(await page.locator('#error-message').isVisible(), false);
  assert.equal(posts, 1);
});

test('an older in-flight GET cannot overwrite the result of a newer operation', async t => {
  const state = fixtureState();
  let getCount = 0;
  let releaseOldRead;
  let notifyOldRead;
  const oldReadStarted = new Promise(resolve => { notifyOldRead = resolve; });
  const oldReadWait = new Promise(resolve => { releaseOldRead = resolve; });
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') {
      state.busy = true;
      state.message = '새 조회 진행 중';
      return respond(route, state);
    }
    getCount += 1;
    if (getCount === 2) {
      const stale = structuredClone(state);
      notifyOldRead();
      await oldReadWait;
      return respond(route, stale);
    }
    await respond(route, state);
  });
  await oldReadStarted;
  await page.locator('#check-prices').click();
  await page.waitForFunction(() => document.querySelector('#status-message').textContent === '새 조회 진행 중');
  const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/state'));
  releaseOldRead();
  await oldResponse;
  assert.equal(await page.locator('#check-prices').isDisabled(), true);
  assert.equal(await page.locator('#status-message').innerText(), '새 조회 진행 중');
});

test('expired schedules are rejected before POST and corrected schedules can run', async t => {
  const state = fixtureState();
  let posts = 0;
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') posts += 1;
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#run-prices').disabled);
  await page.locator('#schedule-date').fill('2020-01-01');
  await page.locator('#run-prices').click();
  assert.equal(posts, 0);
  assert.match(await page.locator('#schedule-hour').evaluate(input => input.validationMessage), /현재 시각 이후/);
  await page.locator('#schedule-date').fill('2099-01-01');
  await page.locator('#run-prices').click();
  await page.waitForFunction(() => !document.querySelector('#run-prices').disabled);
  assert.equal(posts, 1);
});

test('scheduled and in-progress rows have informational labels and their own filter', async t => {
  const state = fixtureState();
  state.results = {1: {status: 'pending_change', message: '기존 변경 진행 중 · 건너뜀'}};
  const page = await openFixture(t, route => respond(route, state));
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('#result-filter').selectOption('pending_change');
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 1);
  assert.match(await page.locator('#price-rows').innerText(), /변경 진행 중/);
  await page.locator('#result-filter').selectOption('review');
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 0);
});

test('startup recovery warnings remain visible alongside job progress', async t => {
  const state = fixtureState();
  state.warnings = ['저장된 목록을 백업 파일에서 복구했습니다.'];
  const page = await openFixture(t, route => respond(route, state));
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  assert.equal(await page.locator('#startup-warnings').innerText(), state.warnings[0]);
  assert.equal(await page.locator('#startup-warnings').isVisible(), true);
  assert.equal(await page.locator('#status-message').innerText(), '조회 준비');
});

function groupedFixtureState() {
  const state = fixtureState();
  const statuses = ['ready', 'missing', 'mismatch', 'blocked', 'already', 'scheduled',
    'pending_change', 'saved', 'ambiguous', 'error', 'interrupted', 'pending', 'unchecked'];
  state.plan.rows = statuses.map((status, index) => {
    const line = index + 1;
    const code = String(1234 + index).padStart(6, '0');
    if (status !== 'unchecked') state.results[line] = {status};
    return {line, code, originalCode: '01' + code, currentPrice: 49800, newPrice: 44200};
  });
  state.results[1].offer = {name: '변경할 니트', currentPrice: 49800};
  state.results[3] = {
    status: 'mismatch', expectedPrice: 49800, targetPrice: 44200,
    offers: [
      {name: '블랙 후보 니트', currentPrice: 39900},
      {name: '베이지 후보 니트', currentPrice: 45900},
    ],
  };
  state.results[4].message = '할인율이 50%를 넘습니다. 할인 하한은 24,900원입니다.';
  state.results[9].offers = [{name: '이름으로 찾을 후보상품', currentPrice: 49800}];
  state.plan.rows.push({
    line: 14, code: '009999', originalCode: '01009999', currentPrice: 9900, newPrice: 5000,
    restriction: '판매가가 9,900원 이하입니다.',
  });
  state.plan.sourceText = state.plan.rows.map(row => [row.originalCode, row.currentPrice, row.newPrice].join('\t')).join('\n');
  return state;
}

test('all results are grouped once with effective restrictions and filters never submit a change', async t => {
  const state = groupedFixtureState();
  let posts = 0;
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') posts += 1;
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  const counts = await page.locator('#result-groups button').evaluateAll(buttons => Object.fromEntries(
    buttons.map(button => [button.dataset.resultGroup, Number(button.querySelector('.result-group-count').textContent)]),
  ));
  assert.deepEqual(counts, {'': 14, ready: 1, missing: 1, price_condition: 3, completed: 4, additional: 5});
  assert.equal(await page.locator('#result-groups [data-result-group=""]').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#work-count').innerText(), /총 14건/);
  assert.deepEqual(await page.locator('#price-rows tr[data-line]').evaluateAll(rows => rows.map(row => Number(row.dataset.line))),
    [1, 2, 3, 4, 14, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.deepEqual(await page.locator('#price-rows .result-group-row').evaluateAll(rows => rows.map(row => row.dataset.resultGroup)),
    ['ready', 'missing', 'price_condition', 'completed', 'additional']);
  await page.locator('#result-groups [data-result-group="price_condition"]').click();
  assert.equal(await page.locator('#result-filter').inputValue(), 'price_condition');
  assert.deepEqual(await page.locator('#price-rows tr[data-line]').evaluateAll(rows => rows.map(row => row.dataset.line)), ['3', '4', '14']);
  const mismatch = page.locator('#price-rows tr[data-line="3"]');
  assert.match(await mismatch.innerText(), /기대 현재가 49,800원/);
  assert.equal(await mismatch.locator('.target-price').innerText(), '44,200원');
  assert.equal(await mismatch.locator('td.money').last().innerText(), '39,900원 / 45,900원');
  assert.equal(await page.locator('#price-rows .result-group-row').count(), 0);
  assert.match(await page.locator('#price-rows tr[data-line="4"]').innerText(), /할인율이 50%를 넘습니다/);
  await page.locator('#result-filter').selectOption('review');
  assert.deepEqual(await page.locator('#price-rows tr[data-line]').evaluateAll(rows => rows.map(row => Number(row.dataset.line))), [2, 3, 4, 14, 9, 10, 11]);
  await page.locator('#result-filter').selectOption('pending_change');
  assert.deepEqual(await page.locator('#price-rows tr[data-line]').evaluateAll(rows => rows.map(row => Number(row.dataset.line))), [6, 7]);
  await page.locator('input[name="mode"][value="restore"]').check();
  assert.equal(await page.locator('#result-groups [data-result-group="price_condition"] .result-group-count').innerText(), '1');
  await page.locator('#result-groups [data-result-group="price_condition"]').click();
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 1);
  assert.match(await page.locator('#price-rows').innerText(), /원가격이 9,900원 이하/);
  assert.equal(posts, 0);
});

test('restoration shows the original price and sends the exact selected schedule only on reservation', async t => {
  const state = fixtureState();
  const requests = [];
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') {
      const endpoint = new URL(route.request().url()).pathname;
      const payload = route.request().postDataJSON();
      requests.push({endpoint, payload});
      if (endpoint === '/api/portal/check') {
        state.mode = payload.mode;
        state.results = {1: {status: 'ready', expectedPrice: 43100, targetPrice: 49800,
          offer: {name: '기존 할인 상품', currentPrice: 43100}}};
      }
    }
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('input[name="mode"][value="restore"]').check();
  assert.equal(await page.getByRole('group', {name: '적용 시작 (한국 시간)'}).isVisible(), true);
  assert.match(await page.locator('#price-rows .target-price').innerText(), /49,800원/);
  assert.equal(requests.length, 0);
  await page.getByRole('button', {name: '현재가 조회', exact: true}).click();
  await page.getByRole('button', {name: /원가격 복구 포털 입력/}).waitFor();
  assert.match(await page.locator('#price-rows tr[data-line="1"]').innerText(), /43,100원/);
  await page.locator('#schedule-date').fill('2099-02-03');
  await page.locator('#schedule-hour').selectOption('19');
  await page.getByRole('button', {name: '복구 대상만 예약', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('#run-prices').disabled);
  assert.deepEqual(requests, [
    {endpoint: '/api/portal/check', payload: {mode: 'restore'}},
    {endpoint: '/api/portal/run', payload: {mode: 'restore', date: '2099-02-03', hour: '19'}},
  ]);
});

test('candidate-name searches combine with groups and survive a state refresh', async t => {
  const state = groupedFixtureState();
  let posts = 0;
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') posts += 1;
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('#result-filter').selectOption('price_condition');
  await page.locator('#code-filter').fill('베이지 후보');
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 1);
  assert.match(await page.locator('#price-rows').innerText(), /블랙 후보 니트/);
  assert.match(await page.locator('#price-rows').innerText(), /베이지 후보 니트/);
  assert.equal(await page.locator('#work-count').innerText(), '1 / 14건 · 저장 확인 1건');
  assert.equal(await page.locator('#result-groups [data-result-group=""] .result-group-count').innerText(), '1');
  assert.equal(await page.locator('#result-groups [data-result-group="ready"] .result-group-count').innerText(), '0');
  assert.equal(await page.locator('#result-groups [data-result-group="price_condition"]').getAttribute('aria-pressed'), 'true');
  state.message = '조회 결과 갱신 완료';
  await page.waitForFunction(() => document.querySelector('#status-message').textContent === '조회 결과 갱신 완료');
  assert.equal(await page.locator('#code-filter').inputValue(), '베이지 후보');
  assert.equal(await page.locator('#result-filter').inputValue(), 'price_condition');
  await page.locator('#result-groups [data-result-group="additional"]').click();
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 0);
  assert.equal(await page.locator('#no-filter-results').isVisible(), true);
  await page.locator('#code-filter').fill('이름으로 찾을');
  assert.deepEqual(await page.locator('#price-rows tr[data-line]').evaluateAll(rows => rows.map(row => row.dataset.line)), ['9']);
  assert.equal(posts, 0);
});

test('saved uploads remain visible with date, filename and count and support read-only download then reload', async t => {
  const currentId = '1111111111111111';
  const previousId = '2222222222222222';
  const state = fixtureState();
  state.plan.archiveId = currentId;
  state.plan.importedAt = '2026-11-11T12:00:00.000Z';
  state.plan.sourceName = 'current.txt';
  const previousPlan = structuredClone(state.plan);
  previousPlan.archiveId = previousId;
  previousPlan.importedAt = '2026-11-10T09:00:00.000Z';
  previousPlan.sourceName = 'earlier.xlsx';
  previousPlan.rows = [1, 2, 3].map(line => ({
    line, originalCode: '0100200' + line, code: '00200' + line, currentPrice: 59800, newPrice: 49800,
  }));
  previousPlan.sourceText = previousPlan.rows.map(row => [row.originalCode, row.currentPrice, row.newPrice].join('\t')).join('\n');
  state.history = [
    {id: currentId, importedAt: state.plan.importedAt, rowCount: 1, sourceName: 'current.txt', current: true, downloadUrl: '/api/history/' + currentId + '/download'},
    {id: previousId, importedAt: previousPlan.importedAt, rowCount: 3, sourceName: 'earlier.xlsx', current: false, downloadUrl: '/api/history/' + previousId + '/download'},
  ];
  const mutations = [];
  const downloads = [];
  const downloadPath = '/api/history/' + previousId + '/download';
  downloadableAssets.set(downloadPath, {body: previousPlan.sourceText, requests: downloads});
  t.after(() => downloadableAssets.delete(downloadPath));
  const page = await openFixture(t, async route => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname;
    if (endpoint.endsWith('/download')) {
      return route.continue();
    }
    if (request.method() === 'POST') {
      mutations.push({endpoint, payload: request.postDataJSON()});
      assert.equal(endpoint, '/api/history/load');
      assert.deepEqual(request.postDataJSON(), {id: previousId});
      state.plan = structuredClone(previousPlan);
      state.history = state.history.map(entry => ({...entry, current: entry.id === previousId}));
      state.message = '이전 가격 목록 3건 불러오기 완료';
    }
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  assert.equal(await page.locator('#import-details').getAttribute('open'), null);
  assert.equal(await page.locator('#history-tools').isVisible(), false);
  await page.locator('#import-heading').click();
  assert.equal(await page.locator('#history-tools').isVisible(), true);
  assert.equal(await page.locator('#history-select option').count(), 3);
  assert.equal(await page.locator('#history-select').inputValue(), currentId);
  const currentLabel = await page.locator('#history-select option[value="' + currentId + '"]').innerText();
  assert.match(currentLabel, /26\. 11\. 11\./);
  assert.match(currentLabel, /오후 9:00/);
  assert.match(currentLabel, /current\.txt.*1건.*현재 사용 중/);
  const oldLabel = await page.locator('#history-select option[value="' + previousId + '"]').innerText();
  assert.match(oldLabel, /26\. 11\. 10\./);
  assert.match(oldLabel, /earlier\.xlsx.*3건/);
  await page.locator('#history-select').selectOption(previousId);
  assert.equal(await page.locator('#download-history').getAttribute('href'), '/api/history/' + previousId + '/download');
  state.message = '보관 목록 선택 유지 확인';
  await page.waitForFunction(() => document.querySelector('#status-message').textContent === '보관 목록 선택 유지 확인');
  assert.equal(await page.locator('#history-select').inputValue(), previousId);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#download-history').click();
  const download = await downloadEvent;
  assert.equal(await readFile(await download.path(), 'utf8'), previousPlan.sourceText);
  assert.deepEqual(downloads, [{method: 'GET', endpoint: '/api/history/' + previousId + '/download'}]);
  assert.equal(mutations.length, 0);
  assert.equal(state.plan.archiveId, currentId);
  await page.locator('#load-history').click();
  await page.waitForFunction(() => document.querySelector('#status-message').textContent === '이전 가격 목록 3건 불러오기 완료');
  assert.deepEqual(mutations, [{endpoint: '/api/history/load', payload: {id: previousId}}]);
  assert.equal(await page.locator('#history-select').inputValue(), previousId);
  assert.match(await page.locator('#history-select option:checked').textContent(), /earlier\.xlsx.*3건.*현재 사용 중/);
  assert.match(await page.locator('#plan-summary').innerText(), /earlier\.xlsx.*26\. 11\. 10\./);
  assert.equal(await page.locator('#source-text').inputValue(), previousPlan.sourceText);
  assert.equal(await page.locator('#price-rows tr[data-line]').count(), 3);
  await page.locator('#import-heading').click();
  await page.locator('#source-text').fill(previousPlan.sourceText + '\n01002004\t59800\t49800');
  assert.equal(await page.locator('#history-select').isDisabled(), true);
  assert.equal(await page.locator('#load-history').isDisabled(), true);
  assert.equal(mutations.length, 1);
});

test('discount-price click validates whole won amounts and Escape cancels without any portal request', async t => {
  const state = fixtureState();
  state.results = {1: {status: 'ready', expectedPrice: 49800, targetPrice: 44200, offer: {currentPrice: 49800}}};
  const posts = [];
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') posts.push(route.request().url());
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('#schedule-date').fill('2020-01-01');
  await page.locator('[data-action="edit-price"][data-line="1"]').click();
  assert.equal(await page.locator('#price-edit-dialog').isVisible(), true);
  assert.equal(await page.locator('#price-edit-value').inputValue(), '44200');
  assert.match(await page.locator('#price-edit-product').innerText(), /01001234.*49,800원/);
  assert.equal(await page.locator('#price-edit-value').getAttribute('inputmode'), 'numeric');
  assert.equal(await page.locator('#check-prices').isDisabled(), true);
  assert.equal(await page.locator('[data-action="stage"]').isDisabled(), true);
  for (const invalid of ['0', '-100', '12.5', '9007199254740992', '44,,200']) {
    await page.locator('#price-edit-value').fill(invalid);
    await page.locator('#price-edit-value').press('Enter');
    assert.match(await page.locator('#price-edit-message').innerText(), /정수/);
  }
  await page.locator('#price-edit-value').fill('49,801');
  await page.locator('#price-edit-value').press('Enter');
  assert.match(await page.locator('#price-edit-message').innerText(), /원가격 49,800원 이하/);
  await page.locator('#price-edit-value').press('Escape');
  assert.equal(await page.locator('#price-edit-dialog').isVisible(), false);
  assert.equal(await page.locator('[data-action="edit-price"]').innerText(), '44,200원');
  assert.equal(await page.locator('[data-action="stage"]').isEnabled(), true);
  assert.equal(await page.locator('#schedule-date').inputValue(), '2020-01-01');
  assert.deepEqual(posts, []);
});

test('saving one manual price preserves schedule, filters and original memo and requires a fresh row lookup', async t => {
  const state = fixtureState();
  const sourceText = state.plan.sourceText;
  state.results = {1: {status: 'ready', expectedPrice: 49800, targetPrice: 44200, offer: {currentPrice: 49800}}};
  const mutations = [];
  let releaseSave;
  const saving = new Promise(resolve => { releaseSave = resolve; });
  t.after(() => releaseSave());
  const page = await openFixture(t, async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      const endpoint = new URL(request.url()).pathname;
      mutations.push({endpoint, payload: request.postDataJSON()});
      if (endpoint === '/api/plan/price') {
        await saving;
        state.plan.rows[0] = {...state.plan.rows[0], newPrice: 40000, uploadedNewPrice: 44200, priceRevision: 1};
        state.results = {};
        state.message = '할인판매가를 40,000원으로 수정했습니다. 현재가를 다시 조회해 주세요.';
      } else if (endpoint === '/api/portal/check') {
        state.results = {1: {status: 'ready', expectedPrice: 49800, targetPrice: state.plan.rows[0].newPrice, offer: {currentPrice: 49800}}};
        state.message = '새 금액 조회 완료';
      } else if (endpoint === '/api/portal/stage') {
        assert.equal(state.results[1].targetPrice, 40000);
        state.results[1].status = 'pending';
        state.message = '포털에 40,000원 입력 · 직접 저장 확인';
      } else assert.fail('Unexpected operation: ' + endpoint);
    }
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('#schedule-date').fill('2099-06-07');
  await page.locator('#schedule-hour').selectOption('03');
  await page.locator('#code-filter').fill('001234');
  await page.locator('#result-filter').selectOption('ready');
  await page.locator('[data-action="edit-price"]').click();
  await page.locator('#price-edit-value').fill('40,000');
  await page.locator('#price-edit-value').press('Enter');
  await page.waitForFunction(() => document.querySelector('#price-edit-save').disabled);
  await page.locator('#price-edit-form').dispatchEvent('submit');
  await page.locator('[data-action="stage"]').dispatchEvent('click');
  await page.locator('#run-prices').dispatchEvent('click');
  await page.locator('#check-prices').dispatchEvent('click');
  assert.equal(await page.locator('#price-edit-value').isDisabled(), true);
  assert.equal(await page.locator('#price-edit-cancel').isDisabled(), true);
  releaseSave();
  await page.waitForFunction(() => !document.querySelector('#price-edit-dialog').open);
  assert.deepEqual(mutations, [{endpoint: '/api/plan/price', payload: {
    line: 1, originalCode: '01001234', newPrice: 40000, expectedPrice: 44200,
  }}]);
  assert.equal(await page.locator('#schedule-date').inputValue(), '2099-06-07');
  assert.equal(await page.locator('#schedule-hour').inputValue(), '03');
  assert.equal(await page.locator('#code-filter').inputValue(), '001234');
  assert.equal(await page.locator('#result-filter').inputValue(), 'ready');
  assert.equal(await page.locator('#source-text').inputValue(), sourceText);
  assert.equal(await page.locator('#save-plan').isDisabled(), true);
  assert.match(await page.locator('#status-message').innerText(), /현재가를 다시 조회/);
  assert.equal(await page.locator('[data-action="stage"]').count(), 0);
  await page.locator('#result-filter').selectOption('unchecked');
  assert.equal(await page.locator('[data-action="edit-price"]').innerText(), '40,000원');
  assert.equal(await page.locator('.price-original-note').innerText(), '업로드 44,200원');
  await page.locator('#check-prices').click();
  await page.locator('[data-action="stage"]').waitFor();
  await page.locator('[data-action="stage"]').click();
  await page.waitForFunction(() => document.querySelector('#status-message').textContent.includes('40,000원 입력'));
  assert.deepEqual(mutations.slice(1), [
    {endpoint: '/api/portal/check', payload: {mode: 'discount'}},
    {endpoint: '/api/portal/stage', payload: {line: 1, mode: 'discount', date: '2099-06-07', hour: '03'}},
  ]);
});

test('price draft and caret survive polling and a concurrent price update blocks stale overwrites', async t => {
  const state = fixtureState();
  let posts = 0;
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') posts += 1;
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('[data-action="edit-price"]').click();
  await page.locator('#price-edit-value').fill('40000');
  await page.locator('#price-edit-value').evaluate(input => input.setSelectionRange(1, 3));
  state.message = '다른 창 조회 상태 변경';
  await page.waitForResponse(response => response.url().endsWith('/api/state'));
  assert.equal(await page.locator('#price-edit-value').inputValue(), '40000');
  assert.deepEqual(await page.locator('#price-edit-value').evaluate(input => [input.selectionStart, input.selectionEnd, document.activeElement === input]), [1, 3, true]);
  state.plan.rows[0].newPrice = 43000;
  await page.waitForFunction(() => document.querySelector('#price-edit-message').textContent.includes('43,000원'));
  assert.equal(await page.locator('#price-edit-value').inputValue(), '40000');
  assert.equal(await page.locator('#price-edit-save').isDisabled(), true);
  await page.locator('#price-edit-form').dispatchEvent('submit');
  await page.locator('#price-edit-cancel').click();
  assert.equal(await page.locator('[data-action="edit-price"]').innerText(), '43,000원');
  assert.equal(posts, 0);
});

test('a lost price-save response is reconciled without retry or portal execution', async t => {
  const state = fixtureState();
  const mutations = [];
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') {
      mutations.push(new URL(route.request().url()).pathname);
      state.plan.rows[0].newPrice = 41000;
      state.message = '할인판매가를 41,000원으로 수정했습니다. 현재가를 다시 조회해 주세요.';
      return route.abort('connectionreset');
    }
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  await page.locator('[data-action="edit-price"]').click();
  await page.locator('#price-edit-value').fill('41000');
  await page.locator('#price-edit-value').press('Enter');
  await page.waitForFunction(() => !document.querySelector('#price-edit-dialog').open);
  assert.equal(await page.locator('[data-action="edit-price"]').innerText(), '41,000원');
  assert.equal(await page.locator('#error-message').isVisible(), false);
  assert.equal(await page.locator('#run-prices').isEnabled(), true);
  assert.deepEqual(mutations, ['/api/plan/price']);
});

test('the next restore checks the prior portal draft and stages the new row with the chosen schedule', async t => {
  const state = fixtureState();
  state.mode = 'restore';
  state.plan.rows.push({line: 2, originalCode: '01001235', code: '001235', currentPrice: 49800, newPrice: 44200});
  state.results = {
    1: {status: 'pending', offer: {id: '1', currentPrice: 44200}},
    2: {status: 'ready', offer: {id: '2', currentPrice: 44200}},
  };
  const posts = [];
  let unsaved = true;
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') {
      const endpoint = new URL(route.request().url()).pathname;
      posts.push([endpoint, route.request().postDataJSON()]);
      if (endpoint === '/api/portal/check') {
        if (unsaved) {
          return route.fulfill({
            status: 400, contentType: 'application/json',
            body: JSON.stringify({error: '포털에 저장 대기 중인 가격이 있습니다.'}),
          });
        }
        state.results[1].status = 'scheduled';
      } else {
        assert.equal(endpoint, '/api/portal/stage');
        assert.equal(state.results[1].status, 'scheduled');
        state.results[2].status = 'pending';
        state.message = '001235 · 포털 입력 완료';
      }
    }
    await respond(route, state);
  });
  const check = page.getByRole('button', {name: '입력 상태 확인'});
  const next = page.locator('[data-action="stage"][data-line="2"]');
  const date = page.locator('#schedule-date');
  const hour = page.locator('#schedule-hour');
  await check.waitFor();
  await date.fill('2099-02-03');
  await hour.selectOption('17');
  await page.locator('#result-filter').selectOption('ready');
  assert.equal(await next.isEnabled(), true);
  assert.equal(await page.locator('#run-prices').isDisabled(), true);
  await next.click();
  await page.getByText('포털에 저장 대기 중인 가격이 있습니다.', {exact: true}).waitFor();
  assert.deepEqual(posts, [['/api/portal/check', {mode: 'restore'}]]);
  unsaved = false;
  await next.click();
  await page.waitForFunction(() => document.querySelector('#status-message').textContent.includes('001235'));
  assert.equal(await page.locator('#result-filter').inputValue(), 'ready');
  assert.equal(await date.inputValue(), '2099-02-03');
  assert.equal(await hour.inputValue(), '17');
  assert.deepEqual(posts, [
    ['/api/portal/check', {mode: 'restore'}],
    ['/api/portal/check', {mode: 'restore'}],
    ['/api/portal/stage', {line: 2, mode: 'restore', date: '2099-02-03', hour: '17'}],
  ]);
});

test('unsaved portal input or uncertain saves block price edits and execution until read-only lookup resolves them', async t => {
  const state = fixtureState();
  state.plan.rows.push({line: 2, originalCode: '01001235', code: '001235', currentPrice: 49800, newPrice: 44200});
  state.results = {
    1: {status: 'pending', message: '포털 저장 확인 필요'},
    2: {status: 'error', needsReview: true, message: '저장 응답 확인 필요'},
  };
  const mutations = [];
  const page = await openFixture(t, async route => {
    if (route.request().method() === 'POST') {
      mutations.push(new URL(route.request().url()).pathname);
      state.results = {};
      state.message = '포털 입력 결과 확인 완료';
    }
    await respond(route, state);
  });
  await page.waitForFunction(() => !document.querySelector('#check-prices').disabled);
  assert.equal(await page.locator('[data-action="edit-price"]:disabled').count(), 2);
  assert.equal(await page.locator('#run-prices').isDisabled(), true);
  assert.equal(await page.locator('#check-and-run-prices').isDisabled(), true);
  await page.locator('[data-action="edit-price"]').first().dispatchEvent('click');
  assert.equal(await page.locator('#price-edit-dialog').isVisible(), false);
  assert.deepEqual(mutations, []);
  await page.locator('#check-prices').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="edit-price"]').disabled);
  await page.locator('[data-action="edit-price"]').first().click();
  assert.equal(await page.locator('#price-edit-dialog').isVisible(), true);
  await page.locator('#price-edit-value').press('Escape');
  assert.deepEqual(mutations, ['/api/portal/check']);
});
