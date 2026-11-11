import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openPlan, plannedChange, reconcileRow } from '../ledger.mjs';
import { parseMemo } from '../memo.mjs';

const source = '01026990\t49,800\t44,200';
const row = parseMemo(source).rows[0];
const offer = { id: 'product-1', code: '026990', currentPrice: 49800 };
const plan = { sourceText: source, ...parseMemo(source), importedAt: '2026-11-11T00:00:00Z' };

async function temporaryPlan(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'price-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'plan.json');
  return { file, store: openPlan(file) };
}

test('current target price is already applied even with stale scheduled fields', () => {
  const result = reconcileRow(row, [{ ...offer, currentPrice: 44200, scheduledStatus: '변경 예정', scheduledPrice: '40,000' }], 'discount');
  assert.equal(result.status, 'already');
});

test('same target being processed is skipped as scheduled', () => {
  for (const status of ['진행 중', '변경 예정', '승인 대기', '승인 요청', '승인 중']) {
    const result = reconcileRow(row, [{ ...offer, scheduledStatus: status, scheduledPrice: '44,200원' }], 'discount');
    assert.equal(result.status, 'scheduled', status);
  }
});

test('portal approval-before-application result is skipped even without scheduled columns', () => {
  const pending = { ...offer, portalSuccess: 'N', portalResult: '이미 등록한 판매가변경이 승인완료후 적용전 상태입니다.' };
  const result = reconcileRow(row, [pending], 'discount');
  assert.equal(result.status, 'pending_change');
  assert.match(result.message, /승인 완료 후 적용 대기/);
  assert.equal(plannedChange({ ...pending, currentPrice: 44200 }, 44200).status, 'already');
  assert.equal(plannedChange({ ...pending, portalResult: '일시적인 처리 오류입니다.' }, 44200), null);
});

test('another scheduled price is skipped and cancellation requests remain pending', () => {
  for (const status of ['변경 예정', '취소 요청']) {
    assert.equal(plannedChange({ ...offer, scheduledStatus: status, scheduledPrice: '43,000' }, 44200).status, 'pending_change');
  }
});

test('terminal cancellation and rejection do not prevent a new eligible change', () => {
  for (const status of ['변경 요청 취소', '승인 반려', '진행 실패', '취소 완료']) {
    assert.equal(reconcileRow(row, [{ ...offer, scheduledStatus: status, scheduledPrice: '44,200' }], 'discount').status, 'ready');
  }
});

test('future saved or approved schedules are recognized', () => {
  for (const scheduledHour of ['09시', '9시 00분', '22:00', '2200', '22:00:00']) {
    const result = plannedChange({ ...offer, scheduledStatus: '승인 완료', scheduledPrice: '44,200', scheduledDate: '2099-12-01', scheduledHour }, 44200);
    assert.equal(result.status, 'scheduled', scheduledHour);
  }
  assert.equal(plannedChange({ ...offer, scheduledStatus: '승인 완료', scheduledPrice: '44,200', scheduledDate: '2000-01-01' }, 44200), null);
  assert.equal(plannedChange({ ...offer, scheduledStatus: '진행 완료', scheduledPrice: '44,200', scheduledDate: '2000-01-01' }, 44200), null);
});

test('restore uses original price as target and skips an existing restoration', () => {
  const result = reconcileRow(row, [{ ...offer, currentPrice: 44200, scheduledStatus: '진행중', scheduledPrice: '49,800' }], 'restore');
  assert.equal(result.status, 'scheduled');
  assert.equal(result.expectedPrice, 44200);
  assert.equal(result.targetPrice, 49800);
});

test('completed portal approval with a future timestamp skips matching and different targets', () => {
  const pending = { ...offer, scheduledStatus: '완료', scheduledPrice: '44,800', scheduledMargin: '34', scheduledDate: '2099-11-12 20:00:00', scheduledHour: '' };
  assert.equal(plannedChange(pending, 44800).status, 'scheduled');
  assert.equal(plannedChange(pending, 44200).status, 'pending_change');
  assert.equal(plannedChange({ ...pending, scheduledDate: '2000-11-12 20:00:00' }, 44200), null);
});

test('multiple matching products remain ambiguous and mismatches remain reviewable', () => {
  assert.equal(reconcileRow(row, [offer, { ...offer, id: 'product-2' }], 'discount').status, 'ambiguous');
  assert.equal(reconcileRow(row, [{ ...offer, currentPrice: 45000 }], 'discount').status, 'mismatch');
  assert.equal(reconcileRow(row, [], 'discount').status, 'missing');
});

test('TSV header matches Excel support and preserves source row numbers and zeroes', () => {
  const parsed = parseMemo('\uFEFF\n품번\t정상가 (원)\t할인 판매가\n' + source);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.rows, [{ ...row, line: 3 }]);
});

test('conflicting duplicates are rejected while distinct original prices are retained', () => {
  const conflict = parseMemo(source + '\n01026990\t49,800\t43,000');
  assert.equal(conflict.rows.length, 0);
  assert.equal(conflict.errors.length, 2);
  assert.equal(parseMemo(source + '\n01026990\t59,800\t53,000').rows.length, 2);
});

test('missing plan returns null and first save has a recoverable backup', async t => {
  const { file, store } = await temporaryPlan(t);
  assert.equal(await store.load(), null);
  await store.save(plan);
  assert.deepEqual(await store.load(), plan);
  assert.deepEqual(JSON.parse(await readFile(file + '.bak', 'utf8')), plan);
});

test('concurrent saves are serialized and backup contains preceding successful version', async t => {
  const { file, store } = await temporaryPlan(t);
  const second = { ...plan, sourceName: 'second.txt' };
  const third = { ...plan, sourceName: 'third.txt' };
  await Promise.all([store.save(plan), store.save(second), store.save(third)]);
  assert.deepEqual(await store.load(), third);
  assert.deepEqual(JSON.parse(await readFile(file + '.bak', 'utf8')), second);
});

test('corrupt primary recovers from validated backup and preserves damaged evidence', async t => {
  const { file, store } = await temporaryPlan(t);
  await store.save(plan);
  await store.save({ ...plan, sourceName: 'newer.txt' });
  await writeFile(file, '{truncated');
  assert.deepEqual(await store.load(), plan);
  assert.match(store.recoveryMessage, /이전 정상 저장본/);
  assert.equal(await readFile(file, 'utf8'), '{truncated');
  await store.save({ ...plan, sourceName: 'reimported.txt' });
  assert.equal(store.recoveryMessage, '');
  assert.equal((await store.load()).sourceName, 'reimported.txt');
});

test('invalid nested prices and duplicate line IDs never replace a valid saved plan', async t => {
  const { store } = await temporaryPlan(t);
  await store.save(plan);
  for (const rows of [[{ ...row, newPrice: null }], [{ ...row, code: 'wrong' }], [row, row]]) {
    await assert.rejects(store.save({ ...plan, rows }), /품번, 행 번호 또는 가격/);
  }
  assert.deepEqual(await store.load(), plan);
  await store.save({ ...plan, sourceName: 'queue-still-usable.txt' });
  assert.equal((await store.load()).sourceName, 'queue-still-usable.txt');
});

test('corrupt primary and backup produce an intelligible error', async t => {
  const { file, store } = await temporaryPlan(t);
  await writeFile(file, '{}');
  await writeFile(file + '.bak', '{}');
  await assert.rejects(store.load(), /백업을 읽지 못했습니다/);
});

test('a failed backup write preserves the primary file and the save queue recovers', async t => {
  const { file, store } = await temporaryPlan(t);
  await store.save(plan);
  await rm(file + '.bak');
  await mkdir(file + '.bak');
  await assert.rejects(store.save({ ...plan, sourceName: 'failed.txt' }));
  assert.deepEqual(await store.load(), plan);
  assert.equal((await readdir(path.dirname(file))).some(name => name.endsWith('.tmp')), false);
  await rm(file + '.bak', { recursive: true });
  await store.save({ ...plan, sourceName: 'recovered.txt' });
  assert.equal((await store.load()).sourceName, 'recovered.txt');
});

test('UTF-8 BOM saved by a Windows editor is accepted', async t => {
  const { file, store } = await temporaryPlan(t);
  await writeFile(file, '\uFEFF' + JSON.stringify(plan));
  assert.deepEqual(await store.load(), plan);
});
