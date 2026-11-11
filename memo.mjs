function parseWon(value) {
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/.test(value)) {
    return null;
  }

  const amount = Number(value.replaceAll(',', ''));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

export function parseMemo(text) {
  const rows = [];
  const errors = [];
  const rowsByLookup = new Map();
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|[\r\n]/);
  const headers = [
    new Set(['품번', '상품품번', '스타일코드']),
    new Set(['원가격', '원래가격', '정상가', '현재가', '기존판매가', '기존가격', '기준가']),
    new Set(['할인가', '할인판매가', '변경가', '변경판매가']),
  ];
  let firstContentRow = true;

  for (const [index, rawLine] of lines.entries()) {
    if (!rawLine.trim()) continue;

    const line = index + 1;
    const columns = rawLine.split('\t').map(column => column.trim());
    const isHeader = firstContentRow && columns.length === 3 && columns.every((column, index) =>
      headers[index].has(column.replace(/\s+/g, '').replace(/\(원\)$/, '')));
    firstContentRow = false;
    if (isHeader) continue;
    if (columns.length !== 3) {
      errors.push({ line, message: '탭으로 구분된 품번, 원가격, 할인 판매가 세 항목이 필요합니다.' });
      continue;
    }

    const [originalCode, currentText, newText] = columns;
    if (!/^[0-9]{8}$/.test(originalCode)) {
      errors.push({ line, message: '품번은 앞의 0을 포함해 숫자 8자리여야 합니다.' });
      continue;
    }

    const currentPrice = parseWon(currentText);
    const newPrice = parseWon(newText);
    if (currentPrice === null || newPrice === null) {
      errors.push({ line, message: '원가격과 할인 판매가에는 0보다 큰 원 단위 정수를 입력해 주세요.' });
      continue;
    }

    const code = originalCode.slice(2);
    const key = `${code}:${currentPrice}`;
    if (!rowsByLookup.has(key)) rowsByLookup.set(key, []);
    rowsByLookup.get(key).push({ line, originalCode, code, currentPrice, newPrice });
  }

  for (const group of rowsByLookup.values()) {
    const [first, ...repeats] = group;
    const prices = new Set(group.map(row => row.newPrice));
    const originalCodes = new Set(group.map(row => row.originalCode));
    if (prices.size > 1 || originalCodes.size > 1) {
      const locations = group.map(row => row.line).join(', ');
      const reason = prices.size > 1 ? '할인 판매가가 다릅니다' : '8자리 원본 품번이 다릅니다';
      for (const row of group) {
        errors.push({ line: row.line, message: `조회 품번과 원가격이 같은 줄(${locations})의 ${reason}.` });
      }
      continue;
    }

    rows.push(first);
    for (const row of repeats) {
      errors.push({ line: row.line, message: `${first.line}번째 줄과 중복됩니다.` });
    }
  }

  errors.sort((a, b) => a.line - b.line);
  return { rows, errors };
}
