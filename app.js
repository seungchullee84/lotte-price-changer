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
  date: byId("schedule-date"),
  hour: byId("schedule-hour"),
  check: byId("check-prices"),
  run: byId("run-prices"),
  modes: [...document.querySelectorAll('input[name="mode"]')],
  search: byId("code-filter"),
  filter: byId("result-filter"),
  rows: byId("price-rows"),
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
  saved: "저장 확인",
  missing: "상품 없음",
  ambiguous: "상품 확인 필요",
  mismatch: "가격 불일치",
  pending: "확인 대기",
  error: "처리 오류",
  interrupted: "처리 중단",
  blocked: "입력 제한",
};

let state;
let mode = "discount";
let requestActive = false;
let pollTimer;
let errorMessage = "";
let selectedFileName = "";

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
  return !state || requestActive || state.busy;
}

function refreshControls() {
  const locked = isLocked();
  const edited = isDraftEdited();
  const haveRows = (state?.plan?.rows.length ?? 0) > 0;
  controls.portal.disabled = locked;
  controls.source.disabled = locked;
  controls.file.disabled = locked;
  controls.save.disabled = locked || !edited || !controls.source.value.trim();
  controls.discard.hidden = !state?.plan || !edited;
  controls.discard.disabled = locked;
  controls.historySelect.disabled = locked || edited || controls.history.hidden;
  controls.loadHistory.disabled = controls.historySelect.disabled || !controls.historySelect.value;
  controls.check.disabled = locked || edited || !haveRows;
  controls.run.disabled = controls.check.disabled;
  controls.date.disabled = locked || !haveRows;
  controls.hour.disabled = locked || !haveRows;
  for (const input of controls.modes) {
    input.checked = input.value === mode;
    input.disabled = locked || !haveRows;
  }
  for (const button of controls.rows.querySelectorAll("button[data-line]")) {
    button.disabled = locked || edited;
  }
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

function rowMatches(row, result, query, filter) {
  const name = result?.offer?.name ?? "";
  const status = result?.status ?? "unchecked";
  const matchesText = !query || [row.originalCode, row.code, name].some((value) =>
    value.toLocaleLowerCase("ko-KR").includes(query));
  const matchesStatus = !filter || (filter === "review"
    ? ["missing", "ambiguous", "mismatch", "error", "blocked", "interrupted"].includes(status)
    : status === filter);
  return matchesText && matchesStatus;
}

function makeRow(row, result) {
  const tr = element("tr");
  const originalCode = element("td");
  originalCode.append(element("span", row.originalCode, "code"));
  if (result?.offer?.name) originalCode.append(element("span", result.offer.name, "result-message"));
  tr.append(originalCode, element("td", row.code, "code"));

  const originalPrice = element("td", priceLabel(row.currentPrice), "money");
  const discountPrice = element("td", priceLabel(row.newPrice), "money");
  const target = mode === "restore" ? originalPrice : discountPrice;
  target.classList.add("target-price");
  tr.append(originalPrice, discountPrice, element("td", priceLabel(result?.offer?.currentPrice), "money"));

  const status = result?.status ?? "unchecked";
  const statusCell = element("td");
  const label = status === "pending" && !state?.busy ? "포털 확인" : statusLabels[status];
  const tag = element("span", label ?? "확인 필요", "tag");
  if (Object.hasOwn(statusLabels, status)) tag.classList.add("tag-" + status);
  statusCell.append(tag);
  if (result?.offer?.channel || result?.message) {
    statusCell.append(element("span", [result.offer?.channel, result.message].filter(Boolean).join(" · "), "result-message"));
  }
  const actionCell = element("td");
  if (status === "ready") {
    const button = element("button", "포털 입력", "button button-outline button-table");
    button.type = "button";
    button.dataset.line = String(row.line);
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
  const filtered = rows.map((row) => [row, resultForRow(row, results)])
    .filter(([row, result]) => rowMatches(row, result, query, filter));
  controls.rows.replaceChildren(...filtered.map(([row, result]) => makeRow(row, result)));
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
  controls.historySelect.replaceChildren(
    new Option("보관된 목록 선택", ""),
    ...history.map(({id, importedAt, rowCount, sourceName}) => {
      const label = [sourceName, importedAtLabel(importedAt), moneyFormat.format(rowCount) + "건"]
        .filter(Boolean).join(" · ");
      return new Option(label, id);
    }),
  );
  controls.historySelect.value = history.some(({id}) => id === previousSelection) ? previousSelection : "";
}

function resetPlanEditor() {
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
  const error = byId("error-message");
  error.textContent = errorMessage;
  error.hidden = !errorMessage;
  const status = byId("status-message");
  const modeLabel = mode === "restore" ? "원가격 복구" : "할인 적용";
  let message = state?.message ?? "";
  if (!state && !errorMessage) message = "저장된 목록을 확인하고 있습니다.";
  if (state?.plan?.rows.length && !state.busy && mode !== state.mode) {
    message = modeLabel + "을 위해 현재가를 조회하세요.";
  }
  if (!isLocked() && isDraftEdited()) message = "목록을 저장한 뒤 현재가를 조회하세요.";
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

async function readState(path, payload) {
  const options = payload === undefined ? {cache: "no-store"} : {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  };
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(result.error ?? "가격 변경기에서 요청을 처리하지 못했습니다.");
  }
  return result;
}

function queuePoll() {
  clearTimeout(pollTimer);
  if (state?.busy) pollTimer = setTimeout(poll, 1000);
}

async function poll() {
  try {
    state = await readState("/api/state");
    errorMessage = "";
  } catch {
    errorMessage = "조회 상태를 다시 확인하고 있습니다.";
  }
  render();
  queuePoll();
}

async function send(path, payload, onSuccess) {
  if (isLocked()) return;
  requestActive = true;
  errorMessage = "";
  refreshControls();
  renderNotice();
  try {
    state = await readState(path, payload);
    onSuccess?.();
  } catch (error) {
    errorMessage = error.message || "요청을 처리하지 못했습니다.";
  } finally {
    requestActive = false;
    render();
    queuePoll();
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
  const response = await fetch("/api/read-xlsx", {
    method: "POST",
    headers: {"Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    body: file,
  });
  const result = await response.json();
  if (!response.ok || typeof result.sourceText !== "string") {
    throw new Error(result.error ?? "엑셀 첫 시트의 A:C열을 읽을 수 없습니다.");
  }
  return result.sourceText;
}

controls.file.addEventListener("change", async () => {
  const [file] = controls.file.files;
  if (!file || isLocked()) return;
  requestActive = true;
  errorMessage = "";
  refreshControls();
  try {
    controls.source.value = file.name.toLowerCase().endsWith(".xlsx")
      ? await readWorkbook(file)
      : readMemoBytes(new Uint8Array(await file.arrayBuffer()));
    selectedFileName = file.name;
  } catch (error) {
    errorMessage = error instanceof TypeError
      ? "파일을 읽을 수 없습니다. 내용을 복사해 붙여넣으세요."
      : error.message;
  } finally {
    requestActive = false;
    controls.file.value = "";
    render();
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

controls.portal.addEventListener("click", () => void send("/api/portal/open", {}));
controls.check.addEventListener("click", () => {
  controls.filter.value = "";
  void send("/api/portal/check", {mode});
});
controls.run.addEventListener("click", () => {
  if (controls.run.disabled || !scheduleIsValid()) return;
  controls.filter.value = "";
  void send("/api/portal/run", scheduledChange());
});

function scheduleIsValid() {
  return controls.date.reportValidity() && controls.hour.reportValidity();
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

controls.rows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-line]");
  if (!button || button.disabled || !scheduleIsValid()) return;
  const line = Number(button.dataset.line);
  void send("/api/portal/stage", {line, ...scheduledChange()});
});

controls.hour.append(new Option("시각 선택", ""));
for (let hour = 0; hour < 24; hour++) {
  const value = String(hour).padStart(2, "0");
  controls.hour.append(new Option(value + "시", value));
}

try {
  state = await readState("/api/state");
  resetPlanEditor();
} catch {
  errorMessage = "저장된 목록을 불러오지 못했습니다. 가격 변경기를 다시 실행하세요.";
}
render();
queuePoll();
