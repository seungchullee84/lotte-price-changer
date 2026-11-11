
export const PORTAL_URL = 'https://together.lotteshopping.com/EMDV3/index.html';
const portalOrigin = new URL(PORTAL_URL).origin;
const priceFrame = '[id*="_WorkFrame_OCPIPMOnlnRgstPrdcInqM_"]';
const gridSuffix = '_form_div_Work_div_Data_grd_Master';
const panelSuffix = '_form_div_Work_div_Data_div_ChgInfo_';
const detailGridSuffix = gridSuffix + '2';
const countSuffix = '_form_div_Work_div_Data_div_MasterPage_sta_TotalTextBoxElement';

function control(page, suffix) {
  return page.locator(priceFrame + '[id$="' + suffix + '"]').filter({ visible: true });
}

function panel(page, suffix) {
  return control(page, panelSuffix + suffix);
}

function screenError(message) {
  return Object.assign(new Error(message), { code: 'PORTAL_SCREEN' });
}

async function selectCombo(page, suffix, value) {
  const input = panel(page, suffix + '_comboedit_input');
  if ((await input.inputValue()).trim() === value) return;
  await panel(page, suffix + '_dropbutton').click();
  await control(page, 'itemTextBoxElement')
    .and(page.locator('[id*="' + panelSuffix + suffix + '_combolist_"]'))
    .getByText(value, { exact: true }).click();
  if ((await input.inputValue()).trim() !== value) {
    throw new Error(value + ' 선택을 확인하지 못했습니다.');
  }
}

function radioLabel(page, group, label) {
  return panel(page, group + '_itemTextBoxElement').filter({ hasText: label });
}

async function isSelectedRadio(label) {
  return label.evaluate(element => {
    const item = element.closest('[id$="_item"]');
    const indicator = item?.querySelector('[id$="radioimgImageElement"]');
    return !!indicator && getComputedStyle(indicator).visibility === 'visible';
  });
}

async function selectRadio(label, name) {
  if (await isSelectedRadio(label)) return;
  await label.scrollIntoViewIfNeeded();
  const position = await label.evaluate(element => {
    const box = element.getBoundingClientRect();
    const y = Math.floor(box.height / 2);
    // Nexacro leaves the label wide even when the amount input covers its right side.
    for (let x = 4; x < box.width - 2; x += 4) {
      const hit = document.elementFromPoint(box.left + x, box.top + y);
      if (hit && element.contains(hit)) return { x, y };
    }
    return null;
  });
  if (!position) throw new Error(name + ' 항목의 클릭 위치를 확인하지 못했습니다.');
  await label.click({ position });
  if (!await isSelectedRadio(label)) throw new Error(name + ' 선택을 확인하지 못했습니다.');
}

async function readGrid(page, suffix = gridSuffix) {
  return control(page, suffix).evaluate(grid => {
    const rows = [];
    const labels = Array.from(grid.querySelectorAll('[id*="_head_gridrow_"]'), e => e.textContent).join(' ');
    if (!labels.includes('상품코드') || !labels.includes('판매가') || !labels.includes('스타일')) {
      throw new Error('가격관리 표 구조가 달라졌습니다.');
    }
    const gridBody = document.getElementById(grid.id + '_body');
    for (const cell of gridBody.querySelectorAll('[id*="_cell_"][id$="_20"]')) {
      const found = cell.id.match(/_gridrow_(\d+)_cell_(\d+)_20$/);
      if (!found) continue;
      const prefix = grid.id + '_body_gridrow_' + found[1] + '_cell_' + found[2] + '_';
      const textAt = column => document.getElementById(prefix + column)?.textContent.trim() ?? '';
      const style = textAt(20);
      const code = style.match(/^(\d{6})(?:\s*\([^)]*\))?$/)?.[1];
      const price = textAt(23).replaceAll(',', '');
      const check = document.getElementById(prefix + '0_controlcheckbox_chkimgImageElement');
      rows.push({
        code,
        style,
        currentPrice: /^\d+$/.test(price) ? Number(price) : null,
        id: textAt(21),
        name: textAt(19),
        channel: textAt(8),
        store: textAt(5),
        scheduledStatus: textAt(34),
        scheduledPrice: textAt(35),
        scheduledMargin: textAt(37),
        scheduledDate: textAt(38),
        scheduledHour: textAt(18),
        stagedPrice: document.getElementById(prefix + '24_controledit_input')?.value.trim() || textAt(24),
        checkboxId: prefix + '0_controlcheckbox_chkimg',
        selected: Boolean(check && getComputedStyle(check).visibility === 'visible'),
      });
    }
    return rows;
  });
}

async function readDraftGrids(page) {
  const primary = await readGrid(page);
  const detail = control(page, detailGridSuffix);
  if (await detail.count() !== 1) return [primary];
  return [primary, await readGrid(page, detailGridSuffix)];
}

function displayedWon(text) {
  const digits = text.replaceAll(',', '').trim();
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

function matchIdentity(a, b) {
  return a.code === b.code && a.id === b.id && a.style === b.style &&
    a.channel === b.channel && a.store === b.store;
}

function checkDraft(grids, offer, targetPrice) {
  const drafts = grids.flatMap(rows => rows.filter(row => displayedWon(row.stagedPrice) > 0));
  if (drafts.some(row => !matchIdentity(row, offer) || displayedWon(row.stagedPrice) !== targetPrice)) {
    throw new Error('상세정보에 다른 상품 또는 다른 변경가가 표시됐습니다. 저장을 중단했습니다.');
  }
  return drafts.length > 0;
}

async function waitForStagedRow(page, offer, targetPrice) {
  const limit = Date.now() + 8000;
  do {
    if (checkDraft(await readDraftGrids(page), offer, targetPrice)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < limit);
  throw new Error('일괄 적용 후 상세정보에서 정확한 변경가를 확인하지 못했습니다. 저장을 중단했습니다.');
}

function hasSavedSchedule(row, offer, targetPrice, date, hour) {
  const validStatus = /^(?:진행\s*중|변경\s*예정|저장\s*완료|신청\s*완료|요청\s*완료|승인\s*(?:대기|요청|완료|중))$/;
  if (!matchIdentity(row, offer) || !validStatus.test(row.scheduledStatus) ||
      displayedWon(row.scheduledPrice) !== targetPrice) return false;
  const scheduled = row.scheduledDate.replace(/\D/g, '');
  const hourText = row.scheduledHour.replace(/\D/g, '');
  return scheduled.slice(0, 8) === date.replaceAll('-', '') &&
    (scheduled.slice(8, 10) || (hourText && hourText.padStart(2, '0'))) === hour &&
    displayedWon(row.scheduledMargin.replace(/%$/, '')) === 34;
}

async function acceptSaveNotice(page) {
  const confirm = page.getByText(/^\s*(?:선택한 상품을 |변경 내용을 )?저장\s*하시겠습니까\??\s*$/).filter({ visible: true });
  const success = page.getByText(/^\s*(?:정상적으로 )?저장\s*되었(?:습니다|읍니다)\.?\s*$/).filter({ visible: true });
  if (await confirm.count() !== 1 && await success.count() !== 1) return false;
  const ok = page.getByText('확인', { exact: true }).filter({ visible: true });
  if (await ok.count() !== 1) throw new Error('포털 저장 확인창을 식별하지 못했습니다. 저장 결과를 확인해 주세요.');
  await ok.click();
  return true;
}

async function savePrice(page, offer, targetPrice, date, hour) {
  async function readSaveRow() {
    const grids = await readDraftGrids(page);
    if (!checkDraft(grids, offer, targetPrice)) throw new Error('상세정보에 확인할 변경 판매가가 없습니다.');
    await checkRenderedCount(page, grids[0]);
    if (grids.flat().some(row => row.selected && !matchIdentity(row, offer))) {
      throw new Error('상세정보에 다른 상품도 체크돼 있습니다. 저장을 중단했습니다.');
    }
    const matches = grids.at(-1).filter(row => matchIdentity(row, offer));
    if (matches.length !== 1) throw new Error('상세정보에서 체크할 상품을 한 건으로 확인하지 못했습니다.');
    return matches[0];
  }
  const draft = await readSaveRow();
  if (!draft.selected) await page.locator('[id="' + draft.checkboxId + '"]').click();
  const checked = await readSaveRow();
  if (!checked.selected) {
    throw new Error('상세정보의 체크박스를 확인하지 못했습니다. 저장을 중단했습니다.');
  }
  if (Date.parse(date + 'T' + hour + ':00:00+09:00') <= Date.now()) {
    throw new Error('적용 시작 시각이 지났습니다. 다음 적용 시각을 선택해 주세요.');
  }

  const panelRoot = control(page, panelSuffix.slice(0, -1));
  const save = panelRoot.getByText('저장', { exact: true }).filter({ visible: true });
  if (await save.count() !== 1) throw new Error('가격관리 일괄 변경 영역의 저장 버튼을 확인하지 못했습니다.');

  let unexpectedDialog = false;
  const onDialog = async dialog => {
    if (dialog.type() === 'confirm' && /^\s*(?:선택한 상품을 |변경 내용을 )?저장\s*하시겠습니까\??\s*$/.test(dialog.message())) {
      await dialog.accept();
    } else {
      unexpectedDialog = true;
      await dialog.dismiss();
    }
  };
  page.on('dialog', onDialog);
  try {
    await save.click();
    const limit = Date.now() + 12000;
    do {
      if (unexpectedDialog) throw new Error('예상과 다른 포털 확인창이 표시됐습니다.');
      const verified = (await readGrid(page)).find(row => hasSavedSchedule(row, offer, targetPrice, date, hour));
      if (verified) return verified;
      await acceptSaveNotice(page);
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < limit);
    throw new Error('저장 요청 뒤 포털에서 같은 상품·가격·시각의 변경 예정 정보를 확인하지 못했습니다. 다시 저장하기 전에 포털을 확인해 주세요.');
  } finally {
    page.off('dialog', onDialog);
  }
}

async function checkRenderedCount(page, rows) {
  const footer = (await control(page, countSuffix).innerText()).trim();
  const counts = footer.match(/^총\s*([\d,]+)(?:\s*\/\s*([\d,]+))?\s*건$/);
  if (!counts || counts.slice(1).filter(Boolean).some(count => Number(count.replaceAll(',', '')) !== rows.length)) {
    throw new Error('포털 조회 결과가 여러 페이지에 있거나 화면에 모두 보이지 않습니다. 검색 결과를 확인해 주세요.');
  }
}

async function typeAmount(input, value) {
  await input.click();
  await input.press('Control+a');
  await input.pressSequentially(String(value));
  await input.press('Tab');
  if (Number((await input.inputValue()).replaceAll(',', '').trim()) !== value) {
    throw new Error('지정가판매 칸에서 입력한 금액을 확인하지 못했습니다.');
  }
}

export function openPortal(profileDirectory) {
  let context;
  let page;

  function activePage() {
    if (!page || page.isClosed()) throw screenError('먼저 포털을 열고 로그인한 뒤 가격관리 화면을 열어 주세요.');
    if (new URL(page.url()).origin !== portalOrigin) throw screenError('롯데백화점 파트너포털 화면을 열어 주세요.');
    return page;
  }

  async function ensureSearchScreen(portalPage) {
    const nameInput = control(portalPage, '_form_div_Work_div_Search_edt_prdcNm_input');
    if (await nameInput.count() !== 1) {
      throw screenError('포털에서 온라인 채널연계 → 상품 관리 → 가격관리를 열어 주세요.');
    }
    const productCodeFilter = control(portalPage, '_form_div_Work_div_Search_cbo_prdcCdCl_comboedit_input');
    if ((await productCodeFilter.inputValue()).trim() !== '-전체-') {
      throw screenError('포털의 상품코드구분을 -전체-로 선택해 주세요. 조회에는 상품명 칸을 사용합니다.');
    }
    return nameInput;
  }

  async function query(code) {
    if (!/^[0-9]{6}$/.test(code)) throw new Error('6자리 조회 품번을 확인해 주세요.');
    const portalPage = activePage();
    const nameInput = await ensureSearchScreen(portalPage);
    if ((await readDraftGrids(portalPage)).flat().some(row => displayedWon(row.stagedPrice) > 0)) {
      throw screenError('포털에 적용해 둔 가격이 있습니다. 저장하거나 취소한 뒤 다음 상품을 조회해 주세요.');
    }
    await nameInput.fill(code);
    await nameInput.press('Tab');
    if ((await nameInput.inputValue()).trim() !== code) {
      throw new Error('상품명 검색칸에서 6자리 품번을 확인하지 못했습니다.');
    }
    const grid = control(portalPage, gridSuffix);
    const watcher = await grid.evaluateHandle(element => {
      const list = element.closest('[id$="_form_div_Work_div_Data"]');
      const result = { changed: false, observer: null };
      result.observer = new MutationObserver(records => {
        result.changed ||= records.some(record => {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          return !!target?.closest('[id$="_grd_Master_body"],[id$="_div_MasterPage_sta_Total"]') ||
            Array.from(record.addedNodes).some(node => node.nodeType === 1 && node.id.endsWith('_grd_Master_body'));
        });
      });
      result.observer.observe(list, { childList: true, subtree: true, characterData: true });
      return result;
    });
    try {
      const finished = portalPage.waitForEvent('requestfinished', {
        predicate: request => ['xhr', 'fetch'].includes(request.resourceType()) &&
          new URL(request.url()).origin === portalOrigin,
        timeout: 12000,
      });
      try {
        await Promise.all([finished, control(portalPage, '_form_btn_MainTextBoxElement').click({ timeout: 5000 })]);
      } catch {
        await ensureSearchScreen(portalPage);
        throw new Error('포털 조회 완료를 확인하지 못했습니다.');
      }
      try {
        await portalPage.waitForFunction(result => result.changed, watcher, { timeout: 3000 });
      } catch {
        await ensureSearchScreen(portalPage);
        const unchanged = await readGrid(portalPage);
        await checkRenderedCount(portalPage, unchanged);
        if (!unchanged.length) return [];
        throw new Error('포털 조회 결과가 새로 표시되었는지 확인하지 못했습니다.');
      }
    } finally {
      await watcher.evaluate(result => result.observer.disconnect()).catch(() => {});
      await watcher.dispose().catch(() => {});
    }
    // Nexacro renders the updated grid when the query transaction is received.
    await control(portalPage, gridSuffix).waitFor({ state: 'visible' });
    await portalPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await ensureSearchScreen(portalPage);
    const rows = await readGrid(portalPage);
    await checkRenderedCount(portalPage, rows);
    const exact = rows.filter(row => row.code === code);
    if (exact.some(row => !row.id || !row.store || !row.channel || row.currentPrice === null)) {
      throw new Error('포털 상품의 상품코드, 점포, 채널 또는 판매가를 확인하지 못했습니다.');
    }
    return exact;
  }

  async function stage(offer, expectedPrice, targetPrice, date, hour, { save = false } = {}) {
    const portalPage = activePage();
    const offers = await query(offer.code);
    if (!offers.length) throw Object.assign(new Error('검색 결과 없음 · 건너뜀'), { code: 'OFFER_MISSING' });
    const matching = offers.filter(row => matchIdentity(row, offer) && row.currentPrice === expectedPrice);
    if (matching.length !== 1) {
      throw Object.assign(new Error('현재가 또는 상품 정보가 바뀌었습니다. 다시 조회해 주세요.'), { code: 'OFFER_CHANGED' });
    }
    const fresh = matching[0];
    if (/진행|예정|대기|요청|승인중/.test(fresh.scheduledStatus)) {
      throw new Error('이미 변경 예정 정보가 있습니다. 포털에서 예정 상태를 확인해 주세요.');
    }
    const rows = await readGrid(portalPage);
    if (rows.some(row => row.selected && row.checkboxId !== fresh.checkboxId)) {
      throw new Error('다른 상품이 선택되어 있습니다. 포털에서 선택을 확인해 주세요.');
    }
    if (!fresh.selected) await portalPage.locator('[id="' + fresh.checkboxId + '"]').click();
    const selected = (await readGrid(portalPage)).filter(row => row.selected);
    if (selected.length !== 1 || !matchIdentity(selected[0], fresh)) {
      throw new Error('포털의 상품 선택을 확인하지 못했습니다.');
    }

    const priceChange = radioLabel(portalPage, 'rdo_ChgType', /^\s*판매가변경\s*$/);
    const fixedPrice = radioLabel(portalPage, 'rdo_AmtType', /^\s*지정가판매\s*$/);
    await selectRadio(priceChange, '판매가변경');
    await selectRadio(fixedPrice, '지정가판매');
    const amount = panel(portalPage, 'msk_ChgAmt_input');
    const dateInput = panel(portalPage, 'cal_FromDt_calendaredit_input');
    const dateDigits = date.replaceAll('-', '');
    if ((await dateInput.inputValue()).replace(/\D/g, '') !== dateDigits) {
      await dateInput.click();
      await dateInput.press('Control+a');
      await dateInput.pressSequentially(dateDigits);
      await dateInput.press('Tab');
    }
    if ((await dateInput.inputValue()).replace(/\D/g, '') !== dateDigits) {
      throw new Error('포털의 적용시작일을 확인하지 못했습니다.');
    }
    await selectCombo(portalPage, 'cbo_FromH', hour + '시');
    await selectCombo(portalPage, 'cbo_NmltyEvntClCd', '정상마진');
    await selectCombo(portalPage, 'cbo_MrgnCd', '34');
    await typeAmount(amount, targetPrice);
    const currentValues = await Promise.all([
      amount.inputValue(), dateInput.inputValue(),
      panel(portalPage, 'cbo_FromH_comboedit_input').inputValue(),
      panel(portalPage, 'cbo_NmltyEvntClCd_comboedit_input').inputValue(),
      panel(portalPage, 'cbo_MrgnCd_comboedit_input').inputValue(),
    ]);
    const [enteredAmount, enteredDate, enteredHour, enteredMargin, enteredRate] = currentValues.map(value => value.trim());
    if (Number(enteredAmount.replaceAll(',', '')) !== targetPrice || enteredDate.replace(/\D/g, '') !== dateDigits ||
        enteredHour !== hour + '시' || enteredMargin !== '정상마진' || enteredRate !== '34' ||
        !await isSelectedRadio(priceChange) || !await isSelectedRadio(fixedPrice)) {
      throw new Error('포털의 금액, 적용시각 또는 마진이 입력값과 다릅니다.');
    }
    const stillSelected = (await readGrid(portalPage)).filter(row => row.selected);
    if (stillSelected.length !== 1 || !matchIdentity(stillSelected[0], fresh) || stillSelected[0].currentPrice !== expectedPrice) {
      throw new Error('일괄 적용 직전의 상품과 현재가가 조회 결과와 다릅니다.');
    }
    await panel(portalPage, 'btn_PrcChgTextBoxElement').getByText('판매가/마진 일괄 적용', { exact: true }).click();
    await waitForStagedRow(portalPage, fresh, targetPrice);
    const appliedNotice = portalPage.getByText('판매가/마진 일괄 적용 정보 저장완료되었습니다.', { exact: true }).filter({ visible: true });
    if (await appliedNotice.count() === 1) {
      const ok = portalPage.getByText('확인', { exact: true }).filter({ visible: true });
      if (await ok.count() !== 1) throw new Error('일괄 적용 알림의 확인 버튼을 식별하지 못했습니다.');
      await ok.click();
    }
    if (save) return savePrice(portalPage, fresh, targetPrice, date, hour);
    await portalPage.bringToFront();
    return fresh;
  }

  return {
    async open() {
      if (page && !page.isClosed()) {
        await page.bringToFront();
        return;
      }
      if (!context) {
        const { chromium } = await import('playwright');
        context = await chromium.launchPersistentContext(profileDirectory, {
          channel: 'chrome',
          headless: false,
          viewport: null,
        });
        context.on('close', () => { context = null; page = null; });
      }
      page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(5000);
      if (page.url() === 'about:blank') await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
    },
    async ensureSearch() { await ensureSearchScreen(activePage()); },
    query,
    stage,
    async close() { await context?.close(); },
  };
}
