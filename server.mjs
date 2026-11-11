import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemo } from './memo.mjs';
import { openPlan, reconcileRow } from './ledger.mjs';
import { openPortal } from './portal.mjs';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.PRICE_CHANGER_DATA || path.join(appDir, 'data');
const planStore = openPlan(path.join(dataDir, 'price-plan.json'));
const archiveDir = path.join(dataDir, 'price-plan-history');
const portal = openPortal(path.join(dataDir, 'chrome-profile'));
const token = randomBytes(24).toString('hex');
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
  const reasons = [];
  if (target <= 9900) reasons.push('판매가가 9,900원 이하입니다.');
  if (mode === 'discount') {
    const floor = Math.ceil(row.currentPrice / 2);
    if (target < floor) {
      reasons.push('할인율이 50%를 넘습니다. 이 상품의 할인 하한은 ' + money.format(floor) + '원입니다.');
    } else if (target > row.currentPrice) {
      reasons.push('할인 판매가가 원가격보다 높습니다.');
    }
  }
  return reasons.join(' ');
}

function scheduleNearNow() {
  const next = new Date(Math.round((Date.now() + KST_OFFSET + HOUR) / HOUR) * HOUR).toISOString();
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

function readWorkbook(bytes) {
  const python = process.env.PRICE_CHANGER_PYTHON || 'python';
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

let plan = await planStore.load();
if (!plan && process.argv[2]) {
  const sourceText = await readFile(process.argv[2], 'utf8');
  const parsed = parseMemo(sourceText);
  if (!parsed.rows.length) throw new Error('초기 가격 목록을 읽지 못했습니다.');
  plan = { sourceText, ...parsed, importedAt: new Date().toISOString(),
    sourceName: path.basename(process.argv[2]),
    schedule: scheduleNearNow() };
  await planStore.save(plan);
}

let mode = 'discount';
let results = {};
let busy = false;
const archiveIds = await readdir(archiveDir).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const history = new Map();
for (const filename of archiveIds.filter(filename => /^[a-f0-9]{16}\.json$/.test(filename))) {
  const id = filename.slice(0, -5);
  const saved = await openPlan(path.join(archiveDir, filename)).load();
  if (saved) history.set(id, planSummary(saved, id));
}
let message = plan
  ? '포털에 로그인하고 가격관리를 연 뒤 현재가를 조회하세요.'
  : '엑셀 또는 메모장을 불러와 가격 목록을 저장하세요.';

function publicState() {
  const schedule = plan?.schedule ?? scheduleNearNow();
  return {
    plan: plan && { ...plan, rows: plan.rows.map(row => ({ ...row, restriction: restriction(row, 'discount') })) },
    mode,
    results,
    busy,
    message,
    defaultDate: schedule.date,
    defaultHour: schedule.hour,
    history: [...history.values()].filter(item => item.id !== (plan && planId(plan)))
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt)),
  };
}

function blockedResult(row, operation, reason) {
  return {
    ...reconcileRow(row, [], operation),
    status: 'blocked',
    message: reason,
  };
}

async function checkPrices() {
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
        const result = reconcileRow(row, offers, mode);
        if (result.status === 'missing') result.message = '검색 결과 없음 · 건너뜀';
        if (result.status === 'ready' && /진행|예정|대기|요청|승인중/.test(result.offer.scheduledStatus)) {
          result.status = 'blocked';
          result.message = '포털에 판매가 변경 예정 정보가 있습니다.';
        }
        results[row.line] = result;
      }
      for (const row of rows) {
        const result = results[row.line];
        if (result.status !== 'ready') continue;
        const overlaps = rows.some(other => other !== row && results[other.line].offer?.id === result.offer.id);
        if (overlaps) {
          result.status = 'ambiguous';
          result.message = '같은 포털 상품이 목록의 여러 행과 일치합니다.';
        }
      }
    } catch (error) {
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
  }
  const ready = Object.values(results).filter(row => row.status === 'ready').length;
  message = '조회 완료 · ' + ready + '건 입력 가능';
  return true;
}

async function stageRow(row, result, date, hour, { save = false } = {}) {
  const reason = restriction(row, mode);
  if (reason) throw new Error(reason);
  validateSchedule(date, hour);
  try {
    await portal.stage(result.offer, result.expectedPrice, result.targetPrice, date, hour, { save });
  } catch (error) {
    const status = { OFFER_MISSING: 'missing', OFFER_CHANGED: 'mismatch' }[error.code];
    if (!status) throw error;
    result.status = status;
    result.message = error.message;
    message = row.code + ' · ' + error.message;
    return false;
  }
  if (save) {
    result.status = 'saved';
    result.message = '포털 저장 확인';
    const entry = {
      planId: planId(plan), line: row.line, originalCode: row.originalCode, code: row.code,
      productId: result.offer.id, channel: result.offer.channel, store: result.offer.store,
      mode, fromPrice: result.expectedPrice, toPrice: result.targetPrice,
      effectiveAt: date + 'T' + hour + ':00:00+09:00', verifiedAt: new Date().toISOString(),
    };
    try {
      await appendFile(path.join(dataDir, 'price-change-audit.jsonl'), JSON.stringify(entry) + '\n',
        { encoding: 'utf8', mode: 0o600, flush: true });
    } catch {
      throw new Error('포털 저장은 확인했지만 로컬 작업 기록을 저장하지 못했습니다.');
    }
  } else {
    result.status = 'pending';
    result.message = '일괄 적용 완료 · 포털에서 확인 후 저장';
    message = row.code + ' · ' + money.format(result.targetPrice) + '원 · 포털에서 적용 내역을 확인하세요.';
  }
  return true;
}

async function runBatch(operation, date, hour) {
  if (Object.values(results).some(result => result.needsReview)) {
    throw new Error('포털에서 중단된 상품의 저장 결과를 확인한 뒤 현재가를 다시 조회해 주세요.');
  }
  if (mode !== operation || !Object.keys(results).length) {
    mode = operation;
    results = {};
    if (!await checkPrices()) return;
  }
  const eligible = plan.rows.filter(row => results[row.line]?.status === 'ready');
  if (!eligible.length) {
    message = '추가로 저장할 상품이 없습니다. 조회 결과를 확인해 주세요.';
    return;
  }

  let saved = 0;
  let skipped = 0;
  for (const [index, row] of eligible.entries()) {
    const result = results[row.line];
    message = '포털 저장 중 (' + (index + 1) + '/' + eligible.length + ') · ' + row.code + ' · ' +
      money.format(result.targetPrice) + '원';
    try {
      if (await stageRow(row, result, date, hour, { save: true })) saved += 1;
      else skipped += 1;
    } catch (error) {
      if (result.status === 'saved') saved += 1;
      else Object.assign(result, { status: 'error', needsReview: true, message: error.message });
      message = '일괄 저장 중단 · 저장 확인 ' + saved + '건 · ' + row.code + ' · ' + error.message;
      return;
    }
  }
  message = '일괄 저장 완료 · 저장 확인 ' + saved + '건' + (skipped ? ' · 건너뜀 ' + skipped + '건' : '');
}

function planId(saved) {
  return createHash('sha256').update(saved.sourceText).digest('hex').slice(0, 16);
}

function planSummary(saved, id) {
  return { id, importedAt: saved.importedAt, rowCount: saved.rows.length, sourceName: saved.sourceName };
}

async function activatePlan(next) {
  if (plan && plan.sourceText !== next.sourceText) {
    const id = planId(plan);
    if (!history.has(id)) {
      await openPlan(path.join(archiveDir, id + '.json')).save(plan);
      history.set(id, planSummary(plan, id));
    }
  }
  await planStore.save(next);
  plan = next;
  mode = 'discount';
  results = {};
  message = '목록 ' + next.rows.length + '건 저장 완료';
}

async function importPlan(sourceText, sourceName) {
  if (typeof sourceText !== 'string' || sourceText.length > 1_000_000) {
    throw new Error('가격 목록을 확인해 주세요.');
  }
  const parsed = parseMemo(sourceText);
  if (!parsed.rows.length) throw new Error(parsed.errors[0]?.message || '저장할 가격 목록이 없습니다.');
  const name = typeof sourceName === 'string' ? path.basename(sourceName).slice(0, 120) : undefined;
  await activatePlan({ sourceText, ...parsed, sourceName: name,
    importedAt: new Date().toISOString(), schedule: scheduleNearNow() });
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
    } else if (url.pathname === '/api/history/load') {
      if (!history.has(body.id)) throw new Error('저장된 목록을 다시 선택해 주세요.');
      busy = true;
      try {
        const previous = await openPlan(path.join(archiveDir, body.id + '.json')).load();
        if (!previous) throw new Error('저장된 목록 파일을 찾지 못했습니다.');
        await activatePlan({ ...previous, schedule: scheduleNearNow() });
        message = '이전 가격 목록 ' + previous.rows.length + '건 불러오기 완료';
      } finally { busy = false; }
    } else if (url.pathname === '/api/portal/open') {
      busy = true;
      try {
        await portal.open();
        message = 'Chrome에서 로그인 후 온라인 채널연계 → 상품 관리 → 가격관리를 열어 주세요.';
      } finally { busy = false; }
    } else if (url.pathname === '/api/portal/check') {
      if (!plan?.rows.length) throw new Error('먼저 목록을 저장해 주세요.');
      const operation = validMode(body.mode);
      busy = true;
      try { await portal.ensureSearch(); } catch (error) { busy = false; throw error; }
      mode = operation;
      results = {};
      void checkPrices().catch(error => { message = error.message; }).finally(() => { busy = false; });
    } else if (url.pathname === '/api/portal/run') {
      if (!plan?.rows.length) throw new Error('먼저 가격 목록을 저장해 주세요.');
      const operation = validMode(body.mode);
      validateSchedule(body.date, body.hour);
      busy = true;
      try { await portal.ensureSearch(); } catch (error) { busy = false; throw error; }
      void runBatch(operation, body.date, body.hour)
        .catch(error => { message = error.message; })
        .finally(() => { busy = false; });
    } else if (url.pathname === '/api/portal/stage') {
      const operation = validMode(body.mode);
      const row = plan?.rows.find(item => item.line === body.line);
      const result = results[body.line];
      if (!row || operation !== mode || result?.status !== 'ready') throw new Error('현재가를 다시 조회해 주세요.');
      busy = true;
      try { await stageRow(row, result, body.date, body.hour); } finally { busy = false; }
    } else {
      return json(res, 404, { error: '요청한 작업을 찾을 수 없습니다.' });
    }
    return json(res, 200, publicState());
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? '이미 가격 변경기가 실행 중입니다. 기존 창을 사용해 주세요.' : error.message);
  process.exitCode = 1;
});

server.listen(Number(process.env.PRICE_CHANGER_PORT || 49428), '127.0.0.1', async () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/?key=' + token;
  console.log('가격 변경기 실행 중 · 이 창을 닫으면 종료됩니다.');
  if (process.env.PRICE_CHANGER_READY_FILE) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(process.env.PRICE_CHANGER_READY_FILE, url, 'utf8');
  }
  if (process.env.PRICE_CHANGER_NO_OPEN === '1') return;
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const child = spawn(chrome, ['--new-window', url], { windowsHide: true, stdio: 'ignore', detached: true });
  child.on('error', () => console.error('Chrome을 열지 못했습니다. Chrome 설치 경로를 확인해 주세요.'));
  child.unref();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void portal.close().finally(() => server.close(() => process.exit())); });
}
