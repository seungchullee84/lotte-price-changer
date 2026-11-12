import { matchIdentity, plannedChange } from './ledger.mjs';

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

async function gridSnapshot(grid) {
  return grid.evaluate(element => {
    const cells = {};
    const headers = {};
    for (const cell of element.querySelectorAll('[id*="_cell_"]')) {
      const body = cell.id.match(/_body_gridrow_(\d+)_cell_(\d+)_(\d+)$/);
      const head = cell.id.match(/_head_gridrow_-?\d+_cell_-?\d+_(\d+)$/);
      if (head && cell.textContent.trim()) headers[head[1]] = cell.textContent.trim();
      if (!body) continue;
      const key = body[1] + ':' + body[2];
      cells[key] ??= { prefix: cell.id.slice(0, -body[3].length), values: {} };
      cells[key].values[body[3]] = cell.querySelector('input')?.value.trim() || cell.textContent.trim();
      if (body[3] === '0') {
        const check = cell.querySelector('[id$="controlcheckbox_chkimgImageElement"]');
        cells[key].selected = !!check && getComputedStyle(check).visibility === 'visible';
      }
    }
    const bar = document.getElementById(element.id + '_hscrollbar');
    const thumb = document.getElementById(element.id + '_hscrollbar_trackbar');
    let scroll;
    if (bar && thumb && thumb.getBoundingClientRect().width > 0) {
      const bounds = bar.getBoundingClientRect();
      const box = thumb.getBoundingClientRect();
      const leftArrow = document.getElementById(element.id + '_hscrollbar_decbutton')?.getBoundingClientRect();
      const rightArrow = document.getElementById(element.id + '_hscrollbar_incbutton')?.getBoundingClientRect();
      const left = leftArrow?.right ?? bounds.left;
      const right = rightArrow?.left ?? bounds.right;
      scroll = { x: box.left + box.width / 2, y: box.top + box.height / 2,
        left: left + box.width / 2, right: right - box.width / 2 };
      scroll.fraction = scroll.right > scroll.left ? (scroll.x - scroll.left) / (scroll.right - scroll.left) : 0;
    }
    return { cells, headers, scroll };
  });
}

async function moveGridScrollbar(page, grid, fraction) {
  const { scroll } = await gridSnapshot(grid);
  if (!scroll || scroll.right <= scroll.left) return;
  await page.mouse.move(scroll.x, scroll.y);
  await page.mouse.down();
  try {
    await page.mouse.move(scroll.left + (scroll.right - scroll.left) * fraction, scroll.y, { steps: 8 });
  } finally {
    await page.mouse.up();
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function readGrid(page, suffix = gridSuffix) {
  const grid = control(page, suffix);
  const initial = await gridSnapshot(grid);
  const combined = { cells: {}, headers: {} };
  const merge = snapshot => {
    Object.assign(combined.headers, snapshot.headers);
    for (const [key, row] of Object.entries(snapshot.cells)) {
      combined.cells[key] ??= { prefix: row.prefix, values: {} };
      Object.assign(combined.cells[key].values, row.values);
      if (row.selected !== undefined) combined.cells[key].selected = row.selected;
    }
  };
  merge(initial);
  const required = [0, 5, 8, 19, 20, 21, 23, 24, 53, 54];
  const wanted = [...required, 34, 35, 37, 38];
  const missing = columns => Object.values(combined.cells).some(row => columns.some(column => !(column in row.values)));
  if (Object.keys(initial.cells).length && initial.scroll && missing(wanted)) {
    try {
      for (const fraction of [0, 1, 0.5]) {
        await moveGridScrollbar(page, grid, fraction);
        merge(await gridSnapshot(grid));
        if (!missing(wanted)) break;
      }
    } finally {
      await moveGridScrollbar(page, grid, initial.scroll.fraction);
    }
    const restored = await gridSnapshot(grid);
    if (Object.keys(restored.cells).length !== Object.keys(initial.cells).length ||
        Object.entries(initial.cells).some(([key, row]) => !restored.cells[key] ||
          [5, 8, 20, 21, 23].some(column => row.values[column] !== undefined &&
            restored.cells[key].values[column] !== undefined && row.values[column] !== restored.cells[key].values[column]))) {
      throw screenError('변경 정보를 읽는 동안 포털 상품 목록이 바뀌었습니다. 다시 조회해 주세요.');
    }
  }
  const labels = Object.values(combined.headers).join(' ');
  if (!labels.includes('상품코드') || !labels.includes('판매가') || !labels.includes('스타일')) {
    throw screenError('가격관리 표 구조가 달라졌습니다.');
  }
  if (missing(required)) throw screenError('가격관리 표의 오른쪽 변경 정보를 읽지 못했습니다. 가로 스크롤을 확인해 주세요.');
  return Object.values(combined.cells).map(row => {
    const textAt = column => row.values[column] ?? '';
    const style = textAt(20);
    const price = textAt(23).replaceAll(',', '');
    return {
      code: style.match(/^(\d{6})(?:\s*\([^)]*\))?$/)?.[1], style,
      currentPrice: /^\d+$/.test(price) ? Number(price) : null,
      id: textAt(21), name: textAt(19), channel: textAt(8), store: textAt(5),
      scheduledStatus: textAt(34), scheduledPrice: textAt(35), scheduledMargin: textAt(37),
      scheduledDate: textAt(38), scheduledHour: textAt(18), stagedPrice: textAt(24),
      stagedDate: textAt(17), stagedHour: textAt(18),
      portalSuccess: textAt(53), portalResult: textAt(54),
      checkboxId: row.prefix + '0_controlcheckbox_chkimg', selected: !!row.selected,
    };
  });
}

async function readDraftGrids(page) {
  const primary = await readGrid(page);
  const detail = control(page, detailGridSuffix);
  if (await detail.count() !== 1) return [primary];
  return [primary, await readGrid(page, detailGridSuffix)];
}

function displayedWon(text) {
  const digits = String(text ?? '').replaceAll(',', '').trim().replace(/\s*원$/, '');
  const amount = Number(digits);
  return /^\d+$/.test(digits) && Number.isSafeInteger(amount) ? amount : null;
}

function hasUnsubmittedDraft(row) {
  const stagedPrice = displayedWon(row.stagedPrice);
  if (!(stagedPrice > 0)) return false;
  const progress = plannedChange(row, stagedPrice);
  if (progress?.status === 'pending_change' && row.portalSuccess === 'N' &&
      /이미.*판매가변경.*승인완료.*적용전/.test((row.portalResult ?? '').replace(/\s/g, ''))) return false;
  return !progress || progress.status === 'pending_change';
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
  const validStatus = /^(?:완료|진행\s*중|변경\s*예정|저장\s*완료|신청\s*완료|요청\s*완료|승인\s*(?:대기|요청|완료|중))$/;
  if (!matchIdentity(row, offer) || !validStatus.test(row.scheduledStatus.trim()) ||
      displayedWon(row.scheduledPrice) !== targetPrice) return false;
  const scheduled = row.scheduledDate.replace(/\D/g, '');
  const hourText = row.scheduledHour.replace(/\s/g, '').match(/^(\d{1,2})(?:시(?:00분)?|:00(?::00)?|00(?:00)?)?$/)?.[1];
  return scheduled.slice(0, 8) === date.replaceAll('-', '') &&
    [8, 10, 12, 14].includes(scheduled.length) && !/[1-9]/.test(scheduled.slice(10)) &&
    (scheduled.slice(8, 10) || (hourText && hourText.padStart(2, '0'))) === hour &&
    Number(row.scheduledMargin.replace(/%$/, '').trim()) === 34;
}

const saveConfirmation = /^\s*(?:선택한 상품을 |변경 내용을 )?저장\s*하시겠습니까\??\s*$/;
const saveSuccess = /^\s*(?:(?:정상적으로 )?저장\s*되었(?:습니다|읍니다)|판매가\/마진\s*일괄\s*적용\s*정보\s*저장완료되었습니다)\.?\s*$/;
const savePartial = /저장하신\s*데이터\s*중\s*일부\s*오류\s*데이터가\s*존재합니다/;

async function acceptSaveNotice(page, allowConfirmation = true) {
  const confirm = page.getByText(saveConfirmation).filter({ visible: true });
  const success = page.getByText(saveSuccess).filter({ visible: true });
  const partial = page.getByText(savePartial).filter({ visible: true });
  const hasPartial = await partial.count() === 1;
  const hasSuccess = await success.count() === 1;
  if ((!allowConfirmation || await confirm.count() !== 1) && !hasSuccess && !hasPartial) return false;
  let ok = page.getByText('확인', { exact: true }).filter({ visible: true });
  if (await ok.count() !== 1) {
    const notice = hasPartial ? partial : await success.count() === 1 ? success : confirm;
    ok = notice.locator('xpath=ancestor::*[descendant::*[normalize-space(text())="확인"]][1]')
      .getByText('확인', { exact: true }).filter({ visible: true });
  }
  if (await ok.count() !== 1) throw new Error('포털 저장 확인창을 식별하지 못했습니다. 저장 결과를 확인해 주세요.');
  await ok.click();
  return hasPartial ? 'partial' : hasSuccess ? 'success' : 'confirm';
}

function matchesConfirmedDraft(row, receipt) {
  if (!receipt || !matchIdentity(row, receipt.offer) || displayedWon(row.stagedPrice) !== receipt.targetPrice) return false;
  if (row.stagedDate && row.stagedDate.replace(/\D/g, '').slice(0, 8) !== receipt.date.replaceAll('-', '')) return false;
  const hour = row.stagedHour?.match(/\d{1,2}/)?.[0].padStart(2, '0');
  return !hour || hour === receipt.hour;
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

  let dialogError;
  let successNotice = false;
  const saveRequests = new Set();
  const onRequest = request => {
    if (!['xhr', 'fetch'].includes(request.resourceType()) || new URL(request.url()).origin !== portalOrigin) return;
    const body = request.postData() ?? '';
    if (body.includes(offer.id) || body.includes(offer.code)) saveRequests.add(request);
  };
  const onFinished = async request => {
    if (!saveRequests.delete(request)) return;
    try {
      const response = await request.response();
      if (!response?.ok()) dialogError = new Error('포털 저장 응답 오류 · ' + (response?.status() ?? '연결 종료'));
    } catch (error) { dialogError = error; }
  };
  const onDialog = async dialog => {
    try {
      if ((dialog.type() === 'confirm' && saveConfirmation.test(dialog.message())) ||
          (dialog.type() === 'alert' && (saveSuccess.test(dialog.message()) || savePartial.test(dialog.message())))) {
        await dialog.accept();
        if (dialog.type() === 'alert') {
          successNotice ||= saveSuccess.test(dialog.message());
        }
      } else {
        dialogError = new Error('포털 안내 · ' + dialog.message());
        await dialog.dismiss();
      }
    } catch (error) {
      dialogError = error;
    }
  };
  page.on('dialog', onDialog);
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  try {
    await save.click();
    const limit = Date.now() + 12000;
    do {
      if (dialogError) throw dialogError;
      const notice = await acceptSaveNotice(page);
      successNotice ||= notice === 'success';
      if (successNotice) return { ...offer, submissionConfirmed: true };
      const savedRows = await readGrid(page);
      const current = savedRows.find(row => matchIdentity(row, offer));
      const verified = savedRows.find(row => hasSavedSchedule(row, offer, targetPrice, date, hour));
      if (verified) return verified;
      const rejected = current;
      if (rejected?.portalResult && /오류|실패|불가|불가능|이미|진행\s*중|적용\s*중/.test(rejected.portalResult)) {
        const progress = plannedChange(rejected, targetPrice);
        if (progress) {
          throw Object.assign(new Error(progress.message), { code: progress.status === 'already' ? 'OFFER_ALREADY' : 'OFFER_PENDING',
            offer: rejected, progress });
        }
        throw new Error('포털 적용 결과 · ' + rejected.portalResult);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < limit);
    throw new Error('저장 요청 뒤 포털에서 같은 상품·가격·시각의 변경 예정 정보를 확인하지 못했습니다. 다시 저장하기 전에 포털을 확인해 주세요.');
  } catch (error) {
    error.saveAttempted = true;
    error.needsReview = !['OFFER_ALREADY', 'OFFER_PENDING'].includes(error.code);
    throw error;
  } finally {
    page.off('dialog', onDialog);
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
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

async function waitForQueryResult(page, watcher, code) {
  const pending = new Set();
  let completed = 0;
  let confirmedCode = false;
  let lastResponseAt = 0;
  let queryError;
  const isPortalRequest = request => ['xhr', 'fetch'].includes(request.resourceType()) &&
    new URL(request.url()).origin === portalOrigin;
  const includesCode = request => (request.url() + ' ' + (request.postData() ?? '')).includes(code);
  const onRequest = request => { if (isPortalRequest(request)) pending.add(request); };
  const onFinished = async request => {
    if (!pending.has(request)) return;
    try {
      const response = await request.response();
      if (!response?.ok()) {
        queryError = new Error('포털 조회 응답 오류 · ' + (response?.status() ?? '연결 종료'));
      } else {
        completed += 1;
        confirmedCode ||= includesCode(request);
      }
    } catch (error) {
      queryError = error;
    } finally {
      lastResponseAt = Date.now();
      pending.delete(request);
    }
  };
  const onFailed = request => {
    if (!pending.delete(request)) return;
    queryError = new Error('포털 조회 연결이 끊겼습니다. 현재가 조회를 다시 실행해 주세요.');
  };
  page.on('request', onRequest);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  try {
    await control(page, '_form_btn_MainTextBoxElement').click({ timeout: 5000 });
    const limit = Date.now() + 12000;
    do {
      if (queryError) throw queryError;
      const lastChange = await watcher.evaluate(result => result.lastChange);
      if (completed > 0 && pending.size === 0 && Date.now() - lastResponseAt >= 250 &&
          (lastChange || confirmedCode) && (!lastChange || Date.now() - lastChange >= 250)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < limit);
    throw new Error('포털 조회 완료를 확인하지 못했습니다. 현재가 조회를 다시 실행해 주세요.');
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
  }
}

export function openPortal(profileDirectory) {
  let context;
  let page;
  let confirmedSubmission;

  function hasBlockingDraft(row) {
    return hasUnsubmittedDraft(row) && !matchesConfirmedDraft(row, confirmedSubmission);
  }

  function activePage() {
    if (!page || page.isClosed() || !page.url().startsWith(portalOrigin + '/')) {
      page = context?.pages().findLast(candidate => !candidate.isClosed() &&
        candidate.url().startsWith(portalOrigin + '/'));
      page?.setDefaultTimeout(5000);
    }
    if (!page || page.isClosed()) throw screenError('먼저 포털을 열고 로그인한 뒤 가격관리 화면을 열어 주세요.');
    if (new URL(page.url()).origin !== portalOrigin) throw screenError('롯데백화점 파트너포털 화면을 열어 주세요.');
    return page;
  }

  async function ensureSearchScreen(portalPage) {
    const nameInput = control(portalPage, '_form_div_Work_div_Search_edt_prdcNm_input');
    if (await nameInput.count() !== 1) {
      const onlineMenu = portalPage.locator('[id$="_form_men_TopMenu_6001268"]').filter({ visible: true });
      if (await onlineMenu.count() !== 1) {
        throw screenError('포털에 로그인한 뒤 가격관리를 열어 주세요.');
      }
      try {
        await onlineMenu.click();
        const products = portalPage.locator('[id$="_form_div_LeftMenu_div_LeftMenu_btn_Left6001278"]').filter({ visible: true });
        await products.waitFor({ state: 'visible', timeout: 8000 });
        await products.click();
        const prices = portalPage.locator('[id$="_form_div_LeftMenu"]')
          .getByText('가격관리', { exact: true }).filter({ visible: true });
        await prices.waitFor({ state: 'visible', timeout: 8000 });
        await prices.click();
        await nameInput.waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        throw screenError('포털에서 온라인 채널연계 → 상품 관리 → 가격관리를 열어 주세요.');
      }
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
    try {
      return await queryPage(portalPage, code);
    } catch (error) {
      if (portalPage.isClosed()) throw screenError('포털 창이 닫혔습니다. 크롬 로그인 창을 다시 열고 현재가를 조회해 주세요.');
      throw error;
    }
  }

  async function queryPage(portalPage, code) {
    await acceptSaveNotice(portalPage, false);
    const nameInput = await ensureSearchScreen(portalPage);
    if ((await readDraftGrids(portalPage)).flat().some(hasBlockingDraft)) {
      throw screenError('포털에 저장 대기 중인 가격이 있습니다. 포털에서 저장하거나 입력을 지운 뒤 다시 확인해 주세요.');
    }
    await nameInput.fill(code);
    await nameInput.press('Tab');
    if ((await nameInput.inputValue()).trim() !== code) {
      throw new Error('상품명 검색칸에서 6자리 품번을 확인하지 못했습니다.');
    }
    const grid = control(portalPage, gridSuffix);
    const watcher = await grid.evaluateHandle(element => {
      const list = element.closest('[id$="_form_div_Work_div_Data"]');
      const result = { lastChange: 0, observer: null };
      result.observer = new MutationObserver(records => {
        const changed = records.some(record => {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          return !!target?.closest('[id$="_grd_Master_body"],[id$="_div_MasterPage_sta_Total"]') ||
            Array.from(record.addedNodes).some(node => node.nodeType === 1 && node.id.endsWith('_grd_Master_body'));
        });
        if (changed) result.lastChange = Date.now();
      });
      result.observer.observe(list, { childList: true, subtree: true, characterData: true });
      return result;
    });
    try {
      try {
        await waitForQueryResult(portalPage, watcher, code);
      } catch (error) {
        if (!portalPage.isClosed()) await ensureSearchScreen(portalPage);
        throw error;
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
    confirmedSubmission = undefined;
    return exact;
  }

  async function stage(offer, expectedPrice, targetPrice, date, hour,
    { save = false, reuseSearch = false, checkPendingFirst = false } = {}) {
    const portalPage = activePage();
    let offers;
    if (reuseSearch) {
      const nameInput = await ensureSearchScreen(portalPage);
      if ((await nameInput.inputValue()).trim() !== offer.code ||
          (await readDraftGrids(portalPage)).flat().some(hasBlockingDraft)) {
        throw screenError('직전 조회 화면이 바뀌었거나 적용 중인 가격이 있습니다. 포털 화면을 확인해 주세요.');
      }
      const rows = await readGrid(portalPage);
      await checkRenderedCount(portalPage, rows);
      offers = rows.filter(row => row.code === offer.code);
    } else {
      offers = await query(offer.code);
    }
    if (!offers.length) throw Object.assign(new Error('검색 결과 없음 · 건너뜀'), { code: 'OFFER_MISSING' });
    const matching = offers.filter(row => matchIdentity(row, offer));
    if (matching.length !== 1) {
      throw Object.assign(new Error('현재가 또는 상품 정보가 바뀌었습니다. 다시 조회해 주세요.'), { code: 'OFFER_CHANGED' });
    }
    const fresh = matching[0];
    const progress = plannedChange(fresh, targetPrice, { checkPendingFirst });
    if (progress) {
      throw Object.assign(new Error(progress.message), {
        code: progress.status === 'already' ? 'OFFER_ALREADY' : 'OFFER_PENDING',
        offer: fresh,
        progress,
      });
    }
    if (fresh.currentPrice !== expectedPrice) {
      throw Object.assign(new Error('현재가가 바뀌었습니다. 다시 조회해 주세요.'), { code: 'OFFER_CHANGED' });
    }
    confirmedSubmission = undefined;
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
    if (save) {
      const result = await savePrice(portalPage, fresh, targetPrice, date, hour);
      if (result.submissionConfirmed) confirmedSubmission = { offer: fresh, targetPrice, date, hour };
      return result;
    }
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
        const openedContext = await chromium.launchPersistentContext(profileDirectory, {
          channel: 'chrome',
          headless: false,
          viewport: null,
          args: ['--restore-last-session'],
        });
        context = openedContext;
        openedContext.on('close', () => {
          if (context === openedContext) { context = null; page = null; confirmedSubmission = undefined; }
        });
      }
      page = context.pages().find(candidate => candidate.url().startsWith(portalOrigin + '/')) ??
        context.pages().find(candidate => candidate.url() === 'about:blank') ?? await context.newPage();
      page.setDefaultTimeout(5000);
      if (page.url() === 'about:blank') await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded' });
      await page.bringToFront();
    },
    async ensureSearch() { await ensureSearchScreen(activePage()); },
    async inspect() { return readGrid(activePage()); },
    query,
    async stage(...args) {
      try {
        return await stage(...args);
      } catch (error) {
        error.saveAttempted ??= false;
        throw error;
      }
    },
    async close() { await context?.close(); },
  };
}
