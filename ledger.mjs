import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function validatePlan(plan) {
  if (!plan || typeof plan.sourceText !== 'string' || !Array.isArray(plan.rows) ||
      !Array.isArray(plan.errors) || typeof plan.importedAt !== 'string' ||
      !Number.isFinite(Date.parse(plan.importedAt))) {
    throw new Error('가격 목록의 저장 형식을 확인해 주세요.');
  }
  const lines = new Set();
  for (const row of plan.rows) {
    if (!row || !Number.isSafeInteger(row.line) || row.line < 1 || lines.has(row.line) ||
        typeof row.originalCode !== 'string' || !/^[0-9]{8}$/.test(row.originalCode) ||
        row.code !== row.originalCode.slice(2) ||
        !Number.isSafeInteger(row.currentPrice) || row.currentPrice <= 0 ||
        !Number.isSafeInteger(row.newPrice) || row.newPrice <= 0) {
      throw new Error('저장된 가격 목록의 품번, 행 번호 또는 가격이 올바르지 않습니다.');
    }
    if ((row.uploadedNewPrice !== undefined || row.priceUpdatedAt !== undefined || row.priceRevision !== undefined) &&
        (!Number.isSafeInteger(row.uploadedNewPrice) || row.uploadedNewPrice <= 0 ||
        typeof row.priceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(row.priceUpdatedAt)) ||
        typeof row.priceRevision !== 'string' || !/^[a-f0-9]{16}$/.test(row.priceRevision))) {
      throw new Error('저장된 할인판매가 수정 기록이 올바르지 않습니다.');
    }
    lines.add(row.line);
  }
  if (plan.errors.some(error => !error || !Number.isSafeInteger(error.line) || error.line < 1 ||
      typeof error.message !== 'string')) {
    throw new Error('저장된 가격 목록의 확인 필요 항목이 올바르지 않습니다.');
  }
  return plan;
}

async function readPlan(file) {
  const contents = await readFile(file, 'utf8');
  return validatePlan(JSON.parse(contents.replace(/^\uFEFF/, '')));
}

async function writeAtomically(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporaryFile, 'wx', 0o600);

  try {
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryFile, file);
  } catch (error) {
    await rm(temporaryFile, { force: true }).catch(() => {});
    throw error;
  }
}

export function openPlan(file) {
  const planFile = path.resolve(file);
  const backupFile = planFile + '.bak';
  let pendingWrite = Promise.resolve();
  let recoveryMessage = '';

  return {
    get recoveryMessage() { return recoveryMessage; },

    async load() {
      await pendingWrite;
      try {
        const current = await readPlan(planFile);
        recoveryMessage = '';
        return current;
      } catch (error) {
        if (error.code && error.code !== 'ENOENT') throw error;
        try {
          const backup = await readPlan(backupFile);
          recoveryMessage = path.basename(planFile) + '을 읽지 못해 이전 정상 저장본을 불러왔습니다. 목록을 확인해 주세요.';
          return backup;
        } catch (backupError) {
          if (error.code === 'ENOENT' && backupError.code === 'ENOENT') return null;
          throw new Error(path.basename(planFile) + '과 백업을 읽지 못했습니다. 원본 파일에서 목록을 다시 불러와 주세요.',
            { cause: error });
        }
      }
    },

    async save(plan) {
      const contents = `${JSON.stringify(validatePlan(plan), null, 2)}\n`;
      const write = pendingWrite.then(async () => {
        let previous;
        try {
          previous = await readPlan(planFile);
        } catch (error) {
          if (error.code && error.code !== 'ENOENT') throw error;
        }
        // Keep a validated snapshot before replacing the primary file.
        if (previous) await writeAtomically(backupFile, `${JSON.stringify(previous, null, 2)}\n`);
        else if (!recoveryMessage) await writeAtomically(backupFile, contents);
        await writeAtomically(planFile, contents);
        recoveryMessage = '';
      });
      // A failed write preserves the existing file and leaves the queue usable.
      pendingWrite = write.catch(() => {});
      await write;
    },
  };
}

export function plannedChange(offer, targetPrice, { checkPendingFirst = false } = {}) {
  const atTarget = offer.currentPrice === targetPrice
    ? { status: 'already', message: '현재 판매가가 목표가와 같습니다. 건너뜀', offer }
    : null;
  if (atTarget && !checkPendingFirst) return atTarget;
  const portalResult = String(offer.portalResult ?? '').replace(/\s+/g, '');
  if (String(offer.portalSuccess ?? '').trim() === 'N' &&
      /이미.*판매가변경.*승인완료.*적용전/.test(portalResult)) {
    return { status: 'pending_change', message: '기존 판매가 변경이 승인 완료 후 적용 대기 중입니다. 건너뜀', offer };
  }
  const status = String(offer.scheduledStatus ?? '').replace(/\s+/g, '');
  if (/(?:취소|반려|거절|실패|철회|해제|종료)(?:완료|됨)?$/.test(status)) return atTarget;
  const scheduledPrice = Number(String(offer.scheduledPrice ?? '').replace(/[,\s원]/g, ''));
  const date = String(offer.scheduledDate ?? '').replace(/\D/g, '');
  const hourText = String(offer.scheduledHour ?? '').trim();
  const clockHour = /^\d{4}$/.test(hourText) ? hourText.slice(0, 2) : hourText.match(/^(\d{1,2})(?:\D|$)/)?.[1];
  const hour = (date.slice(8, 10) || clockHour || '00').padStart(2, '0');
  const scheduledAt = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hour}:00:00+09:00`);
  const active = /진행중|진행$|예정|대기|요청|승인중/.test(status) ||
    (/^(?:완료|저장완료|신청완료|승인완료)$/.test(status) && scheduledAt > Date.now());
  if (!active) return atTarget;
  const sameTarget = Number.isSafeInteger(scheduledPrice) && scheduledPrice > 0 && scheduledPrice === targetPrice;
  return {
    status: sameTarget ? 'scheduled' : 'pending_change',
    message: sameTarget ? '동일한 목표가로 변경 예정·진행 중입니다. 건너뜀' : '기존 가격 변경이 예정·진행 중입니다. 건너뜀',
    offer,
  };
}

export function matchIdentity(a, b) {
  return a.code === b.code && a.id === b.id && a.style === b.style &&
    a.channel === b.channel && a.store === b.store;
}

function offerKey(code, id, channel, store) {
  return JSON.stringify([code, id, channel, store]);
}

export function recordPriceChange(history, change) {
  if (!change || !['discount', 'restore'].includes(change.mode) ||
      typeof change.originalCode !== 'string' || !/^\d{8}$/.test(change.originalCode) ||
      change.originalCode.slice(2) !== change.code ||
      ![change.productId, change.channel, change.store].every(value => typeof value === 'string' && value.trim()) ||
      ![change.fromPrice, change.toPrice].every(value => Number.isSafeInteger(value) && value > 0)) return false;
  const effective = Date.parse(change.effectiveAt);
  const verified = Date.parse(change.verifiedAt);
  if (!Number.isFinite(effective) || !Number.isFinite(verified)) return false;
  const key = offerKey(change.code, change.productId, change.channel, change.store);
  if (!history.has(key)) history.set(key, []);
  history.get(key).push({ ...change, effective, verified });
  return true;
}

function matchesSavedDiscount(row, offer, history, now) {
  const changes = history?.get(offerKey(offer.code, offer.id, offer.channel, offer.store)) ?? [];
  let latest;
  for (const change of changes) {
    if (change.effective > now) continue;
    if (!latest || change.effective > latest.effective ||
        (change.effective === latest.effective && change.verified >= latest.verified)) latest = change;
  }
  return latest?.mode === 'discount' && latest.originalCode === row.originalCode &&
    latest.fromPrice === row.currentPrice && latest.toPrice === offer.currentPrice;
}

export function reconcileRow(row, offers, mode, history) {
  if (mode !== 'discount' && mode !== 'restore') {
    throw new TypeError('할인 또는 원가격 복구 모드를 선택해 주세요.');
  }

  const restoring = mode === 'restore';
  const expectedPrice = restoring ? row.newPrice : row.currentPrice;
  const targetPrice = restoring ? row.currentPrice : row.newPrice;
  const prices = { expectedPrice, targetPrice };

  if (offers.length === 0) return { ...prices, status: 'missing' };

  const now = Date.now();
  const progress = offer => plannedChange(offer, targetPrice, { checkPendingFirst: restoring });
  const matches = offers.filter(offer => offer.currentPrice === expectedPrice ||
    (restoring && matchesSavedDiscount(row, offer, history, now)));
  if (matches.length > 1) return { ...prices, status: 'ambiguous', offers: matches };
  if (matches.length === 1 || offers.length === 1) {
    const offer = matches[0] ?? offers[0];
    const existing = progress(offer);
    const result = { ...prices, expectedPrice: offer.currentPrice, ...(existing ?? { status: 'ready', offer }) };
    if (!existing && offer.currentPrice !== expectedPrice) {
      result.message = matches.length ? '저장 기록에서 적용된 할인 판매가 확인' : '포털 현재가 기준';
    }
    return result;
  }

  const atTarget = offers.filter(offer => offer.currentPrice === targetPrice);
  if (atTarget.length > 1) return { ...prices, status: 'ambiguous', offers: atTarget };
  if (atTarget.length === 1) return { ...prices, ...progress(atTarget[0]) };

  return { ...prices, status: 'ambiguous', offers };
}
