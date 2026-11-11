import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

function validatePlan(plan) {
  if (!plan || typeof plan.sourceText !== 'string' || !Array.isArray(plan.rows) ||
      !Array.isArray(plan.errors) || typeof plan.importedAt !== 'string') {
    throw new Error('가격 목록의 저장 형식을 확인해 주세요.');
  }
  return plan;
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
  let pendingWrite = Promise.resolve();

  return {
    async load() {
      await pendingWrite;
      let contents;
      try {
        contents = await readFile(planFile, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }

      return validatePlan(JSON.parse(contents));
    },

    async save(plan) {
      const contents = `${JSON.stringify(validatePlan(plan), null, 2)}\n`;
      const write = pendingWrite.then(() => writeAtomically(planFile, contents));
      // A failed write preserves the existing file and leaves the queue usable.
      pendingWrite = write.catch(() => {});
      await write;
    },
  };
}

export function reconcileRow(row, offers, mode) {
  if (mode !== 'discount' && mode !== 'restore') {
    throw new TypeError('할인 또는 원가격 복구 모드를 선택해 주세요.');
  }

  const restoring = mode === 'restore';
  const expectedPrice = restoring ? row.newPrice : row.currentPrice;
  const targetPrice = restoring ? row.currentPrice : row.newPrice;
  const prices = { expectedPrice, targetPrice };

  if (offers.length === 0) return { ...prices, status: 'missing' };

  const matches = offers.filter(offer => offer.currentPrice === expectedPrice);
  if (matches.length > 1) return { ...prices, status: 'ambiguous', offers: matches };
  if (matches.length === 1) {
    const status = expectedPrice === targetPrice ? 'already' : 'ready';
    return { ...prices, status, offer: matches[0] };
  }

  const atTarget = offers.filter(offer => offer.currentPrice === targetPrice);
  if (atTarget.length > 1) return { ...prices, status: 'ambiguous', offers: atTarget };
  if (atTarget.length === 1) return { ...prices, status: 'already', offer: atTarget[0] };

  return { ...prices, status: 'mismatch', offers };
}
