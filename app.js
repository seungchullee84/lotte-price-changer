const byId = (id) => document.getElementById(id);
const controls = {
  portal: byId("open-portal"),
  details: byId("import-details"),
  importForm: byId("import-form"),
  source: byId("source-text"),
  file: byId("memo-file"),
  save: byId("save-plan"),
  discard: byId("discard-draft"),
  history: byId("history-tools"),
  historySelect: byId("history-select"),
  loadHistory: byId("load-history"),
  downloadHistory: byId("download-history"),
  date: byId("schedule-date"),
  hour: byId("schedule-hour"),
  check: byId("check-prices"),
  run: byId("run-prices"),
  checkAndRun: byId("check-and-run-prices"),
  modes: [...document.querySelectorAll('input[name="mode"]')],
  search: byId("code-filter"),
  filter: byId("result-filter"),
  groups: byId("result-groups"),
  rows: byId("price-rows"),
  priceDialog: byId("price-edit-dialog"),
  priceForm: byId("price-edit-form"),
  priceInput: byId("price-edit-value"),
  priceSave: byId("price-edit-save"),
  priceCancel: byId("price-edit-cancel"),
  priceMessage: byId("price-edit-message"),
};

const moneyFormat = new Intl.NumberFormat("ko-KR");
const dateTimeFormat = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  dateStyle: "short",
  timeStyle: "short",
});
const calendarFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const statusLabels = {
  unchecked: "조회 전",
  ready: "입력 가능",
  already: "목표가 일치",
  scheduled: "목표가 변경 예정",
  pending_change: "변경 진행 중",
  saved: "저장 확인",
  missing: "상품 없음",
  ambiguous: "상품 확인 필요",
  mismatch: "가격 불일치",
  pending: "확인 대기",
  error: "처리 오류",
  interrupted: "처리 중단",
  blocked: "입력 제한",
};
const restoreStatusLabels = { already: "이미 원가격", saved: "복구 예약 확인" };
const resultGroups = [
  {value: "ready", label: "변경 대상", statuses: ["ready"]},
  {value: "missing", label: "상품 없음", statuses: ["missing"]},
  {value: "price_condition", label: "가격 조건 불일치", statuses: ["mismatch", "blocked"]},
  {value: "completed", label: "적용 완료·진행 중", statuses: ["already", "scheduled", "pending_change", "saved"]},
  {value: "additional", label: "추가 확인", statuses: ["unchecked", "pending", "ambiguous", "error", "interrupted"]},
];
const filterStatuses = {
  ...Object.fromEntries(resultGroups.map(group => [group.value, group.statuses])),
  review: ["missing", "ambiguous", "mismatch", "error", "blocked", "interrupted"],
  pending_change: ["scheduled", "pending_change"],
};

let state;
let mode = "discount";
let requestActive = false;
let pollTimer;
let errorMessage = "";
let connectionError = "";
let selectedFileName = "";
let stateNeedsRefresh = true;
let pollActive = false;
let requestVersion = 0;
let pollFailures = 0;
let priceEdit = null;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function savedMemo() {
  return (state?.plan?.sourceText ?? "").replace(/\r\n?/g, "\n");
}

function isDraftEdited() {
  return controls.source.value !== savedMemo();
}

function isLocked() {
  return !state || requestActive || stateNeedsRefresh || state.busy;
}

function hasUnresolvedInput() {
  return Object.values(state?.results ?? {}).some(result => result?.status === "pending" || result?.needsReview);
}

function hasStagedInput() {
  return Object.values(state?.results ?? {}).some(result =>
    result?.status === "pending" && result.offer && !result.needsReview);
}

function refreshControls() {
  const locked = isLocked();
  const edited = isDraftEdited();
  const editingPrice = Boolean(priceEdit);
  const unresolved = hasUnresolvedInput();
  const staged = hasStagedInput();
  const haveRows = (state?.plan?.rows.length ?? 0) > 0;
  const restoring = mode === "restore";
  byId("restore-help").hidden = !restoring;
  controls.run.textContent = restoring ? "복구 대상만 예약" : "변경 대상만 적용";
  controls.checkAndRun.textContent = restoring ? "조회 후 복구 예약" : "조회 후 바로 적용";
  controls.portal.disabled = locked || editingPrice;
  controls.source.disabled = locked || editingPrice;
  controls.file.disabled = locked || editingPrice;
  controls.save.disabled = locked || editingPrice || !edited || !controls.source.value.trim();
  controls.discard.hidden = !state?.plan || !edited;
  controls.discard.disabled = locked || editingPrice;
  controls.historySelect.disabled = locked || edited || editingPrice || controls.history.hidden;
  controls.loadHistory.disabled = controls.historySelect.disabled || !controls.historySelect.value;
  const selectedHistory = (state?.history ?? []).find(item => item.id === controls.historySelect.value);
  const downloadUrl = selectedHistory && /^[a-f0-9]{16}$/.test(selectedHistory.id)
    ? "/api/history/" + selectedHistory.id + "/download" : "";
  controls.downloadHistory.hidden = !downloadUrl;
  if (downloadUrl) controls.downloadHistory.href = downloadUrl;
  else controls.downloadHistory.removeAttribute("href");
  controls.check.textContent = staged ? "입력 상태 확인" : "현재가 조회";
  controls.check.disabled = locked || edited || editingPrice || !haveRows;
  controls.run.disabled = controls.check.disabled || unresolved;
  controls.checkAndRun.disabled = controls.check.disabled || unresolved;
  controls.date.disabled = locked || editingPrice || !haveRows;
  controls.hour.disabled = locked || editingPrice || !haveRows;
  for (const input of controls.modes) {
    input.checked = input.value === mode;
    input.disabled = locked || editingPrice || !haveRows;
  }
  for (const button of controls.rows.querySelectorAll("button[data-line]")) {
    button.disabled = locked || edited || editingPrice || unresolved;
    if (button.dataset.action === "edit-price") {
      button.title = unresolved ? controls.check.textContent + " 후 수정하세요." : "할인 판매가 수정";
    }
  }
  controls.priceInput.disabled = locked || Boolean(priceEdit?.conflict);
  controls.priceSave.disabled = locked || unresolved || Boolean(priceEdit?.conflict);
  controls.priceCancel.disabled = requestActive;
  controls.priceDialog.setAttribute("aria-busy", String(requestActive));
  if (priceEdit?.conflict) controls.priceMessage.textContent = priceEdit.conflict;
}

function currentResults() {
  return state?.mode === mode ? state.results ?? {} : {};
}

function resultForRow(row, results) {
  const result = results[row.line];
  if (result && result.status !== "pending") return result;
  const restriction = mode === "discount"
    ? row.restriction
    : row.currentPrice <= 9900 && "원가격이 9,900원 이하라 복구할 수 없습니다.";
  return restriction ? {status: "blocked", message: restriction} : result;
}

function priceLabel(amount) {
  return Number.isSafeInteger(amount) ? moneyFormat.format(amount) + "원" : "—";
}

function candidateOffers(result) {
  return [result?.offer, ...(result?.offers ?? [])].filter(Boolean);
}

function candidateNames(result) {
  return [...new Set(candidateOffers(result).map(offer => offer.name).filter(name => typeof name === "string" && name.trim()))];
}

function rowMatches(row, result, query, filter) {
  const status = result?.status ?? "unchecked";
  const matchesText = !query || [row.originalCode, row.code, ...candidateNames(result)].some((value) =>
    value.toLocaleLowerCase("ko-KR").includes(query));
  const matchesStatus = !filter || (filterStatuses[filter] ?? [filter]).includes(status);
  return matchesText && matchesStatus;
}

function makeRow(row, result) {
  const tr = element("tr");
  tr.dataset.line = String(row.line);
  const originalCode = element("td");
  originalCode.append(element("span", row.originalCode, "code"));
  for (const name of candidateNames(result)) originalCode.append(element("span", name, "result-message"));
  tr.append(originalCode, element("td", row.code, "code"));

  const originalPrice = element("td", priceLabel(row.currentPrice), "money");
  const discountPrice = element("td", undefined, "money");
  const editPrice = element("button", priceLabel(row.newPrice), "price-edit-button");
  editPrice.type = "button";
  editPrice.dataset.action = "edit-price";
  editPrice.dataset.line = String(row.line);
  editPrice.setAttribute("aria-label", row.originalCode + " 할인 판매가 " + priceLabel(row.newPrice) + " 수정");
  discountPrice.append(editPrice);
  if (Number.isSafeInteger(row.uploadedNewPrice) && row.uploadedNewPrice !== row.newPrice) {
    discountPrice.append(element("span", "업로드 " + priceLabel(row.uploadedNewPrice), "price-original-note"));
  }
  const target = mode === "restore" ? originalPrice : discountPrice;
  target.classList.add("target-price");
  const observedPrices = [...new Set(candidateOffers(result).map(offer => offer.currentPrice).filter(Number.isSafeInteger))];
  const observedLabel = observedPrices.map(priceLabel).join(" / ") || "—";
  tr.append(originalPrice, discountPrice, element("td", observedLabel, "money"));

  const status = result?.status ?? "unchecked";
  const statusCell = element("td");
  let label = (mode === "restore" && restoreStatusLabels[status]) || statusLabels[status];
  if (status === "pending" && !state?.busy) label = "포털 확인";
  const tag = element("span", label ?? "확인 필요", "tag");
  if (Object.hasOwn(statusLabels, status)) tag.classList.add("tag-" + status);
  statusCell.append(tag);
  if (result?.offer?.channel || result?.message) {
    statusCell.append(element("span", [result.offer?.channel, result.message].filter(Boolean).join(" · "), "result-message"));
  }
  if (status === "mismatch") {
    const expected = result.expectedPrice ?? (mode === "restore" ? row.newPrice : row.currentPrice);
    const targetPrice = result.targetPrice ?? (mode === "restore" ? row.currentPrice : row.newPrice);
    statusCell.append(element("span", "기대 현재가 " + priceLabel(expected) + " · 변경 목표가 " + priceLabel(targetPrice) +
      " · 포털 현재가 " + observedLabel, "result-message"));
  }
  const actionCell = element("td");
  if (status === "ready") {
    const button = element("button", mode === "restore" ? "복구가 입력" : "포털 입력", "button button-outline button-table");
    button.type = "button";
    button.dataset.line = String(row.line);
    button.dataset.action = "stage";
    const label = mode === "restore" ? "원가격 복구" : "할인 적용";
    button.setAttribute("aria-label", row.originalCode + " " + label + " 포털 입력");
    actionCell.append(button);
  }
  tr.append(statusCell, actionCell);
  return tr;
}

function renderRows() {
  const rows = state?.plan?.rows ?? [];
  const results = currentResults();
  const savedCount = Object.values(results).filter((result) => result?.status === "saved").length;
  const totalLabel = rows.length ? "총 " + moneyFormat.format(rows.length) + "건" : "";
  const savedLabel = savedCount ? "저장 확인 " + moneyFormat.format(savedCount) + "건" : "";
  byId("work-count").textContent = [totalLabel, savedLabel].filter(Boolean).join(" · ");
  byId("empty-state").hidden = !state || rows.length > 0;
  byId("list-view").hidden = !rows.length;
  const query = controls.search.value.trim().toLocaleLowerCase("ko-KR");
  const filter = controls.filter.value;
  const matchingSearch = rows.map((row) => {
    const result = resultForRow(row, results);
    const status = result?.status ?? "unchecked";
    const group = resultGroups.find(item => item.statuses.includes(status)) ?? resultGroups.at(-1);
    return {row, result, group};
  }).filter(({row, result}) => rowMatches(row, result, query, ""));
  for (const button of controls.groups.querySelectorAll("button[data-result-group]")) {
    const value = button.dataset.resultGroup;
    const count = value ? matchingSearch.filter(item => item.group.value === value).length : matchingSearch.length;
    button.querySelector(".result-group-count").textContent = moneyFormat.format(count);
    button.setAttribute("aria-pressed", String(filter === value));
  }
  const filtered = matchingSearch.filter(({row, result}) => rowMatches(row, result, "", filter));
  const tableRows = [];
  for (const group of resultGroups) {
    const groupRows = filtered.filter(item => item.group === group);
    if (!groupRows.length) continue;
    const heading = element("tr", undefined, "result-group-row");
    heading.dataset.resultGroup = group.value;
    const headingCell = element("th", group.label + " · " + moneyFormat.format(groupRows.length) + "건");
    headingCell.colSpan = 7;
    heading.append(headingCell);
    tableRows.push(heading, ...groupRows.map(({row, result}) => makeRow(row, result)));
  }
  controls.rows.replaceChildren(...tableRows);
  byId("no-filter-results").hidden = filtered.length > 0;
  byId("filter-count").textContent = filtered.length !== rows.length
    ? moneyFormat.format(filtered.length) + "건 표시"
    : "";
}

function renderImport() {
  const plan = state?.plan;
  byId("plan-summary").textContent = plan
    ? ["저장된 목록 " + moneyFormat.format(plan.rows.length) + "건", plan.sourceName, importedAtLabel(plan.importedAt)]
      .filter(Boolean).join(" · ")
    : "";
  byId("import-hint").textContent = selectedFileName
    ? selectedFileName + " · 목록 저장을 누르세요."
    : "엑셀 첫 시트의 A열은 품번, B열은 원가격, C열은 할인 판매가입니다.";
  const errors = plan?.errors ?? [];
  byId("import-errors").hidden = !errors.length;
  byId("import-error-title").textContent = "확인이 필요한 행 " + moneyFormat.format(errors.length) + "건";
  byId("import-error-list").replaceChildren(...errors.map(({line, message}) =>
    element("li", (line ? line + "행 · " : "") + message)));
}

function importedAtLabel(value) {
  const date = value && new Date(value);
  return date && Number.isFinite(date.valueOf()) ? dateTimeFormat.format(date) : "";
}

function renderHistory() {
  const history = state?.history ?? [];
  const previousSelection = controls.historySelect.value;
  controls.history.hidden = !history.length;
  byId("history-count").textContent = history.length ? moneyFormat.format(history.length) + "개 보관" : "";
  controls.historySelect.replaceChildren(
    new Option("보관된 목록 선택", ""),
    ...history.map(({id, importedAt, rowCount, sourceName, current}) => {
      const label = [importedAtLabel(importedAt), sourceName || "직접 붙여넣은 목록", moneyFormat.format(rowCount) + "건", current && "현재 사용 중"]
        .filter(Boolean).join(" · ");
      return new Option(label, id);
    }),
  );
  controls.historySelect.value = history.some(({id}) => id === previousSelection)
    ? previousSelection : history.find(item => item.current)?.id ?? "";
}

function planIdentity(plan) {
  return JSON.stringify([plan?.archiveId, plan?.importedAt, plan?.sourceName, plan?.sourceText]);
}

function closePriceEditor() {
  priceEdit = null;
  controls.priceInput.setCustomValidity("");
  controls.priceMessage.textContent = "";
  controls.priceDialog.close();
}

function cancelPriceEditor() {
  if (requestActive) return;
  closePriceEditor();
  render();
}

function openPriceEditor(line) {
  if (isLocked() || isDraftEdited() || priceEdit || hasUnresolvedInput()) return;
  const row = state.plan?.rows.find(item => item.line === line);
  if (!row) return;
  priceEdit = {
    line, originalCode: row.originalCode, expectedPrice: row.newPrice,
    currentPrice: row.currentPrice, planIdentity: planIdentity(state.plan),
  };
  controls.priceInput.value = String(row.newPrice);
  controls.priceInput.setAttribute("aria-label", row.originalCode + " 할인 판매가");
  controls.priceInput.setCustomValidity("");
  controls.priceMessage.textContent = "";
  byId("price-edit-product").textContent = "품번 " + row.originalCode + " · 원가격 " + priceLabel(row.currentPrice);
  byId("price-edit-hint").textContent = "1원 단위로 " + priceLabel(row.currentPrice) + " 이하를 입력하세요. 9,900원 이하 또는 50% 초과 할인은 저장 후 적용이 제한됩니다.";
  refreshControls();
  renderNotice();
  controls.priceDialog.showModal();
  controls.priceInput.focus();
  controls.priceInput.select();
}

controls.priceForm.addEventListener("submit", event => {
  event.preventDefault();
  if (!priceEdit || controls.priceSave.disabled) return;
  const text = controls.priceInput.value.trim();
  const newPrice = Number(text.replaceAll(",", ""));
  let issue = "";
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text) || !Number.isSafeInteger(newPrice) || newPrice <= 0) {
    issue = "할인 판매가는 1원 이상의 정수로 입력하세요. 예: 44,200";
  } else if (newPrice > priceEdit.currentPrice) {
    issue = "할인 판매가는 원가격 " + priceLabel(priceEdit.currentPrice) + " 이하여야 합니다.";
  }
  controls.priceInput.setCustomValidity(issue);
  controls.priceMessage.textContent = issue;
  if (issue) { controls.priceInput.reportValidity(); return; }
  if (newPrice === priceEdit.expectedPrice) { cancelPriceEditor(); return; }
  const edit = priceEdit;
  edit.submittedPrice = newPrice;
  void send("/api/plan/price", {
    line: edit.line, originalCode: edit.originalCode, newPrice, expectedPrice: edit.expectedPrice,
  }, () => {
    if (priceEdit === edit) throw new Error("저장된 할인 판매가를 확인하지 못했습니다. 현재 목록을 다시 확인합니다.");
  });
});

controls.priceInput.addEventListener("input", () => {
  controls.priceInput.setCustomValidity("");
  if (!priceEdit?.conflict) controls.priceMessage.textContent = "";
});
controls.priceCancel.addEventListener("click", cancelPriceEditor);
controls.priceDialog.addEventListener("cancel", event => {
  event.preventDefault();
  cancelPriceEditor();
});

function resetPlanEditor() {
  closePriceEditor();
  controls.source.value = savedMemo();
  controls.details.open = !state.plan?.rows.length;
  mode = state.mode === "restore" ? "restore" : "discount";
  controls.date.value = state.defaultDate ?? calendarFormat.format(new Date());
  controls.hour.value = state.defaultHour ?? "";
  selectedFileName = "";
  controls.historySelect.value = "";
  controls.search.value = "";
  controls.filter.value = "";
}

function renderNotice() {
  const warnings = byId("startup-warnings");
  warnings.textContent = (state?.warnings ?? []).join(" ");
  warnings.hidden = !warnings.textContent;
  const error = byId("error-message");
  error.textContent = [errorMessage, connectionError].filter(Boolean).join(" ");
  error.hidden = !error.textContent;
  const status = byId("status-message");
  let message = state?.message ?? "";
  if (!state && !errorMessage) message = "저장된 목록을 확인하고 있습니다.";
  if (state?.plan?.rows.length && !state.busy && mode !== state.mode) {
    message = mode === "restore" ? "복구할 상품의 현재가를 조회하세요." : "할인 적용을 위해 현재가를 조회하세요.";
  }
  if (!state?.busy && hasStagedInput()) {
    message = [message, "포털에서 저장하거나 입력을 지운 뒤 입력 상태 확인을 눌러 주세요."].filter(Boolean).join(" ");
  }
  if (!isLocked() && isDraftEdited()) message = "목록을 저장한 뒤 현재가를 조회하세요.";
  if (priceEdit) message = priceEdit.originalCode + " 할인 판매가를 편집 중입니다. 확인으로 저장하거나 취소하세요.";
  status.textContent = message;
  status.hidden = !message;
}

function render() {
  renderImport();
  renderHistory();
  renderRows();
  refreshControls();
  renderNotice();
}

async function readJson(path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {...options, signal: controller.signal});
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("가격 변경기의 응답을 읽지 못했습니다. 연결 상태를 다시 확인합니다.");
    }
    if (response.status === 403) {
      const error = new Error("실행 주소의 인증이 만료되었습니다. 가격변경기 실행 파일로 화면을 다시 열어 주세요.");
      error.connectionFailure = true;
      throw error;
    }
    if (!response.ok || result.error) {
      const error = new Error(result.error ?? "가격 변경기에서 요청을 처리하지 못했습니다.");
      error.status = response.status;
      throw error;
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      error = new Error("서버 응답이 지연되어 현재 처리 상태를 다시 확인합니다.");
    }
    if (error instanceof TypeError) {
      error = new Error("가격 변경기 연결이 끊어졌습니다. 다시 연결하고 있습니다.");
    }
    if (!error.status) error.connectionFailure = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readState(path, payload) {
  const options = payload === undefined ? {cache: "no-store"} : {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  };
  return readJson(path, options, payload === undefined ? 10000 : 120000);
}

function queuePoll(delay) {
  clearTimeout(pollTimer);
  if (requestActive) return;
  const retryDelay = Math.min(1000 * 2 ** Math.min(pollFailures, 4), 10000);
  pollTimer = setTimeout(poll, delay ?? (stateNeedsRefresh ? retryDelay : state?.busy ? 1000 : 5000));
}

function acceptState(next) {
  const previous = state;
  const edited = isDraftEdited();
  state = next;
  stateNeedsRefresh = false;
  connectionError = "";
  pollFailures = 0;
  if (priceEdit) {
    const row = state.plan?.rows.find(item => item.line === priceEdit.line && item.originalCode === priceEdit.originalCode);
    if (!row || planIdentity(state.plan) !== priceEdit.planIdentity) {
      priceEdit.conflict = "다른 창에서 가격 목록을 바꿨습니다. 취소한 뒤 현재 목록을 확인해 주세요.";
    } else if (priceEdit.submittedPrice !== undefined && row.newPrice === priceEdit.submittedPrice) {
      closePriceEditor();
    } else if (row.newPrice !== priceEdit.expectedPrice) {
      priceEdit.conflict = "다른 창에서 할인 판매가가 " + priceLabel(row.newPrice) + "으로 바뀌었습니다. 취소한 뒤 다시 수정해 주세요.";
    } else if (!state.busy) {
      delete priceEdit.submittedPrice;
    }
  }
  if (!previous) {
    resetPlanEditor();
    return;
  }
  if (state.busy || previous.busy || mode === previous.mode) mode = state.mode;
  if (!edited && previous.plan?.sourceText !== state.plan?.sourceText) {
    controls.source.value = savedMemo();
    selectedFileName = "";
    controls.date.value = state.defaultDate;
    controls.hour.value = state.defaultHour;
  }
}

async function poll() {
  if (requestActive || pollActive) return;
  pollActive = true;
  const version = requestVersion;
  let changed = false;
  try {
    const next = await readState("/api/state");
    if (version === requestVersion) {
      changed = stateNeedsRefresh || JSON.stringify(state) !== JSON.stringify(next);
      acceptState(next);
    }
  } catch (error) {
    if (version === requestVersion) {
      stateNeedsRefresh = true;
      connectionError = error.message;
      pollFailures += 1;
      changed = true;
    }
  } finally {
    pollActive = false;
    if (changed) render();
    queuePoll();
  }
}

async function send(path, payload, onSuccess) {
  if (isLocked()) return;
  clearTimeout(pollTimer);
  requestVersion += 1;
  requestActive = true;
  errorMessage = "";
  refreshControls();
  renderNotice();
  try {
    acceptState(await readState(path, payload));
    onSuccess?.();
  } catch (error) {
    if (error.connectionFailure) connectionError = error.message;
    else errorMessage = error.message || "요청을 처리하지 못했습니다.";
    if (priceEdit) controls.priceMessage.textContent = error.message || "가격을 저장하지 못했습니다.";
    stateNeedsRefresh = true;
  } finally {
    requestActive = false;
    render();
    queuePoll(stateNeedsRefresh ? 0 : undefined);
  }
}

function readMemoBytes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
  } catch {
    return new TextDecoder("euc-kr").decode(bytes);
  }
}

async function readWorkbook(file) {
  const result = await readJson("/api/read-xlsx", {
    method: "POST",
    headers: {"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    body: file,
  }, 25000);
  if (typeof result.sourceText !== "string") {
    throw new Error(result.error ?? "엑셀 첫 시트의 A:C열을 읽을 수 없습니다.");
  }
  return result.sourceText;
}

controls.file.addEventListener("change", async () => {
  const [file] = controls.file.files;
  if (!file || isLocked()) return;
  requestActive = true;
  clearTimeout(pollTimer);
  requestVersion += 1;
  errorMessage = "";
  refreshControls();
  try {
    controls.source.value = file.name.toLowerCase().endsWith(".xlsx")
      ? await readWorkbook(file)
      : readMemoBytes(new Uint8Array(await file.arrayBuffer()));
    selectedFileName = file.name;
  } catch (error) {
    if (error.connectionFailure) {
      connectionError = error.message;
      stateNeedsRefresh = true;
    } else {
      errorMessage = error instanceof TypeError
        ? "파일을 읽을 수 없습니다. 내용을 복사해 붙여넣으세요."
        : error.message;
    }
  } finally {
    requestActive = false;
    controls.file.value = "";
    render();
    queuePoll();
  }
});

controls.source.addEventListener("input", () => {
  refreshControls();
  renderNotice();
});

controls.discard.addEventListener("click", () => {
  controls.source.value = savedMemo();
  selectedFileName = "";
  render();
});

controls.importForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (controls.save.disabled) return;
  const payload = {sourceText: controls.source.value};
  if (selectedFileName) payload.sourceName = selectedFileName;
  void send("/api/import", payload, resetPlanEditor);
});

controls.historySelect.addEventListener("change", refreshControls);
controls.loadHistory.addEventListener("click", () => {
  if (controls.loadHistory.disabled) return;
  void send("/api/history/load", {id: controls.historySelect.value}, resetPlanEditor);
});

for (const input of controls.modes) {
  input.addEventListener("change", () => {
    mode = input.value;
    controls.filter.value = "";
    render();
  });
}

controls.portal.addEventListener("click", () => {
  if (!controls.portal.disabled) void send("/api/portal/open", {});
});
controls.check.addEventListener("click", () => {
  if (controls.check.disabled) return;
  if (!hasStagedInput()) controls.filter.value = "";
  void send("/api/portal/check", {mode});
});
for (const [button, endpoint] of [
  [controls.run, "/api/portal/run"],
  [controls.checkAndRun, "/api/portal/check-and-run"],
]) {
  button.addEventListener("click", () => {
    if (button.disabled || !scheduleIsValid()) return;
    controls.filter.value = "";
    void send(endpoint, scheduledChange());
  });
}

function scheduleIsValid() {
  controls.hour.setCustomValidity("");
  if (!controls.date.reportValidity() || !controls.hour.reportValidity()) return false;
  const start = Date.parse(controls.date.value + "T" + controls.hour.value + ":00:00+09:00");
  if (!Number.isFinite(start) || start <= Date.now()) {
    controls.hour.setCustomValidity("적용 시작은 현재 시각 이후로 선택해 주세요.");
    return controls.hour.reportValidity();
  }
  return true;
}

for (const input of [controls.date, controls.hour]) {
  input.addEventListener("input", () => controls.hour.setCustomValidity(""));
}

function scheduledChange() {
  return {mode, date: controls.date.value, hour: controls.hour.value};
}

for (const filter of [controls.search, controls.filter]) {
  filter.addEventListener("input", () => {
    renderRows();
    refreshControls();
  });
}

controls.groups.addEventListener("click", event => {
  const button = event.target.closest("button[data-result-group]");
  if (!button) return;
  controls.filter.value = button.dataset.resultGroup;
  renderRows();
  refreshControls();
});

controls.rows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-line]");
  if (!button || button.disabled) return;
  const line = Number(button.dataset.line);
  if (button.dataset.action === "edit-price") { openPriceEditor(line); return; }
  if (button.dataset.action !== "stage" || !scheduleIsValid()) return;
  void send("/api/portal/stage", {line, ...scheduledChange()});
});

controls.hour.append(new Option("시각 선택", ""));
for (let hour = 0; hour < 24; hour++) {
  const value = String(hour).padStart(2, "0");
  controls.hour.append(new Option(value + "시", value));
}

for (const group of [{value: "", label: "전체"}, ...resultGroups]) {
  const button = element("button", undefined, "result-group-button");
  button.type = "button";
  button.dataset.resultGroup = group.value;
  button.setAttribute("aria-pressed", String(group.value === ""));
  button.append(element("span", group.label), element("span", "0", "result-group-count"));
  controls.groups.append(button);
}

render();
await poll();
