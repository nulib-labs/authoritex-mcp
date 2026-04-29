import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cachedHtml: string | undefined;

export function authoritexAppHtml(): string {
  cachedHtml ??= buildAuthoritexAppHtml();
  return cachedHtml;
}

function buildAuthoritexAppHtml(): string {
  const sdkBundle = readFileSync(
    require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"),
    "utf8"
  ).replace(/<\/script/gi, "<\\/script");
  const appClass = exportedLocalName(sdkBundle, "App");
  const transportClass = exportedLocalName(sdkBundle, "PostMessageTransport");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authoritex</title>
  <style>${appCss()}</style>
</head>
<body>
  <main class="app">
    <header class="app-header">
      <div>
        <p>Northwestern University Libraries</p>
        <h1>Authoritex</h1>
      </div>
      <span>Authority search</span>
    </header>

    <section class="toolbar" aria-label="Search controls">
      <label class="field authority-field">
        <span>Authority</span>
        <select id="authority"></select>
      </label>
      <label class="field query-field">
        <span>Query</span>
        <input id="query" type="search" autocomplete="off" placeholder="Search controlled terms">
      </label>
      <label class="field limit-field">
        <span>Limit</span>
        <input id="max-results" type="number" min="1" max="100" value="10">
      </label>
      <button id="search" type="button">Search</button>
      <button id="clear-cache" type="button" class="secondary">Clear Cache</button>
    </section>

    <section class="workspace">
      <section class="results-panel" aria-label="Search results">
        <div class="panel-heading">
          <h2>Terms</h2>
          <span id="result-count">0 results</span>
        </div>
        <div class="status-row" aria-live="polite">
          <span id="spinner" class="spinner" hidden></span>
          <span id="status" class="status">Open the app with a query or search manually.</span>
        </div>
        <ol id="results" class="results"></ol>
      </section>

      <section class="record-panel" aria-label="Selected record">
        <div class="panel-heading">
          <div class="heading-with-spinner">
            <h2>Record</h2>
            <span id="record-spinner" class="spinner record-spinner" hidden></span>
          </div>
        </div>
        <article id="record" class="record empty">Select a result or fetch a known authority ID.</article>
        <form id="fetch-form" class="fetch-form">
          <label class="field fetch-field">
            <span>Fetch by ID or URI</span>
            <input id="fetch-id" type="text" autocomplete="off" placeholder="http://id.loc.gov/...">
          </label>
          <label class="check">
            <input id="redirect" type="checkbox">
            <span>Follow replacements</span>
          </label>
          <button type="submit">Fetch</button>
        </form>
      </section>
    </section>
  </main>

  <script type="module">
${sdkBundle}

const app = new ${appClass}(
  { name: "AuthoritexApp", version: "0.1.1" },
  {},
  { autoResize: true }
);

const state = {
  authorities: [],
  results: [],
  selectedRecord: null,
  busy: false,
  recordBusyDelay: null,
  searchDelay: null,
  searchRequestId: 0,
  pendingInitialSearch: null
};

const elements = {
  authority: document.getElementById("authority"),
  query: document.getElementById("query"),
  maxResults: document.getElementById("max-results"),
  search: document.getElementById("search"),
  clearCache: document.getElementById("clear-cache"),
  resultCount: document.getElementById("result-count"),
  spinner: document.getElementById("spinner"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  record: document.getElementById("record"),
  recordSpinner: document.getElementById("record-spinner"),
  fetchForm: document.getElementById("fetch-form"),
  fetchId: document.getElementById("fetch-id"),
  redirect: document.getElementById("redirect")
};

app.addEventListener("toolresult", (params) => {
  const payload = params.structuredContent;
  const authorities = payload?.authorities;
  if (Array.isArray(authorities)) {
    setAuthorities(authorities);
  }
  if (payload?.initialSearch) {
    applyInitialSearch(payload.initialSearch);
  }
  if (Array.isArray(payload?.results)) {
    state.results = payload.results;
    renderResults(payload.results);
    setStatus(payload.results.length === 0 ? "No matching terms." : "Search complete.");
  }
});

app.addEventListener("toolinput", (params) => {
  applyInitialSearch(params.arguments);
});

elements.search.addEventListener("click", () => searchTerms());
elements.query.addEventListener("input", () => scheduleSearch());
elements.authority.addEventListener("change", () => scheduleSearch({ delay: 0 }));
elements.maxResults.addEventListener("input", () => scheduleSearch());
elements.query.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    searchTerms();
  }
});
elements.clearCache.addEventListener("click", () => clearCache());
elements.fetchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  fetchRecord(elements.fetchId.value.trim(), elements.redirect.checked);
});

await app.connect(new ${transportClass}(window.parent, window.parent));
setStatus("Ready.");

function setAuthorities(authorities) {
  state.authorities = authorities;
  elements.authority.innerHTML = "";
  for (const authority of authorities) {
    const { code, description } = authority;
    const label = authority.label ?? authorityLabel(code, description);
    const option = document.createElement("option");
    option.value = code;
    option.textContent = label;
    option.title = label;
    elements.authority.append(option);
  }
  const preferred = authorities.find(({ code }) => code === "fast") ?? authorities[0];
  if (preferred) {
    elements.authority.value = preferred.code;
  }
  syncInitialSearch();
}

function authorityLabel(code, description) {
  return description ? \`\${description} (\${code})\` : code;
}

function applyInitialSearch(input) {
  if (!input || typeof input !== "object") {
    return;
  }

  state.pendingInitialSearch = {
    ...state.pendingInitialSearch,
    ...input
  };
  syncInitialSearch();
}

function syncInitialSearch() {
  const input = state.pendingInitialSearch;
  if (!input) {
    return;
  }

  if (
    typeof input.authorityCode === "string" &&
    state.authorities.some(({ code }) => code === input.authorityCode)
  ) {
    elements.authority.value = input.authorityCode;
  }

  if (typeof input.query === "string") {
    elements.query.value = input.query;
  }

  if (typeof input.maxResults === "number" && Number.isFinite(input.maxResults)) {
    elements.maxResults.value = String(input.maxResults);
  }

  if (typeof input.query === "string" && input.query.trim()) {
    setStatus("Opening search...");
  }
}

function scheduleSearch({ delay = 300 } = {}) {
  if (state.searchDelay) {
    clearTimeout(state.searchDelay);
    state.searchDelay = null;
  }

  const query = elements.query.value.trim();
  if (!query) {
    state.results = [];
    renderResults([]);
    setStatus("Enter a query to search.");
    return;
  }

  setStatus("Waiting to search...");
  state.searchDelay = setTimeout(() => {
    state.searchDelay = null;
    searchTerms();
  }, delay);
}

async function searchTerms() {
  if (state.searchDelay) {
    clearTimeout(state.searchDelay);
    state.searchDelay = null;
  }

  const query = elements.query.value.trim();
  if (!query) {
    state.results = [];
    renderResults([]);
    setStatus("Enter a query to search.");
    return;
  }

  const requestId = ++state.searchRequestId;
  setBusy(true, "Searching...");
  try {
    const result = await app.callServerTool({
      name: "search",
      arguments: {
        authorityCode: elements.authority.value,
        query,
        maxResults: Number(elements.maxResults.value) || 10
      }
    });
    const results = extractToolContent(result, "results");
    if (requestId !== state.searchRequestId) {
      return;
    }
    state.results = results;
    renderResults(results);
    setStatus(results.length === 0 ? "No matching terms." : "Search complete.");
  } catch (error) {
    if (requestId !== state.searchRequestId) {
      return;
    }
    setStatus(errorMessage(error));
  } finally {
    if (requestId === state.searchRequestId) {
      setBusy(false);
    }
  }
}

async function fetchRecord(id, redirect = false) {
  if (!id) {
    setStatus("Enter an authority ID or URI to fetch.");
    return;
  }

  setBusy(true, "Fetching record...");
  setRecordBusy(true);
  try {
    const result = await app.callServerTool({
      name: "fetch",
      arguments: { id, redirect }
    });
    const record = extractToolContent(result, "record");
    state.selectedRecord = record;
    elements.fetchId.value = record.id;
    renderRecord(record);
    setStatus("Record loaded.");
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    setRecordBusy(false);
    setBusy(false);
  }
}

async function clearCache() {
  setBusy(true, "Clearing cache...");
  try {
    const result = await app.callServerTool({ name: "cache_clear", arguments: {} });
    extractToolContent(result, "cleared");
    setStatus("Cache cleared.");
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    setBusy(false);
  }
}

function extractToolContent(result, key) {
  if (result.isError) {
    const text = result.content?.map((item) => item.text).filter(Boolean).join("\\n");
    throw new Error(text || "Tool returned an error.");
  }
  if (!result.structuredContent || !(key in result.structuredContent)) {
    throw new Error("Tool result did not include " + key + ".");
  }
  return result.structuredContent[key];
}

function renderResults(results) {
  elements.results.innerHTML = "";
  elements.resultCount.textContent = results.length + (results.length === 1 ? " result" : " results");

  for (const result of results) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "result";
    button.innerHTML = \`
      <span class="result-label"></span>
      <span class="result-id"></span>
      <span class="result-hint"></span>
    \`;
    button.querySelector(".result-label").textContent = result.label || "Untitled term";
    button.querySelector(".result-id").textContent = result.id;
    button.querySelector(".result-hint").textContent = result.hint ?? "";
    button.addEventListener("click", () => fetchRecord(result.id, false));
    item.append(button);
    elements.results.append(item);
  }
}

function renderRecord(record) {
  if (!record) {
    elements.record.className = "record empty";
    elements.record.textContent = "Select a result or fetch a known authority ID.";
    return;
  }

  elements.record.className = "record";
  elements.record.innerHTML = \`
    <h3></h3>
    <dl>
      <dt>ID</dt><dd class="record-id"></dd>
      <dt>Qualified label</dt><dd class="qualified-label"></dd>
      <dt>Hint</dt><dd class="hint"></dd>
      <dt>Variants</dt><dd class="variants"></dd>
      <dt>Related</dt><dd class="related"></dd>
    </dl>
  \`;
  elements.record.querySelector("h3").textContent = record.label || "Untitled term";
  elements.record.querySelector(".record-id").textContent = record.id;
  elements.record.querySelector(".qualified-label").textContent = record.qualified_label || record.label || "";
  elements.record.querySelector(".hint").textContent = record.hint || "None";
  elements.record.querySelector(".variants").append(renderList(record.variants));
  elements.record.querySelector(".related").append(renderRelated(record.related));
}

function renderList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return document.createTextNode("None");
  }
  const list = document.createElement("ul");
  list.className = "inline-list";
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
  return list;
}

function renderRelated(related) {
  const entries = Object.entries(related ?? {}).filter(([, value]) => value);
  if (entries.length === 0) {
    return document.createTextNode("None");
  }
  const list = document.createElement("ul");
  list.className = "inline-list";
  for (const [name, value] of entries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-button";
    button.textContent = name + ": " + value;
    button.addEventListener("click", () => fetchRecord(value, false));
    item.append(button);
    list.append(item);
  }
  return list;
}

function setBusy(busy, message) {
  state.busy = busy;
  elements.spinner.hidden = !busy;
  for (const element of [elements.search, elements.clearCache]) {
    element.disabled = busy;
  }
  if (message) {
    setStatus(message);
  }
}

function setRecordBusy(busy) {
  if (state.recordBusyDelay) {
    clearTimeout(state.recordBusyDelay);
    state.recordBusyDelay = null;
  }

  if (!busy) {
    elements.recordSpinner.hidden = true;
    return;
  }

  state.recordBusyDelay = setTimeout(() => {
    elements.recordSpinner.hidden = false;
    state.recordBusyDelay = null;
  }, 180);
}

function setStatus(message) {
  elements.status.textContent = message;
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
  </script>
</body>
</html>`;
}

function exportedLocalName(bundle: string, exportName: string): string {
  const pattern = new RegExp(`(?:^|,)([A-Za-z_$][\\w$]*)\\s+as\\s+${exportName}(?:,|})`);
  const match = bundle.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not find ${exportName} in MCP Apps bundle exports`);
  }
  return match[1];
}

function appCss(): string {
  return `
:root {
  color-scheme: light;
  --nu-purple: #4e2a84;
  --nu-purple-dark: #401f68;
  --nu-purple-light: #e4e0ee;
  --nu-purple-wash: #f4f1f8;
  --nu-rich-black: #342f2e;
  --nu-gray-50: #faf9fb;
  --nu-gray-100: #f2f1f3;
  --nu-gray-200: #dedbe2;
  --nu-gray-500: #716c6b;
  --nu-white: #ffffff;
  --focus: #b6acd1;
  font-size: 14px;
  font-family: "Poppins", "IBM Plex Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--nu-white);
  color: var(--nu-rich-black);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--nu-white);
}

button,
input,
select {
  font: inherit;
}

.app {
  height: min(560px, 100vh);
  min-height: 500px;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  overflow: hidden;
  padding: 12px;
  background: var(--nu-white);
  border-top: 5px solid var(--nu-purple);
}

.app-header {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.app-header p {
  margin: 0 0 2px;
  color: var(--nu-purple);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.app-header h1 {
  color: var(--nu-rich-black);
  font-size: 19px;
  font-weight: 800;
  line-height: 1.05;
}

.app-header > span {
  color: var(--nu-gray-500);
  font-size: 12px;
  font-weight: 600;
}

.toolbar {
  display: grid;
  grid-template-columns: minmax(120px, 160px) minmax(180px, 1fr) 68px auto auto;
  gap: 8px;
  align-items: end;
  margin-bottom: 10px;
}

.field {
  display: grid;
  gap: 5px;
  min-width: 0;
}

.field span,
.check span {
  color: var(--nu-gray-500);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

input,
select {
  width: 100%;
  min-height: 30px;
  border: 1px solid var(--nu-gray-200);
  border-radius: 6px;
  padding: 6px 9px;
  background: var(--nu-white);
  color: var(--nu-rich-black);
}

input:focus,
select:focus,
button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

button {
  min-height: 30px;
  border: 1px solid var(--nu-purple);
  border-radius: 6px;
  padding: 6px 12px;
  background: var(--nu-purple);
  color: var(--nu-white);
  font-weight: 700;
  cursor: pointer;
}

button.secondary {
  border-color: var(--nu-gray-200);
  background: var(--nu-white);
  color: var(--nu-purple);
}

button.compact {
  min-height: 30px;
  padding: 5px 9px;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  gap: 12px;
  min-height: 0;
  align-items: stretch;
}

.results-panel,
.record-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--nu-gray-200);
  border-radius: 8px;
  background: var(--nu-white);
  box-shadow: 0 1px 0 rgba(52, 47, 46, 0.04);
}

.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: 0 0 auto;
  padding: 9px 11px;
  border-bottom: 1px solid var(--nu-gray-200);
  background: var(--nu-purple-wash);
}

.heading-with-spinner {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

h1,
h2,
h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 800;
  line-height: 1.3;
}

h3 {
  margin-bottom: 14px;
  font-size: 16px;
  color: var(--nu-purple);
}

#result-count,
.status,
.status-row {
  color: var(--nu-gray-500);
  font-size: 11px;
}

.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  min-height: 26px;
  padding: 8px 11px 0;
}

.spinner {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  border: 2px solid var(--nu-purple-light);
  border-top-color: var(--nu-purple);
  border-radius: 50%;
  animation: spin 0.75s linear infinite;
}

.spinner[hidden] {
  display: none;
}

.record-spinner {
  width: 13px;
  height: 13px;
}

.results {
  display: grid;
  align-content: start;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 9px 11px 11px;
  list-style: none;
}

.result {
  display: grid;
  width: 100%;
  min-height: 0;
  border-color: var(--nu-gray-200);
  padding: 9px 10px;
  text-align: left;
  background: var(--nu-gray-50);
  color: var(--nu-rich-black);
}

.result-label {
  font-weight: 700;
  color: var(--nu-purple-dark);
}

.result-id,
.result-hint {
  overflow-wrap: anywhere;
  color: var(--nu-gray-500);
  font-size: 11px;
}

.record {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 11px;
}

.record.empty {
  color: var(--nu-gray-500);
}

dl {
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr);
  gap: 8px 12px;
  margin: 0;
}

dt {
  color: var(--nu-gray-500);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.inline-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
}

.link-button {
  min-height: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--nu-purple);
  text-align: left;
}

.fetch-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: end;
  flex: 0 0 auto;
  padding: 9px 11px 11px;
  border-top: 1px solid var(--nu-gray-200);
  background: var(--nu-gray-50);
}

.check {
  display: flex;
  gap: 7px;
  align-items: center;
  min-height: 32px;
}

.check input {
  width: auto;
  min-height: 0;
}

@media (max-width: 760px) {
  .app {
    height: min(560px, 100vh);
    min-height: 500px;
    padding: 10px;
  }

  .app-header {
    align-items: start;
    margin-bottom: 10px;
  }

  .app-header h1 {
    font-size: 18px;
  }

  .app-header > span {
    display: none;
  }

  .toolbar {
    grid-template-columns: minmax(0, 1fr) 72px minmax(84px, auto) minmax(94px, auto);
    gap: 8px;
    align-items: end;
  }

  .authority-field {
    grid-column: 1 / -1;
  }

  .query-field {
    grid-column: 1 / -1;
  }

  .limit-field {
    grid-column: 1;
  }

  #search {
    grid-column: 2;
    width: 100%;
  }

  #clear-cache {
    grid-column: 3;
    width: 100%;
  }

  .workspace {
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 8px;
  }

  .fetch-form {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .fetch-field {
    grid-column: 1 / -1;
  }

  .fetch-form button {
    min-width: 76px;
  }

  dl {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .app {
    height: min(620px, 100vh);
  }

  .toolbar {
    grid-template-columns: minmax(0, 1fr) 78px;
  }

  .authority-field,
  .query-field,
  #clear-cache {
    grid-column: 1 / -1;
  }

  .limit-field {
    grid-column: 1;
  }

  #search {
    grid-column: 2;
  }

  .workspace {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 0.9fr) minmax(0, 1.1fr);
  }

  .fetch-form {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .fetch-field {
    grid-column: 1 / -1;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
`;
}
