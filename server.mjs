import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, appendFile, readFile, mkdir, readdir, writeFile, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemo } from './memo.mjs';
import { matchIdentity, openPlan, reconcileRow, recordPriceChange } from './ledger.mjs';
import { openPortal } from './portal.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.PRICE_CHANGER_DATA || path.join(appDir, 'data');
const planStore = openPlan(path.join(dataDir, 'price-plan.json'));
const archiveDir = path.join(dataDir, 'price-plan-history');
const portal = openPortal(path.join(dataDir, 'chrome-profile'));
const portalOpenMessages = {
  ready: '롯데 포털 가격관리 화면을 열었습니다.',
  unavailable: '상품등록기의 롯데 자동 로그인 설정을 확인하거나 포털에서 직접 로그인해 주세요.',
  manual: '전용 Chrome에서 포털 로그인 화면을 확인해 주세요.',
  expired: '전용 Chrome에서 세션 만료 안내를 확인한 뒤 다시 로그인해 주세요.',
};
await mkdir(dataDir, { recursive: true });
const tokenFile = path.join(dataDir, 'local-auth.key');
try {
  await writeFile(tokenFile, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const token = (await readFile(tokenFile, 'utf8')).trim();
if (!/^[a-f0-9]{48}$/.test(token)) throw new Error('가격 변경기 접속 키 파일을 확인해 주세요.');
const port = Number(process.env.PRICE_CHANGER_PORT || 49428);
const startupWarnings = [];
async function logError(context, error) {
  const entry = { at: new Date().toISOString(), context, code: error.code, message: error.message };
  await appendFile(path.join(dataDir, 'errors.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 })
    .catch(() => console.error(context, error.message));
}
const money = new Intl.NumberFormat('ko-KR');
const KST_OFFSET = 9 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const routes = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
]);

function restriction(row, mode) {
  const target = mode === 'restore' ? row.currentPrice : row.newPrice;
  return target <= 7000 ? '적용 가격이 7,000원 이하입니다.' : '';
}

function scheduleNearNow() {
  const next = new Date((Math.floor((Date.now() + KST_OFFSET) / HOUR) + 1) * HOUR).toISOString();
  return { date: next.slice(0, 10), hour: next.slice(11, 13) };
}

function validMode(value) {
  if (value !== 'discount' && value !== 'restore') throw new Error('할인 적용 또는 원가격 복구를 선택해 주세요.');
  return value;
}

function validateSchedule(date, hour) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof hour !== 'string' || !/^(?:[01]\d|2[0-3])$/.test(hour)) {
    throw new Error('적용 시작 날짜와 시각을 선택해 주세요.');
  }
  const start = Date.parse(date + 'T' + hour + ':00:00+09:00');
  if (!Number.isFinite(start) || new Date(start + KST_OFFSET).toISOString().slice(0, 10) !== date) {
    throw new Error('유효한 날짜를 선택해 주세요.');
  }
  if (start <= Date.now()) throw new Error('적용 시작은 현재 시각 이후로 선택해 주세요.');
}

async function readBody(req, max) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error('파일 또는 입력 내용이 너무 큽니다.');
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

async function readWorkbook(bytes) {
  const bundledPython = path.resolve(path.dirname(process.execPath), '../../python/python.exe');
  const python = process.env.PRICE_CHANGER_PYTHON ||
    (await access(bundledPython).then(() => bundledPython).catch(() => 'python'));
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-X', 'utf8', path.join(appDir, 'read-xlsx.py')], {
      windowsHide: true,
      timeout: 15000,
    });
    const output = [];
    const errors = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', () => reject(new Error('엑셀 읽기 도구를 시작하지 못했습니다. A~C열을 복사해 붙여넣을 수 있습니다.')));
    child.stdin.on('error', () => {});
    child.on('close', exitCode => {
      try {
        if (exitCode !== 0) throw new Error(Buffer.concat(errors).toString('utf8').trim() || '엑셀 파일을 읽지 못했습니다.');
        const result = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (typeof result.sourceText !== 'string') throw new Error(result.error || '엑셀 파일을 읽지 못했습니다.');
        resolve(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(bytes);
  });
}

let plan;
try {
  plan = await planStore.load();
  if (planStore.recoveryMessage) startupWarnings.push(planStore.recoveryMessage);
} catch (error) {
  startupWarnings.push('저장된 가격 목록을 읽지 못했습니다. 원본 파일을 확인하거나 목록을 다시 불러오세요.');
  await logError('load-plan', error);
}
if (!plan && process.argv[2]) {
  const sourceText = await readFile(process.argv[2], 'utf8');
  const parsed = parseMemo(sourceText);
  if (!parsed.rows.length) throw new Error('초기 가격 목록을 읽지 못했습니다.');
  plan = { sourceText, ...parsed, importedAt: new Date().toISOString(),
    sourceName: path.basename(process.argv[2]),
    schedule: scheduleNearNow() };
  await planStore.save(plan);
}

const auditFile = path.join(dataDir, 'price-change-audit.jsonl');
const priceChanges = new Map();
try {
  const audit = (await readFile(auditFile, 'utf8')).replace(/^\uFEFF/, '');
  let skipped = 0;
  for (const line of audit.split(/\r?\n/).filter(line => line.trim())) {
    try {
      if (!recordPriceChange(priceChanges, JSON.parse(line))) skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  if (skipped) startupWarnings.push('가격 변경 기록 중 ' + skipped + '건을 읽지 못했습니다.');
} catch (error) {
  if (error.code !== 'ENOENT') {
    startupWarnings.push('가격 변경 기록을 읽지 못했습니다. 복구 대상을 목록의 할인 판매가와 대조합니다.');
    await logError('load-price-change-audit', error);
  }
}

let mode = 'discount';
let results = {};
let busy = false;
const runStateFile = path.join(dataDir, 'run-state.json');
let pendingStateWrite = Promise.resolve();

function isStagedInput(result) {
  return result?.status === 'pending' && result.offer && !result.needsReview;
}

function assertPortalInputResolved() {
  if (Object.values(results).some(result => isStagedInput(result) || result?.needsReview)) {
    throw Object.assign(new Error('이전 포털 입력의 상태를 확인한 뒤 진행해 주세요.'), { status: 409 });
  }
}

function persistRunState() {
  const rowRevisions = Object.fromEntries((plan?.rows ?? []).map(row => [row.line, row.priceRevision ?? '']));
  const contents = JSON.stringify({ planId: plan && planId(plan), mode, results, rowRevisions });
  const write = pendingStateWrite.then(async () => {
    const temporary = runStateFile + '.tmp';
    await writeFile(temporary, contents, { mode: 0o600, flush: true });
    await rename(temporary, runStateFile);
  });
  pendingStateWrite = write.catch(() => {});
  return write;
}
try {
  const savedRun = JSON.parse(await readFile(runStateFile, 'utf8'));
  if (plan && savedRun.planId === planId(plan) && ['discount', 'restore'].includes(savedRun.mode)) {
    mode = savedRun.mode;
    for (const row of plan.rows) {
      const result = savedRun.results?.[row.line];
      const targetPrice = mode === 'restore' ? row.currentPrice : row.newPrice;
      const stale = (savedRun.rowRevisions?.[row.line] ?? '') !== (row.priceRevision ?? '') ||
        (result?.targetPrice !== undefined && result.targetPrice !== targetPrice);
      if (stale && result?.needsReview) {
        results[row.line] = { ...result, status: 'interrupted',
          message: '가격 수정 전 작업의 저장 결과가 불명확합니다. 현재가 조회로 포털 저장 결과를 확인하세요.' };
        continue;
      }
      if (stale) continue;
      const reason = restriction(row, mode);
      if (result?.status === 'saved' || isStagedInput(result)) results[row.line] = result;
      else if (result?.needsReview) results[row.line] = {
        ...result, status: 'interrupted', message: '이전 작업이 중단되었습니다. 현재가 조회로 포털 저장 결과를 확인하세요.',
      };
      else if (reason) results[row.line] = blockedResult(row, mode, reason);
      else if (result?.status === 'ready' && result.offer) {
        // Writes recheck the exact portal offer and its observed price.
        results[row.line] = reconcileRow(row, [result.offer], mode, priceChanges);
      } else if (result?.status === 'mismatch' && !result.message && result.offers?.length) {
        results[row.line] = reconcileRow(row, result.offers, mode, priceChanges);
      } else if (['already', 'scheduled', 'pending_change', 'missing', 'ambiguous', 'mismatch', 'error'].includes(result?.status)) {
        results[row.line] = result;
      }
    }
    markOverlappingOffers(plan.rows);
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    startupWarnings.push('이전 작업 기록을 읽지 못했습니다. 현재가를 조회해 적용 여부를 확인하세요.');
    await logError('load-run-state', error);
  }
}
const archiveIds = await readdir(archiveDir).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const history = new Map();
const archivedImports = new Map();
for (const filename of archiveIds.filter(filename => /^[a-f0-9]{16}\.json$/.test(filename))) {
  const id = filename.slice(0, -5);
  try {
    const saved = await openPlan(path.join(archiveDir, filename)).load();
    if (saved) {
      history.set(id, planSummary(saved, id));
      archivedImports.set(importIdentity(saved), id);
    }
  } catch (error) { await logError('load-history:' + id, error); }
}
if (plan) {
  try {
    const archived = await archivePlan(plan);
    if (plan.archiveId !== archived.archiveId) {
      await planStore.save(archived);
      plan = archived;
    }
  } catch (error) {
    startupWarnings.push('현재 목록은 유지됐지만 보관함에 저장하지 못했습니다. 저장 공간과 폴더 권한을 확인하세요.');
    await logError('archive-current-plan', error);
  }
}
let message = plan
  ? '포털에 로그인하고 가격관리를 연 뒤 현재가를 조회하세요.'
  : '엑셀 또는 메모장을 불러와 가격 목록을 저장하세요.';

function publicState() {
  const storedSchedule = plan?.schedule;
  const scheduledAt = Date.parse(storedSchedule?.date + 'T' + storedSchedule?.hour + ':00:00+09:00');
  const schedule = scheduledAt > Date.now() ? storedSchedule : scheduleNearNow();
  return {
    plan: plan && { ...plan, rows: plan.rows.map(row => ({ ...row,
      restriction: restriction(row, 'discount'), restoreRestriction: restriction(row, 'restore'),
    })) },
    mode,
    results,
    busy,
    message,
    warnings: startupWarnings,
    defaultDate: schedule.date,
    defaultHour: schedule.hour,
    history: [...history.values()]
      .map(item => ({ ...item, current: item.id === plan?.archiveId }))
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt) || b.id.localeCompare(a.id)),
  };
}

function blockedResult(row, operation, reason) {
  return {
    ...reconcileRow(row, [], operation),
    status: 'blocked',
    message: reason,
  };
}

function markOverlappingOffers(rows) {
  const counts = new Map();
  for (const row of rows) {
    const offer = results[row.line]?.offer;
    if (!offer) continue;
    const key = JSON.stringify([row.code, offer.id]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    const result = results[row.line];
    if (result?.status === 'ready' && counts.get(JSON.stringify([row.code, result.offer.id])) > 1) {
      result.status = 'ambiguous';
      result.message = '같은 포털 상품이 목록의 여러 행과 일치합니다.';
    }
  }
}

async function checkPrices(onCheckedGroup) {
  const byCode = new Map();
  let checked = 0;
  const total = plan.rows.length;
  for (const row of plan.rows) {
    const reason = restriction(row, mode);
    if (reason) {
      results[row.line] = blockedResult(row, mode, reason);
      checked += 1;
    } else {
      if (!byCode.has(row.code)) byCode.set(row.code, []);
      byCode.get(row.code).push(row);
      results[row.line] = { status: 'pending' };
    }
  }
  for (const [code, rows] of byCode) {
    message = '포털 현재가 조회 중 (' + checked + '/' + total + ')';
    try {
      const offers = await portal.query(code);
      for (const row of rows) {
        const result = reconcileRow(row, offers, mode, priceChanges);
        if (result.status === 'missing') result.message = '검색 결과 없음 · 건너뜀';
        results[row.line] = result;
      }
      markOverlappingOffers(rows);
    } catch (error) {
      await logError('query:' + code, error);
      for (const row of rows) results[row.line] = { status: 'error', message: error.message };
      if (error.code === 'PORTAL_SCREEN') {
        for (const result of Object.values(results)) {
          if (result.status === 'pending') Object.assign(result, { status: 'error', message: '조회가 중단되었습니다.' });
        }
        message = error.message;
        return false;
      }
    }
    checked += rows.length;
    if (onCheckedGroup && !await onCheckedGroup(rows)) {
      for (const result of Object.values(results)) {
        if (result.status === 'pending') Object.assign(result, { status: 'error', message: '조회가 중단되었습니다.' });
      }
      return false;
    }
  }
  const ready = Object.values(results).filter(row => row.status === 'ready').length;
  const skipped = Object.values(results).filter(row => ['already', 'scheduled', 'pending_change'].includes(row.status)).length;
  message = '조회 완료 · ' + ready + '건 입력 가능' + (skipped ? ' · 적용·진행 중 ' + skipped + '건 건너뜀' : '');
  return true;
}

async function checkStagedInputs(rows) {
  const previous = results;
  const updated = { ...previous };
  for (const row of rows) {
    const pending = previous[row.line];
    message = row.code + ' · 포털 입력 상태 확인 중';
    const offers = await portal.query(row.code);
    const matches = offers.filter(offer => matchIdentity(offer, pending.offer));
    if (!matches.length && offers.length) {
      updated[row.line] = {
        status: 'mismatch', expectedPrice: pending.expectedPrice, targetPrice: pending.targetPrice, offers,
        message: '포털에서 이전에 입력한 상품을 찾지 못했습니다.',
      };
    } else {
      updated[row.line] = reconcileRow(row, matches, mode, priceChanges);
    }
  }
  results = updated;
  try {
    await persistRunState();
  } catch (error) {
    results = previous;
    throw error;
  }
  message = '입력 상태 확인 완료 · 다음 상품을 진행할 수 있습니다.';
}

async function stageRow(row, result, date, hour, { save = false, reuseSearch = false } = {}) {
  const reason = restriction(row, mode);
  if (reason) throw Object.assign(new Error(reason), { saveAttempted: false });
  try { validateSchedule(date, hour); } catch (error) { error.saveAttempted = false; throw error; }
  try {
    await portal.stage(result.offer, result.expectedPrice, result.targetPrice, date, hour, {
      save, reuseSearch, checkPendingFirst: mode === 'restore',
    });
  } catch (error) {
    if (error.code === 'OFFER_ALREADY' || error.code === 'OFFER_PENDING') {
      Object.assign(result, error.progress, { offer: error.offer, needsReview: false });
      message = row.code + ' · ' + result.message;
      return false;
    }
    const status = { OFFER_MISSING: 'missing', OFFER_CHANGED: 'mismatch' }[error.code];
    if (!status) throw error;
    result.status = status;
    result.message = error.message;
    message = row.code + ' · ' + error.message;
    return false;
  }
  if (save) {
    result.status = 'saved';
    result.message = mode === 'restore' ? '포털 원가격 복구 예약 확인' : '포털 저장 확인';
    const entry = {
      planId: planId(plan), line: row.line, originalCode: row.originalCode, code: row.code,
      productId: result.offer.id, channel: result.offer.channel, store: result.offer.store,
      mode, fromPrice: result.expectedPrice, toPrice: result.targetPrice,
      effectiveAt: date + 'T' + hour + ':00:00+09:00', verifiedAt: new Date().toISOString(),
    };
    try {
      await appendFile(auditFile, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
      recordPriceChange(priceChanges, entry);
    } catch {
      throw new Error('포털 저장은 확인했지만 로컬 작업 기록을 저장하지 못했습니다.');
    }
  } else {
    result.status = 'pending';
    result.message = '포털에 입력 완료 · 저장 후 입력 상태 확인';
    message = row.code + ' · ' + money.format(result.targetPrice) + '원 · 포털 입력 완료';
  }
  return true;
}

async function runBatch(operation, date, hour, { immediate = false } = {}) {
  if (!immediate && (mode !== operation || plan.rows.some(row => !results[row.line]))) {
    mode = operation;
    results = {};
    if (!await checkPrices()) return;
  }
  let saved = 0;
  let skipped = 0;
  async function saveRow(row, progress, reuseSearch = false) {
    const result = results[row.line];
    let counted = false;
    message = '포털 저장 중 (' + progress + ') · ' + row.code + ' · ' +
      money.format(result.targetPrice) + '원';
    try {
      result.needsReview = true;
      await persistRunState();
      if (await stageRow(row, result, date, hour, { save: true, reuseSearch })) { saved += 1; counted = true; }
      else skipped += 1;
      result.needsReview = false;
      await persistRunState();
    } catch (error) {
      if (result.status === 'saved') { if (!counted) saved += 1; }
      else Object.assign(result, { status: 'error', needsReview: error.saveAttempted !== false, message: error.message });
      await persistRunState().catch(stateError => logError('persist-failed-save', stateError));
      await logError('save:' + row.code, error);
      message = '일괄 저장 중단 · ' + (immediate ? '' : '저장 확인 ' + saved + '건 · ') + row.code + ' · ' + error.message;
      return false;
    }
    return true;
  }

  if (immediate) {
    mode = operation;
    results = {};
    const completed = await checkPrices(async rows => {
      const eligible = rows.filter(row => results[row.line].status === 'ready');
      for (const [index, row] of eligible.entries()) {
        if (!await saveRow(row, (saved + skipped + 1) + '건째', index === 0)) return false;
      }
      return true;
    });
    if (!completed) {
      message = '저장 확인 ' + saved + '건 · ' + message;
      return;
    }
    skipped = plan.rows.length - saved;
    message = (operation === 'restore' ? '조회 후 복구 예약 완료' : '조회 후 바로 적용 완료') +
      ' · 저장 확인 ' + saved + '건' + (skipped ? ' · 미저장 ' + skipped + '건' : '');
    return;
  }

  const eligible = plan.rows.filter(row => results[row.line]?.status === 'ready');
  if (!eligible.length) {
    message = '추가로 저장할 상품이 없습니다. 조회 결과를 확인해 주세요.';
    return;
  }
  for (const [index, row] of eligible.entries()) {
    if (!await saveRow(row, (index + 1) + '/' + eligible.length)) return;
  }
  message = (operation === 'restore' ? '원가격 복구 예약 완료' : '일괄 저장 완료') +
    ' · 저장 확인 ' + saved + '건' + (skipped ? ' · 건너뜀 ' + skipped + '건' : '');
}

function planId(saved) {
  return createHash('sha256').update(saved.sourceText).digest('hex').slice(0, 16);
}

function planSummary(saved, id) {
  return { id, importedAt: saved.importedAt, rowCount: saved.rows.length, sourceName: saved.sourceName,
    downloadUrl: '/api/history/' + id + '/download' };
}

function importIdentity(saved) {
  return JSON.stringify([saved.sourceText, saved.importedAt, saved.sourceName ?? '']);
}

async function archivePlan(saved) {
  const identity = importIdentity(saved);
  const suppliedId = typeof saved.archiveId === 'string' && /^[a-f0-9]{16}$/.test(saved.archiveId)
    ? saved.archiveId : undefined;
  // Legacy imports get a stable migration ID; every new import explicitly supplies a fresh ID.
  const id = suppliedId ?? archivedImports.get(identity) ??
    createHash('sha256').update('import:' + identity).digest('hex').slice(0, 16);
  const archived = { ...saved, archiveId: id };
  if (!history.has(id)) {
    await openPlan(path.join(archiveDir, id + '.json')).save(archived);
    history.set(id, planSummary(archived, id));
    archivedImports.set(identity, id);
  }
  return archived;
}

async function activatePlan(next) {
  if (plan) await archivePlan(plan);
  const archived = await archivePlan(next);
  await planStore.save(archived);
  plan = archived;
  mode = 'discount';
  results = {};
  await persistRunState();
  message = '목록 ' + next.rows.length + '건 저장 완료';
}

async function importPlan(sourceText, sourceName) {
  if (typeof sourceText !== 'string' || sourceText.length > 1_000_000) {
    throw new Error('가격 목록을 확인해 주세요.');
  }
  const parsed = parseMemo(sourceText);
  if (!parsed.rows.length) throw new Error(parsed.errors[0]?.message || '저장할 가격 목록이 없습니다.');
  const name = typeof sourceName === 'string' ? path.basename(sourceName).slice(0, 120) : undefined;
  await activatePlan({ sourceText, ...parsed, sourceName: name, archiveId: randomBytes(8).toString('hex'),
    importedAt: new Date().toISOString(), schedule: scheduleNearNow() });
}

async function editPlanPrice(body) {
  if (!plan?.rows.length) throw new Error('먼저 가격 목록을 저장해 주세요.');
  if (!Number.isSafeInteger(body?.line) || body.line < 1 ||
      typeof body.originalCode !== 'string' || !/^[0-9]{8}$/.test(body.originalCode) ||
      !Number.isSafeInteger(body.expectedPrice) || body.expectedPrice <= 0 ||
      !Number.isSafeInteger(body.newPrice) || body.newPrice <= 0) {
    throw new Error('행 번호, 품번과 양의 정수 할인판매가를 확인해 주세요.');
  }
  const row = plan.rows.find(item => item.line === body.line);
  if (!row || row.originalCode !== body.originalCode || row.newPrice !== body.expectedPrice) {
    throw Object.assign(new Error('목록 또는 할인판매가가 변경되었습니다. 현재 목록을 새로 확인해 주세요.'), { status: 409 });
  }
  if (Object.values(results).some(result => result.status === 'pending' || result.needsReview)) {
    throw Object.assign(new Error('포털에 입력 중이거나 저장 확인이 필요한 상품이 있습니다. 현재가를 다시 조회한 뒤 수정해 주세요.'), { status: 409 });
  }
  if (body.newPrice === row.newPrice) {
    message = row.code + ' · 할인판매가가 같습니다. 기존 조회·저장 결과를 유지합니다.';
    return;
  }
  const updatedRow = { ...row, newPrice: body.newPrice, uploadedNewPrice: row.uploadedNewPrice ?? row.newPrice,
    priceUpdatedAt: new Date().toISOString(), priceRevision: randomBytes(8).toString('hex') };
  const updatedPlan = { ...plan, rows: plan.rows.map(item => item === row ? updatedRow : item) };
  // Commit the price first. A revision mismatch prevents old run results from returning after a crash.
  await planStore.save(updatedPlan);
  plan = updatedPlan;
  results = { ...results };
  delete results[row.line];
  message = row.code + ' · 할인판매가를 ' + money.format(body.newPrice) + '원으로 수정했습니다. 현재가를 다시 조회해 주세요.';
  try {
    await persistRunState();
  } catch (error) {
    // The price is already durable. Do not report the edit as failed or revive its stale result.
    message += ' 가격은 저장됐지만 작업 기록 갱신에 실패했습니다. 재시작해도 해당 행은 다시 조회해야 합니다.';
    await logError('persist-price-edit', error);
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = 'http://127.0.0.1:' + server.address().port;
  const cookieName = 'price_changer_' + server.address().port;
  try {
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: '가격 변경기 창에서 열어 주세요.' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.get('key') === token) {
      res.writeHead(303, { 'Set-Cookie': cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Strict',
        Location: '/', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (!req.headers.cookie?.split(';').some(cookie => cookie.trim() === cookieName + '=' + token)) {
      return json(res, 403, { error: '실행 창에서 가격 변경기를 열어 주세요.' });
    }
    if (req.method === 'GET') {
      if (url.pathname === '/api/state') return json(res, 200, publicState());
      const download = url.pathname.match(/^\/api\/history\/([a-f0-9]{16})\/download$/);
      if (download) {
        const id = download[1];
        if (!history.has(id)) return json(res, 404, { error: '보관된 목록을 찾을 수 없습니다.' });
        const saved = await openPlan(path.join(archiveDir, id + '.json')).load();
        if (!saved) return json(res, 404, { error: '보관된 목록 파일을 찾을 수 없습니다.' });
        const importedDate = new Date(Date.parse(saved.importedAt) + KST_OFFSET).toISOString().slice(0, 10);
        const filename = '가격목록_' + importedDate + '_' + id + '.txt';
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="price-list-' + id + '.txt"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(saved.sourceText);
      }
      if (url.pathname === '/api/portal/inspect') {
        if (busy) return json(res, 409, { error: '진행 중인 작업이 있습니다.' });
        busy = true;
        try { return json(res, 200, { offers: await portal.inspect() }); } finally { busy = false; }
      }
      const file = routes.get(url.pathname);
      if (!file) return json(res, 404, { error: '화면을 찾을 수 없습니다.' });
      const contents = await readFile(path.join(appDir, file[0]));
      res.writeHead(200, {
        'Content-Type': file[1] + '; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(contents);
    }
    if (req.method !== 'POST' || req.headers.origin !== origin) {
      return json(res, 403, { error: '가격 변경기 창에서 실행해 주세요.' });
    }
    if (busy) return json(res, 409, { error: '진행 중인 작업이 있습니다.' });
    if (url.pathname === '/api/read-xlsx') return json(res, 200, await readWorkbook(await readBody(req, 5 * 1024 * 1024)));
    const body = JSON.parse((await readBody(req, 1_200_000)).toString('utf8'));
    if (busy) return json(res, 409, { error: '진행 중인 작업이 있습니다.' });
    if (url.pathname === '/api/import') {
      busy = true;
      try { await importPlan(body.sourceText, body.sourceName); } finally { busy = false; }
    } else if (url.pathname === '/api/plan/price') {
      busy = true;
      try { await editPlanPrice(body); } finally { busy = false; }
    } else if (url.pathname === '/api/history/load') {
      if (!history.has(body.id)) throw new Error('저장된 목록을 다시 선택해 주세요.');
      busy = true;
      try {
        if (body.id === plan?.archiveId) {
          message = '현재 사용 중인 목록입니다. 기존 조회·저장 결과를 유지합니다.';
        } else {
          const previous = await openPlan(path.join(archiveDir, body.id + '.json')).load();
          if (!previous) throw new Error('저장된 목록 파일을 찾지 못했습니다.');
          await activatePlan({ ...previous, archiveId: body.id, schedule: scheduleNearNow() });
          message = '이전 가격 목록 ' + previous.rows.length + '건 불러오기 완료';
        }
      } finally { busy = false; }
    } else if (url.pathname === '/api/portal/open') {
      busy = true;
      try {
        const opened = await portal.open();
        message = portalOpenMessages[opened.status] ?? 'Chrome에서 로그인한 뒤 현재가를 조회하세요.';
        if (opened.commonItemName) message += ' ' + opened.commonItemName + ' 선택 완료.';
      } finally { busy = false; }
    } else if (url.pathname === '/api/portal/check') {
      if (!plan?.rows.length) throw new Error('먼저 목록을 저장해 주세요.');
      const operation = validMode(body.mode);
      const staged = plan.rows.filter(row => isStagedInput(results[row.line]));
      busy = true;
      if (staged.length) {
        try { await checkStagedInputs(staged); } finally { busy = false; }
        return json(res, 200, publicState());
      }
      try { await portal.ensureSearch(); } catch (error) { busy = false; throw error; }
      mode = operation;
      results = {};
      void checkPrices().catch(async error => { message = error.message; await logError('check', error); })
        .finally(async () => {
          try { await persistRunState(); } catch (error) { message = error.message; await logError('persist-check', error); }
          busy = false;
        });
    } else if (url.pathname === '/api/portal/run' || url.pathname === '/api/portal/check-and-run') {
      if (!plan?.rows.length) throw new Error('먼저 가격 목록을 저장해 주세요.');
      assertPortalInputResolved();
      const operation = validMode(body.mode);
      validateSchedule(body.date, body.hour);
      busy = true;
      try { await portal.ensureSearch(); } catch (error) { busy = false; throw error; }
      void runBatch(operation, body.date, body.hour, { immediate: url.pathname === '/api/portal/check-and-run' })
        .catch(async error => { message = error.message; await logError('run', error); })
        .finally(async () => {
          try { await persistRunState(); } catch (error) { message = error.message; await logError('persist-run', error); }
          busy = false;
        });
    } else if (url.pathname === '/api/portal/stage') {
      assertPortalInputResolved();
      const operation = validMode(body.mode);
      const row = plan?.rows.find(item => item.line === body.line);
      const result = results[body.line];
      if (!row || operation !== mode || result?.status !== 'ready') throw new Error('현재가를 다시 조회해 주세요.');
      busy = true;
      try {
        await stageRow(row, result, body.date, body.hour);
        try { await persistRunState(); } catch (error) {
          message += ' 가격변경기의 작업 기록을 저장하지 못했습니다.';
          await logError('persist-stage', error);
        }
      } finally { busy = false; }
    } else {
      return json(res, 404, { error: '요청한 작업을 찾을 수 없습니다.' });
    }
    return json(res, 200, publicState());
  } catch (error) {
    await logError(req.method + ' ' + new URL(req.url, origin).pathname, error);
    return json(res, error.status === 409 ? 409 : 400, { error: error.message });
  }
});

async function openWindow() {
  const url = 'http://127.0.0.1:' + port + '/?key=' + token;
  const readyFile = process.env.PRICE_CHANGER_READY_FILE || path.join(dataDir, 'desktop-session.txt');
  await writeFile(readyFile, url, { encoding: 'utf8', mode: 0o600 });
  if (process.env.PRICE_CHANGER_NO_OPEN === '1') return;
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const child = spawn(chrome, ['--new-window', url], { windowsHide: true, stdio: 'ignore', detached: true });
  child.on('error', () => console.error('Chrome을 열지 못했습니다. Chrome 설치 경로를 확인해 주세요.'));
  child.unref();
}

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    void fetch('http://127.0.0.1:' + port + '/api/state', {
      headers: { Cookie: 'price_changer_' + port + '=' + token }, signal: AbortSignal.timeout(3000),
    }).then(async response => {
      if (!response.ok) throw new Error('같은 포트에서 다른 실행 인스턴스가 동작 중입니다.');
      await openWindow();
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
  } else { console.error(error.message); process.exitCode = 1; }
});

server.listen(port, '127.0.0.1', () => {
  console.log('가격 변경기 실행 중 · 이 창을 닫으면 종료됩니다.');
  void openWindow().catch(error => logError('open-window', error));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void portal.close().finally(() => server.close(() => process.exit())); });
}
