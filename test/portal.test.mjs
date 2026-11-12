import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { chromium } from 'playwright';

const portalFile = new URL('../portal.mjs', import.meta.url);
const ledgerFile = new URL('../ledger.mjs', import.meta.url).href;
const source = (await readFile(portalFile, 'utf8'))
  .replace("'./ledger.mjs'", JSON.stringify(ledgerFile))
  .replace("const { chromium } = await import('playwright');", 'const chromium = testChromium;');
const helpers = source + '\nexport { hasUnsubmittedDraft, hasSavedSchedule, waitForQueryResult, savePrice, matchesConfirmedDraft };' +
  '\nlet testChromium; export function setTestChromium(value) { testChromium = value; }';
const { hasUnsubmittedDraft, hasSavedSchedule, waitForQueryResult, savePrice, matchesConfirmedDraft, openPortal, setTestChromium } =
  await import('data:text/javascript;base64,' + Buffer.from(helpers).toString('base64'));

const offer = {
  code: '123456', id: 'product-1', style: '123456', channel: '롯데ON', store: '동탄점',
  currentPrice: 20000, stagedPrice: '15,000', selected: true, checkboxId: 'selected-product',
  scheduledStatus: '', scheduledPrice: '', scheduledDate: '', scheduledHour: '', scheduledMargin: '',
};

function snapshotOf(row) {
  const values = Object.fromEntries(Array.from({ length: 55 }, (_, index) => [index, '']));
  Object.assign(values, { 5: row.store, 8: row.channel, 18: row.scheduledHour, 19: row.name ?? '',
    20: row.style, 21: row.id, 23: String(row.currentPrice), 24: row.stagedPrice,
    34: row.scheduledStatus, 35: row.scheduledPrice, 37: row.scheduledMargin, 38: row.scheduledDate,
    53: row.portalSuccess ?? '', 54: row.portalResult ?? '' });
  return { cells: { '0:0': { prefix: '', values, selected: row.selected } },
    headers: { 1: '상품코드', 2: '판매가', 3: '스타일' } };
}

test('opening the official portal selects Giordano by default and honors a local common-item setting', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'price-portal-login-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registrar = path.join(root, 'registrar fixture');
  const profile = path.join(root, 'chrome-profile');
  await mkdir(registrar);
  await writeFile(path.join(registrar, 'browser-login-store.mjs'),
    'export function createBrowserLoginStore(dataRoot) { return { dataRoot }; }');
  await writeFile(path.join(registrar, 'browser-login.mjs'),
    'export function tryLotteLogin(page, options) { return page.recordLogin(options); }');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const portalUrl = 'https://together.lotteshopping.com/EMDV3/index.html';
  const frame = 'mainframe_WorkFrame_OCPIPMOnlnRgstPrdcInqM_2_88';
  await page.route(portalUrl, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
    <style>.notice { position: fixed; inset: 0; background: white; }</style>
    <button id="portal_form_men_TopMenu_6001268" hidden>온라인 채널연계</button>
    <button id="portal_form_div_LeftMenu_div_LeftMenu_btn_Left6001278" hidden>상품관리</button>
    <div id="undefined_pdv_LeftMenu_div_LeftMenu" hidden>
      <button id="undefined_pdv_LeftMenu_div_LeftMenu_btn_Left6001278">상품관리</button>
      <button id="prices" hidden>가격관리</button>
    </div>
    <section id="price-screen" hidden>
      <input id="${frame}_form_div_Work_div_Search_edt_prdcNm_input">
      <input id="${frame}_form_div_Work_div_Search_cbo_prdcCdCl_comboedit_input" value="사용자 설정">
      <input id="${frame}_form_div_Work_div_Search_div_itmno_edt_Code_input">
      <input id="${frame}_form_div_Work_div_Search_div_itmno_edt_Name_input" readonly>
      <button id="${frame}_form_div_Work_div_Search_div_itmno_btn_CommPopup">공통품번 찾기</button>
      <div id="${frame}_form_div_Work_div_Data_grd_Master">
        <span id="grid_head_gridrow_-1_cell_-1_1">상품코드</span>
        <span id="grid_head_gridrow_-1_cell_-1_2">판매가</span>
        <span id="grid_head_gridrow_-1_cell_-1_3">스타일</span>
      </div>
    </section>
    <section id="common-item-popup" class="notice" hidden>
      <input id="${frame}_commPopup_form_div_Search_edt_itmno_input">
      <button id="${frame}_commPopup_form_btn_Search">조회</button>
      <div id="common-item-result" hidden>
        <span id="${frame}_commPopup_form_div_Data_grd_List_body_gridrow_0_cell_0_0">654321</span>
        <button id="${frame}_commPopup_form_div_Data_grd_List_body_gridrow_0_cell_0_1">지오다노</button>
        <span id="${frame}_commPopup_form_div_Data_grd_List_body_gridrow_1_cell_1_0">123456</span>
        <button id="${frame}_commPopup_form_div_Data_grd_List_body_gridrow_1_cell_1_1">지오다노 키즈</button>
      </div>
      <button id="${frame}_commPopup_form_btn_Confirm" disabled>확인</button>
    </section>
    <div class="notice" id="loading" hidden></div>
    <div class="notice" id="notice-1" hidden>
      <button id="portal_loginOpenPopup_1_titlebar_closebutton">닫기</button>
      <button>오늘 하루 그만보기</button>
    </div>
    <div class="notice" id="notice-2" hidden>
      <button id="portal_loginOpenPopup_2_titlebar_closebutton">닫기</button>
      <button>오늘 하루 그만보기</button>
    </div>
    <script>
      window.actions = [];
      function click(id, action) {
        document.getElementById(id).onclick = () => { actions.push(id); action(); };
      }
      for (const id of [1, 2]) {
        click('portal_loginOpenPopup_' + id + '_titlebar_closebutton',
          () => document.getElementById('notice-' + id).hidden = true);
      }
      click('portal_form_men_TopMenu_6001268', () => document.getElementById('undefined_pdv_LeftMenu_div_LeftMenu').hidden = false);
      click('undefined_pdv_LeftMenu_div_LeftMenu_btn_Left6001278', () => document.getElementById('prices').hidden = false);
      click('prices', () => document.getElementById('price-screen').hidden = false);
      click('${frame}_form_div_Work_div_Search_div_itmno_btn_CommPopup',
        () => document.getElementById('common-item-popup').hidden = false);
      click('${frame}_commPopup_form_btn_Search', () => document.getElementById('common-item-result').hidden = false);
      const confirm = document.getElementById('${frame}_commPopup_form_btn_Confirm');
      let selection;
      for (const row of [0, 1]) {
        const prefix = '${frame}_commPopup_form_div_Data_grd_List_body_gridrow_' + row + '_cell_' + row + '_';
        click(prefix + '1', () => {
          selection = [0, 1].map(column => document.getElementById(prefix + column).textContent);
          confirm.disabled = false;
        });
      }
      click(confirm.id, () => {
        document.getElementById('${frame}_form_div_Work_div_Search_div_itmno_edt_Code_input').value = selection[0];
        document.getElementById('${frame}_form_div_Work_div_Search_div_itmno_edt_Name_input').value = selection[1];
        document.getElementById('common-item-popup').hidden = true;
        document.getElementById('common-item-result').hidden = true;
        confirm.disabled = true;
      });
    </script>` }));
  await page.goto(portalUrl);

  const attempts = [];
  let launched = 0;
  page.recordLogin = async ({ store, waitForForm }) => {
    attempts.push({ dataRoot: store.dataRoot, waitForForm });
    if (attempts.length > 1) return { status: 'session' };
    await page.evaluate(() => {
      document.getElementById('portal_form_men_TopMenu_6001268').hidden = false;
      document.getElementById('loading').hidden = false;
      setTimeout(() => {
        document.getElementById('loading').hidden = true;
        document.getElementById('notice-1').hidden = false;
        document.getElementById('notice-2').hidden = false;
      }, 1550);
    });
    return { status: 'authenticated' };
  };
  setTestChromium({ async launchPersistentContext(directory) {
    assert.equal(directory, profile);
    launched += 1;
    return context;
  } });

  const portal = openPortal(profile);
  assert.deepEqual(await portal.open(), { status: 'unconfigured' });
  assert.deepEqual(attempts, []);
  await writeFile(path.join(root, 'registrar-login-root.txt'), registrar);
  assert.deepEqual(await portal.open(), { status: 'ready', commonItemName: '지오다노' });
  assert.deepEqual(attempts, [{ dataRoot: path.join(registrar, 'data'), waitForForm: true }]);
  const selectionActions = row => [
    frame + '_form_div_Work_div_Search_div_itmno_btn_CommPopup',
    frame + '_commPopup_form_btn_Search',
    frame + '_commPopup_form_div_Data_grd_List_body_gridrow_' + row + '_cell_' + row + '_1',
    frame + '_commPopup_form_btn_Confirm',
  ];
  const actions = [
    'portal_loginOpenPopup_2_titlebar_closebutton',
    'portal_loginOpenPopup_1_titlebar_closebutton',
    'portal_form_men_TopMenu_6001268',
    'undefined_pdv_LeftMenu_div_LeftMenu_btn_Left6001278',
    'prices',
    ...selectionActions(0),
  ];
  assert.deepEqual(await page.evaluate(() => window.actions), actions);
  assert.equal(await page.locator('#price-screen').isVisible(), true);
  assert.equal(await page.locator('[id$="_div_itmno_edt_Code_input"]').inputValue(), '654321');
  await assert.rejects(portal.ensureSearch(), /상품코드구분을 -전체-/);

  const settings = path.join(root, 'portal-common-item.json');
  await assert.rejects(readFile(settings), { code: 'ENOENT' });
  await writeFile(settings, JSON.stringify({ code: '123456', name: '지오다노 키즈' }));
  assert.deepEqual(await portal.open(), { status: 'ready', commonItemName: '지오다노 키즈' });
  const actionsWithItem = [...actions, ...selectionActions(1)];
  assert.deepEqual(await page.evaluate(() => window.actions), actionsWithItem);
  assert.equal(await page.locator('#common-item-popup').isVisible(), false);
  assert.deepEqual(await portal.open(), { status: 'ready', commonItemName: '지오다노 키즈' });
  assert.deepEqual(await page.evaluate(() => window.actions), actionsWithItem);
  assert.equal(launched, 1);
  await writeFile(path.join(root, 'registrar-login-root.txt'), 'relative-path');
  assert.deepEqual(await portal.open(), { status: 'unavailable' });
  assert.equal(attempts.length, 3);
});

test('saved or already-current values do not masquerade as unsaved drafts', () => {
  assert.equal(hasUnsubmittedDraft({ ...offer, currentPrice: 15000 }), false);
  assert.equal(hasUnsubmittedDraft({ ...offer, scheduledStatus: '진행 중', scheduledPrice: '15,000' }), false);
  assert.equal(hasUnsubmittedDraft({ ...offer, scheduledStatus: '진행 중', scheduledPrice: '14,000' }), true);
  assert.equal(hasUnsubmittedDraft({ ...offer, scheduledStatus: '신청취소', scheduledPrice: '15,000' }), true);
  assert.equal(hasUnsubmittedDraft(offer), true);
  assert.equal(hasUnsubmittedDraft({ ...offer, portalSuccess: 'N',
    portalResult: '이미 등록한 판매가변경이 승인완료후 적용전 상태입니다.' }), false);
});

test('saved schedule verification accepts portal hour and margin formatting', () => {
  const saved = { ...offer, scheduledStatus: '변경 예정', scheduledPrice: '15,000',
    scheduledDate: '2099-01-02', scheduledHour: '9:00', scheduledMargin: '34.0%' };
  assert.equal(hasSavedSchedule(saved, offer, 15000, '2099-01-02', '09'), true);
  assert.equal(hasSavedSchedule({ ...saved, scheduledStatus: '완료', scheduledDate: '2099-01-02 09:00:00',
    scheduledHour: '' }, offer, 15000, '2099-01-02', '09'), true);
  assert.equal(hasSavedSchedule({ ...saved, scheduledHour: '0900' }, offer, 15000, '2099-01-02', '09'), true);
  assert.equal(hasSavedSchedule({ ...saved, scheduledDate: '209901020930' }, offer, 15000, '2099-01-02', '09'), false);
  assert.equal(hasSavedSchedule({ ...saved, scheduledHour: '10시' }, offer, 15000, '2099-01-02', '09'), false);
  assert.equal(hasSavedSchedule({ ...saved, scheduledMargin: '35' }, offer, 15000, '2099-01-02', '09'), false);
  assert.equal(hasSavedSchedule({ ...saved, id: 'other' }, offer, 15000, '2099-01-02', '09'), false);
});

function request(body, status = 200) {
  return {
    resourceType: () => 'xhr', url: () => 'https://together.lotteshopping.com/query',
    postData: () => body, response: async () => ({ ok: () => status < 400, status: () => status }),
  };
}

function queryPage(onClick) {
  const page = new EventEmitter();
  page.locator = () => ({ filter: () => ({ click: () => onClick(page) }) });
  return page;
}

test('unchanged repeated results are accepted after the matching successful response', async () => {
  const page = queryPage(async current => {
    const search = request('PRDC_NM=123456');
    current.emit('request', search);
    current.emit('requestfinished', search);
  });
  await waitForQueryResult(page, { evaluate: async () => 0 }, '123456');
  assert.equal(page.listenerCount('request'), 0);
});

test('an unrelated response cannot finish a search while its request is pending', async () => {
  let searchFinished = false;
  const page = queryPage(async current => {
    const heartbeat = request('heartbeat');
    const search = request('PRDC_NM=123456');
    current.emit('request', heartbeat);
    current.emit('request', search);
    current.emit('requestfinished', heartbeat);
    setTimeout(() => {
      searchFinished = true;
      current.emit('requestfinished', search);
    }, 400);
  });
  await waitForQueryResult(page, { evaluate: async () => Date.now() - 1000 }, '123456');
  assert.equal(searchFinished, true);
});

test('HTTP errors never validate stale results', async () => {
  const page = queryPage(async current => {
    const search = request('PRDC_NM=123456', 500);
    current.emit('request', search);
    current.emit('requestfinished', search);
  });
  await assert.rejects(waitForQueryResult(page, { evaluate: async () => 0 }, '123456'), /조회 응답 오류/);
  assert.equal(page.listenerCount('requestfinished'), 0);
});

function savingPage(notice) {
  const page = new EventEmitter();
  const counters = { saveClicks: 0, accepted: 0, dismissed: 0, acknowledged: 0 };
  let saved = false;
  let successVisible = false;
  const scheduled = () => ({ ...offer, scheduledStatus: '변경 예정', scheduledPrice: '15,000',
    scheduledDate: '2099-01-02', scheduledHour: '09시', scheduledMargin: '34' });
  const rejected = () => ({ ...offer, portalSuccess: 'N',
    portalResult: '이미 등록한 판매가변경이 승인완료후 적용전 상태입니다.' });
  const grid = { count: async () => 1,
    evaluate: async () => snapshotOf(saved ? notice === 'partial' ? rejected() : scheduled() : { ...offer }) };
  const saveButton = {
    count: async () => 1,
    click: async () => {
      counters.saveClicks += 1;
      if (['dom', 'official', 'partial'].includes(notice)) { saved = true; successVisible = true; return; }
      const dialog = { type: () => 'alert',
        message: () => notice === 'native' ? '정상적으로 저장 되었습니다.' : '처리 결과를 확인하세요.',
        accept: async () => { counters.accepted += 1; saved = true; },
        dismiss: async () => { counters.dismissed += 1; },
      };
      page.emit('dialog', dialog);
      await new Promise(resolve => setImmediate(resolve));
    },
  };
  const filtered = value => ({ filter: () => value });
  page.locator = selector => {
    if (selector.includes('sta_TotalTextBoxElement')) return filtered({ innerText: async () => '총 1건' });
    if (selector.includes('_grd_Master')) return filtered(grid);
    return filtered({ getByText: () => filtered(saveButton) });
  };
  page.getByText = text => {
    if (text === '확인') return filtered({ count: async () => successVisible ? 1 : 0,
      click: async () => { successVisible = false; counters.acknowledged += 1; } });
    const noticeText = notice === 'partial'
      ? '저장하신 데이터 중 일부 오류 데이터가 존재합니다. 판매가 변경 적용 결과 필드에서 내용을 확인해주세요.'
      : notice === 'official' ? '판매가/마진 일괄 적용 정보 저장완료되었습니다.' : '저장되었습니다.';
    return filtered({ count: async () => successVisible && text.test(noticeText) ? 1 : 0 });
  };
  return { page, counters };
}

test('a normal native success alert completes once verified', async () => {
  const { page, counters } = savingPage('native');
  const result = await savePrice(page, offer, 15000, '2099-01-02', '09');
  assert.equal(result.submissionConfirmed, true);
  assert.equal(counters.saveClicks, 1);
  assert.equal(counters.accepted, 1);
  assert.equal(page.listenerCount('dialog'), 0);
});

test('a DOM success notice is acknowledged before moving to the next product', async () => {
  const { page, counters } = savingPage('dom');
  await savePrice(page, offer, 15000, '2099-01-02', '09');
  assert.equal(counters.acknowledged, 1);
  assert.equal(counters.saveClicks, 1);
});

test('the official save notice completes immediately after acknowledgement', async () => {
  const { page, counters } = savingPage('official');
  const result = await savePrice(page, offer, 15000, '2099-01-02', '09');
  assert.equal(result.submissionConfirmed, true);
  assert.equal(counters.acknowledged, 1);
  assert.equal(counters.saveClicks, 1);
});

test('only an explicitly confirmed matching draft can be cleared by the next query', () => {
  const receipt = { offer, targetPrice: 15000, date: '2099-01-02', hour: '09' };
  const leftover = { ...offer, stagedDate: '20990102', stagedHour: '09', selected: false,
    scheduledStatus: '완료', scheduledPrice: '', scheduledDate: '' };
  assert.equal(matchesConfirmedDraft(leftover, receipt), true);
  assert.equal(matchesConfirmedDraft(leftover, undefined), false);
  assert.equal(matchesConfirmedDraft({ ...leftover, id: 'other' }, receipt), false);
  assert.equal(matchesConfirmedDraft({ ...leftover, stagedPrice: '14,000' }, receipt), false);
  assert.equal(matchesConfirmedDraft({ ...leftover, stagedDate: '20990103' }, receipt), false);
  assert.equal(matchesConfirmedDraft({ ...leftover, stagedHour: '10' }, receipt), false);
});

test('an unknown post-save notice is marked uncertain and never retried', async () => {
  const { page, counters } = savingPage('unknown');
  await assert.rejects(savePrice(page, offer, 15000, '2099-01-02', '09'), error =>
    error.needsReview === true && error.saveAttempted === true && /처리 결과/.test(error.message));
  assert.equal(counters.saveClicks, 1);
  assert.equal(counters.dismissed, 1);
});

test('the portal already-approved rejection is acknowledged and skipped without uncertainty', async () => {
  const { page, counters } = savingPage('partial');
  await assert.rejects(savePrice(page, offer, 15000, '2099-01-02', '09'), error =>
    error.code === 'OFFER_PENDING' && error.progress.status === 'pending_change' && error.needsReview === false);
  assert.equal(counters.acknowledged, 1);
  assert.equal(counters.saveClicks, 1);
});

function portalWithOffer(currentOffer, { closeDuringLookup = false } = {}) {
  let mutations = 0;
  let closed = false;
  const page = new EventEmitter();
  page.isClosed = () => closed;
  page.url = () => 'https://together.lotteshopping.com/EMDV3/index.html';
  page.setDefaultTimeout = () => {};
  page.bringToFront = async () => {};
  page.getByText = () => ({ filter: () => ({ count: async () => 0 }) });
  page.locator = selector => ({ filter: () => {
    if (selector.includes('edt_prdcNm_input')) return {
      count: async () => 1,
      inputValue: async () => '123456',
      fill: async () => {
        if (closeDuringLookup) {
          closed = true;
          throw new Error('locator.fill: Target page, context or browser has been closed');
        }
      },
    };
    if (selector.includes('cbo_prdcCdCl_comboedit_input')) return { inputValue: async () => '-전체-' };
    if (selector.includes('sta_TotalTextBoxElement')) return { innerText: async () => '총 1건' };
    if (selector.includes('_grd_Master')) return { count: async () => 1, evaluate: async () => snapshotOf(currentOffer) };
    return { click: async () => { mutations += 1; throw new Error('Unexpected mutation'); } };
  } });
  const context = new EventEmitter();
  context.pages = () => [page];
  context.close = async () => context.emit('close');
  setTestChromium({ launchPersistentContext: async () => context });
  return { portal: openPortal('unused-test-profile'), mutations: () => mutations };
}

test('closing the portal during lookup reports how to reconnect', async () => {
  const { portal } = portalWithOffer({ ...offer, stagedPrice: '' }, { closeDuringLookup: true });
  await portal.open();
  await assert.rejects(portal.query('123456'),
    error => error.code === 'PORTAL_SCREEN' && /크롬 로그인 창을 다시 열고 현재가/.test(error.message));
  await portal.close();
});

test('stage skips a price applied after lookup before editing any portal fields', async () => {
  const { portal, mutations } = portalWithOffer({ ...offer, currentPrice: 15000 });
  await portal.open();
  await assert.rejects(portal.stage(offer, 20000, 15000, '2099-01-02', '09', { save: true, reuseSearch: true }),
    error => error.code === 'OFFER_ALREADY' && error.progress.status === 'already' && error.saveAttempted === false);
  assert.equal(mutations(), 0);
  await portal.close();
});

test('stage skips a matching in-progress change before editing any portal fields', async () => {
  const { portal, mutations } = portalWithOffer({ ...offer, scheduledStatus: '진행 중', scheduledPrice: '15,000' });
  await portal.open();
  await assert.rejects(portal.stage(offer, 20000, 15000, '2099-01-02', '09', { save: true, reuseSearch: true }),
    error => error.code === 'OFFER_PENDING' && error.progress.status === 'scheduled' && error.saveAttempted === false);
  assert.equal(mutations(), 0);
  await portal.close();
});

test('stage skips a different pending price without treating it as an unsaved draft', async () => {
  const { portal, mutations } = portalWithOffer({ ...offer, stagedPrice: '14,000',
    scheduledStatus: '진행 중', scheduledPrice: '14,000' });
  await portal.open();
  await assert.rejects(portal.stage(offer, 20000, 15000, '2099-01-02', '09', { save: true, reuseSearch: true }),
    error => error.code === 'OFFER_PENDING' && error.progress.status === 'pending_change' && error.saveAttempted === false);
  assert.equal(mutations(), 0);
  await portal.close();
});
