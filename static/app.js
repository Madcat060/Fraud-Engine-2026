/**
 * Legacy shell for templates/index.html: Reports + Report Viewer (mostly this file) and Game Integrity extras.
 * Trust & Safety triage + case modal live in React (static/dist). Calls to /api/ews/* and /api/gi/* target the
 * legacy monolith (app.py) if present; they are not implemented on backend_v2.service_fraud alone.
 */
const API = '';
/** Reports Service (profiles, report-lists, reports, run, scheduler) – port 5000 when using split services. */
const REPORTS_API = 'http://localhost:5000';
let currentProfileId = null;
let currentListId = null;
let modalCallback = null;
let isRunning = false;

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.getElementById('reportsTabContent').classList.toggle('active', tabId === 'reports');
    const giEl = document.getElementById('giTabContent');
    if (giEl) giEl.classList.toggle('active', tabId === 'gi');
    if (tabId === 'reports') switchReportsSubTab(lastReportsSubTab || 'profile-lists');
    if (tabId === 'gi') switchGiSubTab('gi-triage');
}
let lastGiSubTab = 'gi-triage';
function switchGiSubTab(subTabId) {
    lastGiSubTab = subTabId;
    const triagePanel = document.getElementById('giTriageSubContent');
    if (triagePanel) triagePanel.style.display = 'block';
}

let lastReportsSubTab = 'profile-lists';

function switchReportsSubTab(subTabId) {
    lastReportsSubTab = subTabId;
    document.querySelectorAll('.sub-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.subtab === subTabId);
    });
    document.getElementById('profileListsSubContent').classList.toggle('active', subTabId === 'profile-lists');
    document.getElementById('runScheduleSubContent').classList.toggle('active', subTabId === 'run-schedule');
    const rv = document.getElementById('reportViewerSubContent');
    if (rv) rv.classList.toggle('active', subTabId === 'report-viewer');
    document.getElementById('defaultsSubContent').classList.toggle('active', subTabId === 'defaults');
    const od = document.getElementById('opsDashboardSubContent');
    if (od) od.classList.toggle('active', subTabId === 'ops-dashboard');
    if (subTabId === 'ops-dashboard') opsDashboardOnShow();
    else opsDashboardStopAuto();
}

function clearResults() {
    const el = document.getElementById('resultsOutput');
    if (el) el.innerHTML = '';
}

function switchReportCardTab(cardEl, tabName) {
    if (!cardEl) return;
    cardEl.querySelectorAll('.report-card-tab').forEach(t => t.classList.remove('active'));
    cardEl.querySelectorAll('.report-card-panel').forEach(p => p.classList.remove('active'));
    const tabBtn = cardEl.querySelector(`.report-card-tab[data-panel="${tabName}"]`);
    const panel = cardEl.querySelector(`.report-card-panel[data-panel="${tabName}"]`);
    if (tabBtn) tabBtn.classList.add('active');
    if (panel) panel.classList.add('active');
}

document.addEventListener('DOMContentLoaded', () => {
    applyLabsRouteAndFeatureFlags();
    loadDefaults();
    loadProfiles();
    setDefaultDates();
    document.getElementById('profileSelect').addEventListener('change', onProfileChange);
    document.getElementById('reportListSelect').addEventListener('change', onReportListChange);
    startSchedulerStream();
    if (document.getElementById('csvToDbRows') && !document.querySelector('.import-csv-db-item'))
        addCsvDbRow();
});

/**
 * EWS ClickUp-style theme is default. /labs/ews staging route shows same content as main EWS.
 */
async function applyLabsRouteAndFeatureFlags() {
    const pathname = (window.location.pathname || '').replace(/\/+$/, '');
    const isLabsEws = pathname === '/labs/ews';
    const isRulesPage = pathname === '/rules';
    window.ewsLabsRoute = isLabsEws;
    if (isLabsEws || isRulesPage) {
        switchTab('gi');
        switchGiSubTab('gi-triage');
    }
    /* Theme is default: always apply .cu-theme so EWS styles are namespaced and canvas is wider */
    document.body.classList.add('ews-clickup-theme', 'cu-theme');
    window.ewsClickupThemeEnabled = true;
}

function startSchedulerStream() {
    const logEl = document.getElementById('schedulerLogWindow');
    if (!logEl) return;
    try {
        const es = new EventSource(REPORTS_API + '/api/scheduler/stream');
        es.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.type === 'msg' && data.text) {
                    addSchedulerLogEntry(data.text);
                } else if (data.type === 'curl' && data.text) {
                    setSchedulerCurl(data.text);
                } else if (data.type === 'db_result' && data.payload) {
                    addDbResultToResults(data.payload, 'schedule');
                } else if (data.type === 'done') {
                    addSchedulerLogEntry('---', 'info');
                    addSchedulerLogEntry('Execution complete.', 'info');
                }
            } catch (err) {}
        };
        es.onerror = () => { es.close(); setTimeout(startSchedulerStream, 3000); };
    } catch (err) {}
}

function addSchedulerLogEntry(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logWindow = document.getElementById('schedulerLogWindow');
    if (logWindow) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = `[${time}] ${message}`;
        logWindow.appendChild(entry);
        logWindow.scrollTop = logWindow.scrollHeight;
    }
    const resultsOutput = document.getElementById('resultsOutput');
    if (resultsOutput) {
        const row = document.createElement('div');
        row.className = `results-row results-${type} results-schedule`;
        row.innerHTML = `<span class="results-time">${time}</span><span class="results-source">Schedule</span><span class="results-msg">${escapeHtmlResults(message)}</span>`;
        resultsOutput.appendChild(row);
        resultsOutput.scrollTop = resultsOutput.scrollHeight;
    }
}

function setSchedulerCurl(curlText) {
    const el = document.getElementById('schedulerCurlWindow');
    if (!el) return;
    el.textContent = curlText;
    el.scrollTop = el.scrollHeight;
}

function clearSchedulerLog() {
    const logWindow = document.getElementById('schedulerLogWindow');
    if (logWindow) logWindow.innerHTML = '';
    const curlWindow = document.getElementById('schedulerCurlWindow');
    if (curlWindow) curlWindow.innerHTML = '';
}

async function saveSchedule(reportId, btnEl) {
    if (!btnEl) return;
    const origText = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = 'Saving...';
    try {
        await saveReportCard(reportId);
        btnEl.textContent = 'Saved';
        btnEl.classList.add('btn-saved');
        setTimeout(() => {
            btnEl.textContent = origText;
            btnEl.classList.remove('btn-saved');
            btnEl.disabled = false;
        }, 2000);
    } catch (e) {
        btnEl.textContent = 'Error';
        setTimeout(() => {
            btnEl.textContent = origText;
            btnEl.disabled = false;
        }, 2000);
    }
}

async function loadDefaults() {
    try {
        const s = await apiCall('/api/settings');
        document.getElementById('defaultDbConn').value = s.default_db_connection_string || '';
    } catch (e) {
        console.warn('Could not load defaults:', e);
    }
}

async function saveDefaults() {
    try {
        const payload = {
            default_db_connection_string: document.getElementById('defaultDbConn').value
        };
        await apiCall('/api/settings', 'PUT', payload);
        alert('Defaults saved.');
    } catch (e) {
        alert('Failed to save: ' + e.message);
    }
}

async function reportViewerRun() {
    const queryEl = document.getElementById('reportViewerQuery');
    const statusEl = document.getElementById('reportViewerStatus');
    const wrapEl = document.getElementById('reportViewerResultsWrap');
    const errorEl = document.getElementById('reportViewerError');
    const emptyEl = document.getElementById('reportViewerEmpty');
    const rowCountEl = document.getElementById('reportViewerRowCount');
    const thead = document.getElementById('reportViewerThead');
    const tbody = document.getElementById('reportViewerTbody');
    const btn = document.getElementById('btnReportViewerRun');

    const query = (queryEl && queryEl.value || '').trim();
    if (!query) {
        statusEl.textContent = 'Enter a query.';
        return;
    }

    if (btn) btn.disabled = true;
    statusEl.textContent = 'Running…';
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
    if (emptyEl) emptyEl.style.display = 'none';
    wrapEl.style.display = 'none';
    rowCountEl.textContent = '';

    try {
        const data = await apiCall('/api/report-viewer/run', 'POST', { query });
        statusEl.textContent = 'Done.';
        if (rowCountEl) {
            rowCountEl.textContent = data.total_rows + ' row(s)' + (data.truncated ? ' (truncated)' : '');
        }
        thead.innerHTML = '';
        tbody.innerHTML = '';
        if (!data.columns || !data.columns.length) {
            if (emptyEl) { emptyEl.style.display = 'block'; emptyEl.textContent = 'No columns returned.'; }
        } else {
            const tr = document.createElement('tr');
            data.columns.forEach(col => {
                const th = document.createElement('th');
                th.textContent = col;
                tr.appendChild(th);
            });
            thead.appendChild(tr);
            (data.rows || []).forEach(row => {
                const tr = document.createElement('tr');
                data.columns.forEach(col => {
                    const td = document.createElement('td');
                    const v = row[col];
                    td.textContent = v == null ? '' : String(v);
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            wrapEl.style.display = 'block';
        }
    } catch (e) {
        statusEl.textContent = '';
        errorEl.textContent = e.message || 'Request failed';
        errorEl.style.display = 'block';
        wrapEl.style.display = 'none';
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function reportViewerLoadSchema() {
    const connEl = document.getElementById('reportViewerSchemaConn');
    const statusEl = document.getElementById('reportViewerSchemaStatus');
    const wrapEl = document.getElementById('reportViewerSchemaWrap');
    const btn = document.getElementById('btnReportViewerSchema');
    const conn = (connEl && connEl.value || '').trim();
    if (btn) btn.disabled = true;
    statusEl.textContent = 'Loading…';
    wrapEl.style.display = 'none';
    wrapEl.innerHTML = '';
    try {
        const data = await apiCall('/api/report-viewer/schema', 'POST', conn ? { db_connection_string: conn } : {});
        statusEl.textContent = (data.tables && data.tables.length) ? data.tables.length + ' table(s) loaded.' : 'No tables found.';
        if (!data.tables || !data.tables.length) {
            wrapEl.innerHTML = '<p class="section-hint">No tables in this database (or connection failed).</p>';
            wrapEl.style.display = 'block';
        } else {
            const frag = document.createDocumentFragment();
            const table = document.createElement('table');
            table.className = 'report-viewer-schema-table';
            table.innerHTML = '<thead><tr><th>Schema</th><th>Table</th><th>Columns (headers)</th></tr></thead><tbody></tbody>';
            const tbody = table.querySelector('tbody');
            data.tables.forEach(({ schema: sch, table: tbl, columns }) => {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td>' + escapeHtml(sch || '') + '</td><td>' + escapeHtml(tbl) + '</td><td>' + escapeHtml(columns ? columns.join(', ') : '') + '</td>';
                tbody.appendChild(tr);
            });
            frag.appendChild(table);
            wrapEl.appendChild(frag);
            wrapEl.style.display = 'block';
        }
    } catch (e) {
        statusEl.textContent = '';
        wrapEl.innerHTML = '<p class="report-viewer-error">' + escapeHtml(e.message || 'Request failed') + '</p>';
        wrapEl.style.display = 'block';
    } finally {
        if (btn) btn.disabled = false;
    }
}

function escapeHtml(s) {
    if (s == null) return '';
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
}

function switchReportViewerTab(tabId) {
    document.querySelectorAll('.report-viewer-inner-tab').forEach(btn => {
        btn.classList.toggle('active', (btn.dataset.rvTab || '') === tabId);
    });
    document.getElementById('reportViewerQueryPanel').style.display = tabId === 'query' ? 'block' : 'none';
    document.getElementById('reportViewerCollusionPanel').style.display = tabId === 'collusion' ? 'block' : 'none';
    if (tabId === 'collusion' && !window.reportViewerCollusionRendered) {
        window.reportViewerCollusionRendered = true;
        renderReportViewerCollusionList();
    }
}

const COLLUSION_QUERIES = [
    { id: 'earnings-from-other-players', name: 'Earnings from other players (Paid rake, Earnings from others, Currency)', sql: 'SELECT "Nickname", "Paid rake", "Paid total rake", "Earnings from others/loss to others", "Original currency" FROM "earnings-from-other-players" LIMIT 500' },
    { id: 'high-rake-players', name: 'Players with high paid rake (top 100)', sql: 'SELECT "Nickname", "Paid rake", "Paid total rake", "Earnings from others/loss to others", "Original currency" FROM "earnings-from-other-players" ORDER BY "Paid rake" DESC NULLS LAST LIMIT 100' },
    { id: 'major-income-sessions', name: 'Major income sessions (Player, Win %, Hands Played)', sql: 'SELECT "Player", "Poker player code", "Win %", "Hands Played" FROM "major-income-sessions" LIMIT 500' },
    { id: 'private-hand-search', name: 'Private hand search cash (recent hands)', sql: 'SELECT * FROM "private-hand-search-cash" ORDER BY "Game End Date" DESC NULLS LAST LIMIT 200' },
    { id: 'player-pairs-common-games', name: 'Player pairs with many common sessions (collusion signal)', sql: 'SELECT a."Nickname" AS player_a, b."Nickname" AS player_b, COUNT(*) AS common_sessions FROM "earnings-from-other-players" a JOIN "earnings-from-other-players" b ON a."Nickname" < b."Nickname" GROUP BY a."Nickname", b."Nickname" HAVING COUNT(*) > 5 ORDER BY COUNT(*) DESC LIMIT 100' },
];

function renderReportViewerCollusionList() {
    const listEl = document.getElementById('reportViewerCollusionList');
    if (!listEl) return;
    listEl.innerHTML = COLLUSION_QUERIES.map(q => `
        <div class="report-viewer-collusion-item">
            <div class="report-viewer-collusion-name">${escapeHtml(q.name)}</div>
            <div class="report-viewer-collusion-actions">
                <button type="button" class="btn btn-secondary btn-sm" onclick="reportViewerLoadCollusionQuery('${escapeHtml(q.id)}')">Load into Query</button>
                <button type="button" class="btn btn-primary btn-sm" onclick="reportViewerRunCollusionQuery('${escapeHtml(q.id)}')">Run</button>
            </div>
        </div>
    `).join('');
}

function reportViewerLoadCollusionQuery(id) {
    const q = COLLUSION_QUERIES.find(x => x.id === id);
    if (!q) return;
    const queryEl = document.getElementById('reportViewerQuery');
    if (queryEl) queryEl.value = q.sql;
    switchReportViewerTab('query');
}

async function reportViewerRunCollusionQuery(id) {
    const q = COLLUSION_QUERIES.find(x => x.id === id);
    if (!q) return;
    const thead = document.getElementById('reportViewerCollusionThead');
    const tbody = document.getElementById('reportViewerCollusionTbody');
    const wrap = document.getElementById('reportViewerCollusionResultsWrap');
    const errEl = document.getElementById('reportViewerCollusionError');
    const rowCountEl = document.getElementById('reportViewerCollusionRowCount');
    thead.innerHTML = '';
    tbody.innerHTML = '';
    wrap.style.display = 'none';
    errEl.style.display = 'none';
    errEl.textContent = '';
    rowCountEl.textContent = '';
    try {
        const data = await apiCall('/api/report-viewer/run', 'POST', { query: q.sql });
        rowCountEl.textContent = (data.total_rows || 0) + ' row(s)' + (data.truncated ? ' (truncated)' : '');
        if (data.columns && data.columns.length) {
            const tr = document.createElement('tr');
            data.columns.forEach(c => { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); });
            thead.appendChild(tr);
            (data.rows || []).forEach(row => {
                const tr = document.createElement('tr');
                data.columns.forEach(col => { const td = document.createElement('td'); td.textContent = row[col] != null ? String(row[col]) : ''; tr.appendChild(td); });
                tbody.appendChild(tr);
            });
            wrap.style.display = 'block';
        }
    } catch (e) {
        errEl.textContent = e.message || 'Request failed';
        errEl.style.display = 'block';
    }
}

function setDefaultDates() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    document.getElementById('dateFrom').value = formatDateTimeLocal(yesterday);
    document.getElementById('dateTo').value = formatDateTimeLocal(yesterday);
}

function formatDate(d) {
    return d.toISOString().split('T')[0];
}

/** Format as yyyy-mm-ddThh:mm for datetime-local inputs (browser shows local time). */
function formatDateTimeLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day}T${h}:${min}`;
}

function validateDates() {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    const errorEl = document.getElementById('dateError');
    if (from && to && to.replace('T', ' ') < from.replace('T', ' ')) {
        errorEl.style.display = '';
        return false;
    }
    errorEl.style.display = 'none';
    return true;
}

async function apiCall(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

/** Use for profile, report-list, report, run, and scheduler APIs (Reports Service on port 5000). */
async function reportsApiCall(url, method = 'GET', body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(REPORTS_API + url, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

async function loadProfiles() {
    const profiles = await reportsApiCall('/api/profiles');
    const select = document.getElementById('profileSelect');
    const savedId = currentProfileId;
    select.innerHTML = '<option value="">-- Select a profile --</option>';
    profiles.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        select.appendChild(opt);
    });
    if (savedId && profiles.find(p => p.id === savedId)) {
        select.value = savedId;
    }
    onProfileChange();
}

function onProfileChange() {
    const select = document.getElementById('profileSelect');
    currentProfileId = select.value || null;
    const hasProfile = !!currentProfileId;

    document.getElementById('btnEditProfile').disabled = !hasProfile;
    document.getElementById('btnDeleteProfile').disabled = !hasProfile;
    document.getElementById('reportsSection').style.display = hasProfile ? '' : 'none';

    if (hasProfile) {
        loadReportLists();
    } else {
        currentListId = null;
        updateReportListUI();
    }
}

async function loadReportLists() {
    const lists = await reportsApiCall(`/api/profiles/${currentProfileId}/report-lists`);
    const select = document.getElementById('reportListSelect');
    const savedId = currentListId;
    select.innerHTML = '<option value="">-- Select a report list --</option>';
    lists.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        select.appendChild(opt);
    });
    if (savedId && lists.find(l => l.id === savedId)) {
        select.value = savedId;
    } else {
        currentListId = null;
    }
    onReportListChange();
}

function onReportListChange() {
    const select = document.getElementById('reportListSelect');
    currentListId = select.value || null;
    updateReportListUI();
    if (currentListId) {
        loadReports();
    }
}

function updateReportListUI() {
    const hasList = !!currentListId;
    document.getElementById('btnEditList').disabled = !hasList;
    document.getElementById('btnDeleteList').disabled = !hasList;
    document.getElementById('reportGridContainer').style.display = hasList ? '' : 'none';
}

async function loadReports() {
    const reports = await reportsApiCall(`/api/report-lists/${currentListId}/reports`);
    const container = document.getElementById('reportCardsContainer');
    const emptyMsg = document.getElementById('emptyGridMessage');

    if (reports.length === 0) {
        container.innerHTML = '';
        emptyMsg.style.display = '';
        return;
    }

    emptyMsg.style.display = 'none';
    container.innerHTML = '';

    reports.forEach((r, idx) => {
        const card = document.createElement('div');
        card.className = 'report-card collapsed';
        card.dataset.reportId = r.id;
        const reportLabel = extractReportInfo(r.api_curl) || `Report #${idx + 1}`;
        const reportName = (r.filename || '').trim() || 'Report';
        const headerTitle = `${escHtml(reportName)} — ${escHtml(reportLabel)}`;
        const activeChecked = r.active !== false && r.active !== 'false';
        card.innerHTML = `
            <div class="report-card-header" onclick="toggleCard(this.parentElement)">
                <div class="report-card-title-area">
                    <span class="report-card-toggle">&#9654;</span>
                    <label class="report-active-label" onclick="event.stopPropagation()">
                        <input type="checkbox" class="report-active" ${activeChecked ? 'checked' : ''} onchange="saveReportCard('${r.id}')"> Activate
                    </label>
                    <span class="report-card-number">${headerTitle}</span>
                    ${r.schedule_enabled ? '<span class="report-badge report-badge-scheduled">Scheduled</span>' : ''}
                </div>
                <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteReport('${r.id}')">Delete</button>
            </div>
            <div class="report-card-body">
                <div class="report-card-tabs">
                    <button type="button" class="report-card-tab active" data-panel="api" onclick="switchReportCardTab(this.closest('.report-card'), 'api')">API</button>
                    <button type="button" class="report-card-tab" data-panel="file" onclick="switchReportCardTab(this.closest('.report-card'), 'file')">File settings</button>
                    <button type="button" class="report-card-tab" data-panel="db" onclick="switchReportCardTab(this.closest('.report-card'), 'db')">DB settings</button>
                    <button type="button" class="report-card-tab" data-panel="population" onclick="switchReportCardTab(this.closest('.report-card'), 'population')">Report population</button>
                    <button type="button" class="report-card-tab" data-panel="schedule" onclick="switchReportCardTab(this.closest('.report-card'), 'schedule')">Schedule</button>
                </div>
                <div class="report-card-panel active" data-panel="api">
                    <div class="report-card-row">
                        <div class="report-field report-field-full">
                            <label>cURL command</label>
                            <textarea rows="2" onchange="saveReportCard('${r.id}')">${escHtml(r.api_curl)}</textarea>
                        </div>
                    </div>
                </div>
                <div class="report-card-panel" data-panel="file">
                    <div class="report-card-row">
                        <div class="report-field report-field-grow">
                            <label>Filename</label>
                            <input type="text" value="${escHtml(r.filename)}" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-grow">
                            <label>Save To (folder path)</label>
                            <input type="text" value="${escHtml(r.save_to)}" placeholder="e.g. C:\\Reports\\Output" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-sm">
                            <label>Days</label>
                            <input type="number" value="${escHtml(r.days)}" min="1" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-md">
                            <label>Recurrence</label>
                            <select onchange="saveReportCard('${r.id}')">
                                <option value="" ${r.recurrence === '' ? 'selected' : ''}>None</option>
                                <option value="day" ${r.recurrence === 'day' ? 'selected' : ''}>Day</option>
                                <option value="week" ${r.recurrence === 'week' ? 'selected' : ''}>Week</option>
                                <option value="month" ${r.recurrence === 'month' ? 'selected' : ''}>Month</option>
                            </select>
                        </div>
                        <div class="report-field report-field-md">
                            <label>Output Mode</label>
                            <select onchange="saveReportCard('${r.id}')">
                                <option value="csv" ${r.output_mode === 'csv' ? 'selected' : ''}>CSV</option>
                                <option value="db" ${r.output_mode === 'db' ? 'selected' : ''}>DB</option>
                                <option value="both" ${r.output_mode === 'both' ? 'selected' : ''}>Both</option>
                            </select>
                        </div>
                    </div>
                    <div class="report-card-row">
                        <div class="report-field report-field-md">
                            <label>Date Format</label>
                            <select onchange="saveReportCard('${r.id}')">
                                <option value="" ${r.date_format === '' ? 'selected' : ''}>Auto-detect</option>
                                <option value="date" ${r.date_format === 'date' ? 'selected' : ''}>Date only (YYYY-MM-DD)</option>
                                <option value="datetime" ${r.date_format === 'datetime' ? 'selected' : ''}>Date + Time (YYYY-MM-DD HH:MM:SS)</option>
                                <option value="datetime_short" ${r.date_format === 'datetime_short' ? 'selected' : ''}>Date + Time Short (YYYY-MM-DD HH:MM)</option>
                            </select>
                        </div>
                        <div class="report-field report-field-md">
                            <label>Send times in</label>
                            <select onchange="saveReportCard('${r.id}')">
                                <option value="" ${(r.api_timezone || '').toLowerCase() === 'local' ? 'selected' : ''}>Local (no conversion)</option>
                                <option value="GMT" ${(r.api_timezone || '').toLowerCase() !== 'local' ? 'selected' : ''}>GMT/UTC (default)</option>
                            </select>
                        </div>
                    </div>
                </div>
                <div class="report-card-panel" data-panel="db">
                    <div class="report-card-row">
                        <div class="report-field report-field-quarter">
                            <label>DB Table Name</label>
                            <input type="text" value="${escHtml(r.db_table_name)}" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-lg">
                            <label>DB Connection String</label>
                            <input type="text" value="${escHtml(r.db_connection_string)}" placeholder="e.g. mssql+pyodbc://..." onchange="saveReportCard('${r.id}')">
                        </div>
                    </div>
                </div>
                <div class="report-card-panel" data-panel="population">
                    <div class="report-card-row">
                        <div class="report-field report-field-grow">
                            <label>Nickname (nickname=)</label>
                            <input type="text" value="${escHtml(r.nickname || '')}" placeholder="Only used if API uses nickname=" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-grow">
                            <label>Username (username=)</label>
                            <input type="text" value="${escHtml(r.username || '')}" placeholder="Only used if API uses username=" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-grow">
                            <label>Player code (playercode/player_code)</label>
                            <input type="text" value="${escHtml(r.player_code || '')}" placeholder="Only used if API uses playercode etc." onchange="saveReportCard('${r.id}')">
                        </div>
                    </div>
                    <div class="report-card-row">
                        <div class="report-field report-field-grow">
                            <label>Player 1 (plr_1)</label>
                            <input type="text" value="${escHtml((r.player_params && r.player_params.plr_1) || '')}" placeholder="Optional player nickname" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-grow">
                            <label>Player 2 (plr_2)</label>
                            <input type="text" value="${escHtml((r.player_params && r.player_params.plr_2) || '')}" placeholder="Optional player nickname" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-grow">
                            <label>Player 3 (plr_3)</label>
                            <input type="text" value="${escHtml((r.player_params && r.player_params.plr_3) || '')}" placeholder="Optional player nickname" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-grow">
                            <label>Player 4 (plr_4)</label>
                            <input type="text" value="${escHtml((r.player_params && r.player_params.plr_4) || '')}" placeholder="Optional player nickname" onchange="saveReportCard('${r.id}')">
                        </div>
                    </div>
                </div>
                <div class="report-card-panel" data-panel="schedule">
                    <div class="schedule-enable-block">
                        <label class="schedule-enable-label">
                            <input type="checkbox" class="schedule-enable-checkbox" ${r.schedule_enabled ? 'checked' : ''} onchange="saveReportCard('${r.id}')"> Enable schedule
                        </label>
                        <span class="schedule-hint">When enabled, this report runs every interval between Start and End. Log output appears under Run & Schedule.</span>
                    </div>
                    <div class="report-card-row schedule-row">
                        <div class="report-field report-field-datetime">
                            <label>Start (yyyy-mm-dd hh:mm)</label>
                            <input type="text" value="${escHtml(toScheduleDisplay(r.schedule_start))}" placeholder="yyyy-mm-dd hh:mm" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-datetime">
                            <label>End (yyyy-mm-dd hh:mm)</label>
                            <input type="text" value="${escHtml(toScheduleDisplay(r.schedule_end))}" placeholder="yyyy-mm-dd hh:mm" onchange="saveReportCard('${r.id}')">
                        </div>
                        <div class="report-field report-field-interval">
                            <label>Every</label>
                            <input type="number" min="1" value="${escHtml(r.schedule_interval_value != null ? r.schedule_interval_value : 5)}" onchange="saveReportCard('${r.id}')" style="width:60px;">
                        </div>
                        <div class="report-field report-field-unit">
                            <label>&nbsp;</label>
                            <select onchange="saveReportCard('${r.id}')">
                                <option value="minutes" ${(r.schedule_interval_unit || 'minutes') === 'minutes' ? 'selected' : ''}>minutes</option>
                                <option value="hours" ${(r.schedule_interval_unit || '') === 'hours' ? 'selected' : ''}>hours</option>
                                <option value="days" ${(r.schedule_interval_unit || '') === 'days' ? 'selected' : ''}>days</option>
                            </select>
                        </div>
                        <div class="report-field report-field-save-schedule">
                            <label>&nbsp;</label>
                            <button type="button" class="btn btn-primary btn-sm btn-save-schedule" onclick="saveSchedule('${r.id}', this)">Save schedule</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Normalize to yyyy-mm-dd hh:mm for schedule Start/End display and save. Accepts yyyy-mm-dd, yyyy-mm-dd hh:mm, dd/mm/yyyy hh:mm, or datetime-local (YYYY-MM-DDThh:mm). */
function toScheduleDisplay(val) {
    if (!val || !String(val).trim()) return '';
    const s = String(val).trim().replace('T', ' ');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const date = s.substring(0, 10);
        const time = (s.length >= 16) ? s.substring(11, 16) : '00:00';
        return `${date} ${time}`;
    }
    const parts = s.replace(/\//g, '-').split(/\s+/);
    if (parts[0] && /^\d{1,2}-\d{1,2}-\d{4}$/.test(parts[0])) {
        const [d, m, y] = parts[0].split('-');
        const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        const time = parts[1] && /^\d{1,2}:\d{2}/.test(parts[1]) ? parts[1].substring(0, 5) : '00:00';
        return `${date} ${time}`;
    }
    return s.substring(0, 16);
}

function toDatetimeLocal(val) {
    if (!val || !String(val).trim()) return '';
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
        const t = s.replace(' ', 'T').substring(0, 16);
        return t.length >= 16 ? t : (t + (t.includes('T') ? '' : 'T00:00')).substring(0, 16);
    }
    const parts = s.replace('/', '-').split(/\s+/);
    if (parts[0] && /^\d{1,2}-\d{1,2}-\d{4}$/.test(parts[0])) {
        const [d, m, y] = parts[0].split('-');
        const date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        const time = parts[1] && /^\d{1,2}:\d{2}/.test(parts[1]) ? parts[1].substring(0, 5) : '00:00';
        return `${date}T${time}`;
    }
    return '';
}

function extractReportInfo(curlStr) {
    const match = curlStr.match(/\/report\/(\d+)\/report_version\/([\d.]+)/i);
    if (match) {
        return `Report ${match[1]}, Version ${match[2]}`;
    }
    return null;
}

function toggleCard(cardEl) {
    cardEl.classList.toggle('collapsed');
}

async function saveReportCard(reportId) {
    const card = document.querySelector(`.report-card[data-report-id="${reportId}"]`);
    if (!card) return;
    const body = card.querySelector('.report-card-body');
    const rows = body.querySelectorAll('.report-card-row');
    const activateCb = card.querySelector('.report-card-header .report-active');
    const active = activateCb ? activateCb.checked : true;
    const apiCurl = rows[0].querySelector('textarea').value;
    
    // Extract player parameters (row 5)
    const playerParams = {};
    if (rows.length > 5) {
        const playerParamsRow = rows[5];
        const inputs = playerParamsRow.querySelectorAll('input');
        if (inputs.length >= 4) {
            if (inputs[0].value.trim()) playerParams.plr_1 = inputs[0].value.trim();
            if (inputs[1].value.trim()) playerParams.plr_2 = inputs[1].value.trim();
            if (inputs[2].value.trim()) playerParams.plr_3 = inputs[2].value.trim();
            if (inputs[3].value.trim()) playerParams.plr_4 = inputs[3].value.trim();
        }
    }

    // Extract nickname (row 4)
    let nickname = '';
    let username = '';
    let playerCode = '';
    if (rows.length > 4) {
        const identityInputs = rows[4].querySelectorAll('input[type="text"]');
        if (identityInputs.length > 0) nickname = identityInputs[0].value.trim();
        if (identityInputs.length > 1) username = identityInputs[1].value.trim();
        if (identityInputs.length > 2) playerCode = identityInputs[2].value.trim();
    }
    
    // Extract date format and API timezone (row 2: two selects in File settings)
    let dateFormat = '';
    let apiTimezone = '';
    if (rows.length > 2) {
        const selects = rows[2].querySelectorAll('select');
        if (selects.length > 0) dateFormat = selects[0].value;
        if (selects.length > 1) apiTimezone = selects[1].value;
    }

    // Extract schedule (row 6)
    let schedule_enabled = false;
    let schedule_start = '';
    let schedule_end = '';
    let schedule_interval_value = 5;
    let schedule_interval_unit = 'minutes';
    if (rows.length > 6) {
        const scheduleRow = rows[6];
        const scheduleCb = card.querySelector('.schedule-enable-checkbox');
        if (scheduleCb) schedule_enabled = scheduleCb.checked;
        const scheduleStartInput = scheduleRow.querySelectorAll('.report-field-datetime input[type="text"]')[0];
        const scheduleEndInput = scheduleRow.querySelectorAll('.report-field-datetime input[type="text"]')[1];
        if (scheduleStartInput) schedule_start = toScheduleDisplay(scheduleStartInput.value.trim()) || scheduleStartInput.value.trim();
        if (scheduleEndInput) schedule_end = toScheduleDisplay(scheduleEndInput.value.trim()) || scheduleEndInput.value.trim();
        const numInput = scheduleRow.querySelector('input[type="number"]');
        if (numInput && numInput.value !== '') schedule_interval_value = parseInt(numInput.value, 10) || 5;
        const unitSelect = scheduleRow.querySelector('select');
        if (unitSelect) schedule_interval_unit = unitSelect.value || 'minutes';
    }
    
    const data = {
        active: active,
        api_curl: apiCurl,
        filename: rows[1].querySelectorAll('input')[0].value,
        save_to: rows[1].querySelectorAll('input')[1].value,
        days: rows[1].querySelectorAll('input')[2].value,
        recurrence: rows[1].querySelectorAll('select')[0].value,
        output_mode: rows[1].querySelectorAll('select')[1].value,
        db_table_name: rows[3].querySelectorAll('input')[0].value,
        db_connection_string: rows[3].querySelectorAll('input')[1].value,
        date_format: dateFormat,
        api_timezone: apiTimezone,
        nickname: nickname,
        username: username,
        player_code: playerCode,
        player_params: playerParams,
        schedule_enabled: schedule_enabled,
        schedule_start: schedule_start,
        schedule_end: schedule_end,
        schedule_interval_value: schedule_interval_value,
        schedule_interval_unit: schedule_interval_unit
    };
    const label = extractReportInfo(apiCurl);
    const reportName = (rows[1].querySelectorAll('input')[0].value || '').trim() || 'Report';
    card.querySelector('.report-card-number').textContent = label ? `${reportName} — ${label}` : reportName;
    const titleArea = card.querySelector('.report-card-title-area');
    let badge = titleArea.querySelector('.report-badge-scheduled');
    if (badge) badge.remove();
    if (schedule_enabled) {
        const span = document.createElement('span');
        span.className = 'report-badge report-badge-scheduled';
        span.textContent = 'Scheduled';
        titleArea.appendChild(span);
    }
    try {
        await reportsApiCall(`/api/reports/${reportId}`, 'PUT', data);
    } catch (e) {
        alert('Failed to save: ' + e.message);
    }
}

async function addReport() {
    try {
        await reportsApiCall(`/api/report-lists/${currentListId}/reports`, 'POST', {});
        loadReports();
    } catch (e) {
        alert('Failed to add report: ' + e.message);
    }
}

async function importReportsCsv() {
    if (!currentListId) {
        alert('Select a report list first.');
        return;
    }
    const fileInput = document.getElementById('importCsvFile');
    const statusEl = document.getElementById('importCsvStatus');
    const btn = document.getElementById('btnImportCsv');
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        if (statusEl) statusEl.textContent = 'Choose a CSV file first.';
        return;
    }
    if (statusEl) statusEl.textContent = 'Importing…';
    if (btn) btn.disabled = true;
    const form = new FormData();
    form.append('file', fileInput.files[0]);
    try {
        const res = await fetch(REPORTS_API + `/api/report-lists/${currentListId}/import-csv`, { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        if (statusEl) statusEl.textContent = `Imported ${data.imported} report(s).`;
        statusEl.className = 'import-csv-status import-csv-ok';
        fileInput.value = '';
        loadReports();
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = e.message || 'Import failed.';
            statusEl.className = 'import-csv-status import-csv-err';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteReport(reportId) {
    if (!confirm('Delete this report?')) return;
    try {
        await reportsApiCall(`/api/reports/${reportId}`, 'DELETE');
        loadReports();
    } catch (e) {
        alert('Failed to delete: ' + e.message);
    }
}

function addLogEntry(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const logWindow = document.getElementById('logWindow');
    if (logWindow) {
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = `[${time}] ${message}`;
        logWindow.appendChild(entry);
        logWindow.scrollTop = logWindow.scrollHeight;
    }
    const resultsOutput = document.getElementById('resultsOutput');
    if (resultsOutput) {
        const row = document.createElement('div');
        row.className = `results-row results-${type}`;
        row.innerHTML = `<span class="results-time">${time}</span><span class="results-source results-source-run">Run</span><span class="results-msg">${escapeHtmlResults(message)}</span>`;
        resultsOutput.appendChild(row);
        resultsOutput.scrollTop = resultsOutput.scrollHeight;
    }
}

function escapeHtmlResults(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Append DB result (data written to table) to the Results tab for review. */
function addDbResultToResults(payload, source) {
    const resultsOutput = document.getElementById('resultsOutput');
    if (!payload || !resultsOutput) return;
    const { description, table_name, columns, rows, total_rows } = payload;
    const sourceLabel = source === 'schedule' ? 'Schedule' : 'Run';
    const sourceClass = source === 'schedule' ? 'results-source' : 'results-source results-source-run';
    const block = document.createElement('div');
    block.className = 'results-db-block';
    let tableHtml = '<table class="results-db-table"><thead><tr>';
    (columns || []).forEach(col => {
        tableHtml += `<th>${escapeHtmlResults(col)}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';
    (rows || []).forEach(row => {
        tableHtml += '<tr>';
        (columns || []).forEach(col => {
            const val = row[col];
            const text = val == null ? '' : String(val);
            tableHtml += `<td>${escapeHtmlResults(text)}</td>`;
        });
        tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';
    const previewNote = total_rows > (rows || []).length
        ? `<p class="results-db-note">Showing first ${(rows || []).length} of ${total_rows} rows written to the database.</p>`
        : '';
    block.innerHTML = `
        <div class="results-db-header">
            <span class="results-db-title">${escapeHtmlResults(description || 'Report')}</span>
            <span class="${sourceClass}">${sourceLabel}</span>
        </div>
        <p class="results-db-table-name">Table: <code>${escapeHtmlResults(table_name || '')}</code></p>
        ${previewNote}
        <div class="results-db-table-wrap">${tableHtml}</div>
    `;
    resultsOutput.appendChild(block);
    resultsOutput.scrollTop = resultsOutput.scrollHeight;
}

function clearLog() {
    const logWindow = document.getElementById('logWindow');
    if (logWindow) logWindow.innerHTML = '';
}

function formatLocalDateTimeString(raw) {
    if (!raw) return '';
    // Expect values like "2026-03-08T00:00" from <input type="datetime-local">
    // Convert to a dumb local string "YYYY-MM-DD HH:mm:SS" without any timezone adjustments.
    try {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
            // Fallback: simple string replace, append seconds
            return raw.replace('T', ' ').slice(0, 16) + ':00';
        }
        const pad = (n) => String(n).padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hours = pad(d.getHours());
        const minutes = pad(d.getMinutes());
        return `${year}-${month}-${day} ${hours}:${minutes}:00`;
    } catch (e) {
        return raw.replace('T', ' ').slice(0, 16) + ':00';
    }
}

async function runReports() {
    if (isRunning) return;
    if (!validateDates()) {
        alert('Please fix the date range before running.');
        return;
    }
    if (!currentListId) {
        alert('Please select a report list first.');
        return;
    }

    const dateFromRaw = document.getElementById('dateFrom').value;
    const dateToRaw = document.getElementById('dateTo').value;
    const dateFrom = formatLocalDateTimeString(dateFromRaw);
    const dateTo = formatLocalDateTimeString(dateToRaw);
    const threads = document.getElementById('threadCount').value;
    const intervalEl = document.getElementById('runInterval');
    const interval = intervalEl ? intervalEl.value : '';

    if (!dateFrom || !dateTo) {
        alert('Please set both Date From and Date To.');
        return;
    }

    let reports;
    try {
        reports = await reportsApiCall(`/api/report-lists/${currentListId}/reports`);
    } catch (e) {
        alert('Failed to load reports: ' + e.message);
        return;
    }

    if (reports.length === 0) {
        alert('No reports to run. Add some reports first.');
        return;
    }

    isRunning = true;
    const btn = document.getElementById('btnRunReports');
    btn.disabled = true;
    btn.textContent = 'Running...';

    clearResults();
    addLogEntry(`Starting ${reports.length} report(s) with ${threads} thread(s)`, 'info');
    addLogEntry(`Date range: ${dateFrom} to ${dateTo} (yyyy-mm-dd hh:mm)`, 'info');
    addLogEntry('---', 'info');

    try {
        const response = await reportsApiCall('/api/run', 'POST', {
            profile_id: currentProfileId,
            list_id: currentListId,
            date_from: dateFrom,
            date_to: dateTo,
            threads: parseInt(threads),
            interval: interval
        });

        if (response.error) {
            addLogEntry(`Error: ${response.error}`, 'error');
            isRunning = false;
            btn.disabled = false;
            btn.textContent = 'Run Reports';
            return;
        }

        const evtSource = new EventSource(REPORTS_API + '/api/run/stream');
        evtSource.onopen = function() {
            addLogEntry('Connection Made. Extract list now...', 'info');
        };
        evtSource.onmessage = function(event) {
            const data = JSON.parse(event.data);
            if (data.type === 'done') {
                evtSource.close();
                addLogEntry('---', 'info');
                addLogEntry('Execution complete.', 'success');
                isRunning = false;
                btn.disabled = false;
                btn.textContent = 'Run Reports';
            } else if (data.type === 'msg') {
                const msg = data.text;
                const type = msg.includes('FAILED') ? 'error' :
                             msg.includes('COMPLETED') || msg.includes('FINISHED') ? 'success' :
                             msg.includes('Warning') ? 'warn' : 'info';
                addLogEntry(msg, type);
            } else if (data.type === 'db_result' && data.payload) {
                addDbResultToResults(data.payload, 'run');
            }
        };
        evtSource.onerror = function() {
            evtSource.close();
            addLogEntry('Connection to server lost.', 'error');
            isRunning = false;
            btn.disabled = false;
            btn.textContent = 'Run Reports';
        };
    } catch (e) {
        addLogEntry(`Error: ${e.message}`, 'error');
        isRunning = false;
        btn.disabled = false;
        btn.textContent = 'Run Reports';
    }
}

let csvDbRowIndex = 0;

function addCsvDbRow() {
    const container = document.getElementById('csvToDbRows');
    if (!container) return;
    const idx = csvDbRowIndex++;
    const row = document.createElement('div');
    row.className = 'import-csv-db-item';
    row.dataset.idx = idx;
    row.innerHTML = `
        <div class="setting-group">
            <label>CSV file</label>
            <input type="file" class="csv-db-file input-control" accept=".csv" data-idx="${idx}">
        </div>
        <div class="setting-group">
            <label>Table name</label>
            <input type="text" class="csv-db-table input-control" placeholder="e.g. Login_activity_16230 (or pick file to use filename)" data-idx="${idx}">
        </div>
        <div class="setting-group setting-group-wide">
            <label>Default DB connection</label>
            <input type="text" class="csv-db-conn input-control" placeholder="Leave blank to use Default DB from Defaults tab" data-idx="${idx}">
        </div>
        <button type="button" class="btn btn-sm btn-remove-row" onclick="removeCsvDbRow(this)" title="Remove row">Remove</button>
    `.trim();
    container.appendChild(row);
    row.querySelector('.csv-db-file').addEventListener('change', function () {
        const file = this.files && this.files[0];
        const tableIn = row.querySelector('.csv-db-table');
        if (file && file.name && tableIn) {
            const base = file.name.replace(/\.csv$/i, '');
            if (base) tableIn.value = base;
        }
    });
}

function removeCsvDbRow(btn) {
    const row = btn.closest('.import-csv-db-item');
    const container = document.getElementById('csvToDbRows');
    if (row && container && container.children.length > 1) row.remove();
}

async function importAllCsvToDb() {
    const container = document.getElementById('csvToDbRows');
    const statusEl = document.getElementById('csvToDbStatus');
    const btn = document.getElementById('btnCsvToDb');
    if (!container || !statusEl) return;
    const items = [];
    container.querySelectorAll('.import-csv-db-item').forEach(row => {
        const fileIn = row.querySelector('.csv-db-file');
        const tableIn = row.querySelector('.csv-db-table');
        const connIn = row.querySelector('.csv-db-conn');
        const file = fileIn && fileIn.files && fileIn.files[0];
        const tableName = (tableIn && tableIn.value) ? tableIn.value.trim() : '';
        if (!file || !tableName) return;
        items.push({ file, tableName, conn: (connIn && connIn.value) ? connIn.value.trim() : '' });
    });
    if (items.length === 0) {
        statusEl.textContent = 'Add at least one row with a CSV file and table name.';
        statusEl.className = 'import-csv-db-status import-csv-db-err';
        return;
    }
    statusEl.textContent = `Importing ${items.length} CSV(s)…`;
    statusEl.className = 'import-csv-db-status';
    if (btn) btn.disabled = true;
    const form = new FormData();
    form.append('count', String(items.length));
    items.forEach((item, i) => {
        form.append('file_' + i, item.file);
        form.append('table_name_' + i, item.tableName);
        if (item.conn) form.append('db_connection_string_' + i, item.conn);
    });
    try {
        const res = await fetch(REPORTS_API + '/api/import-csv-to-db', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        const errs = (data.results || []).filter(r => r.error);
        if (errs.length) {
            statusEl.textContent = `Imported ${data.rows_imported} row(s) from ${data.items_processed} file(s). Errors: ${errs.map(e => e.filename + ': ' + e.error).join('; ')}`;
            statusEl.className = 'import-csv-db-status import-csv-db-err';
        } else {
            statusEl.textContent = `Imported ${data.rows_imported} row(s) from ${data.items_processed} file(s) into their tables.`;
            statusEl.className = 'import-csv-db-status import-csv-db-ok';
        }
        container.querySelectorAll('.csv-db-file').forEach(inp => { if (inp) inp.value = ''; });
    } catch (e) {
        statusEl.textContent = e.message || 'Import failed.';
        statusEl.className = 'import-csv-db-status import-csv-db-err';
    } finally {
        if (btn) btn.disabled = false;
    }
}

function showModal(title, bodyHtml, callback) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    modalCallback = callback;
    document.getElementById('modalOverlay').style.display = 'flex';
    const firstInput = document.querySelector('.modal-body input');
    if (firstInput) setTimeout(() => firstInput.focus(), 100);
}

function hideModal() {
    document.getElementById('modalOverlay').style.display = 'none';
    modalCallback = null;
}

function closeModal(e) {
    if (e.target === document.getElementById('modalOverlay')) hideModal();
}

function modalSave() {
    if (modalCallback) modalCallback();
}

function showProfileModal(profile = null) {
    const isEdit = !!profile;
    const title = isEdit ? 'Edit Profile' : 'New Profile';
    const html = `
        <div class="form-group">
            <label for="modalProfileName">Profile Name</label>
            <input type="text" id="modalProfileName" class="input-control" value="${isEdit ? escHtml(profile.name) : ''}" placeholder="e.g. Production Server">
        </div>
        <div class="form-group">
            <label for="modalProfileUser">Username</label>
            <input type="text" id="modalProfileUser" class="input-control" value="${isEdit ? escHtml(profile.username) : ''}">
        </div>
        <div class="form-group">
            <label for="modalProfilePass">Password</label>
            <input type="password" id="modalProfilePass" class="input-control" value="${isEdit ? escHtml(profile.password) : ''}">
        </div>
    `;

    showModal(title, html, async () => {
        const name = document.getElementById('modalProfileName').value.trim();
        const username = document.getElementById('modalProfileUser').value.trim();
        const password = document.getElementById('modalProfilePass').value;
        if (!name || !username) {
            alert('Name and username are required.');
            return;
        }
        try {
            if (isEdit) {
                await reportsApiCall(`/api/profiles/${profile.id}`, 'PUT', { name, username, password });
            } else {
                const created = await reportsApiCall('/api/profiles', 'POST', { name, username, password });
                currentProfileId = created.id;
            }
            hideModal();
            loadProfiles();
        } catch (e) {
            alert(e.message);
        }
    });
}

async function editProfile() {
    if (!currentProfileId) return;
    const profiles = await reportsApiCall('/api/profiles');
    const profile = profiles.find(p => p.id === currentProfileId);
    if (profile) showProfileModal(profile);
}

async function deleteProfile() {
    if (!currentProfileId) return;
    if (!confirm('Delete this profile and all its report lists?')) return;
    try {
        await reportsApiCall(`/api/profiles/${currentProfileId}`, 'DELETE');
        currentProfileId = null;
        currentListId = null;
        loadProfiles();
    } catch (e) {
        alert('Failed to delete: ' + e.message);
    }
}

function showReportListModal(reportList = null) {
    const isEdit = !!reportList;
    const title = isEdit ? 'Rename Report List' : 'New Report List';
    const html = `
        <div class="form-group">
            <label for="modalListName">List Name</label>
            <input type="text" id="modalListName" class="input-control" value="${isEdit ? escHtml(reportList.name) : ''}" placeholder="e.g. Daily Revenue Reports">
        </div>
    `;

    showModal(title, html, async () => {
        const name = document.getElementById('modalListName').value.trim();
        if (!name) {
            alert('List name is required.');
            return;
        }
        try {
            if (isEdit) {
                await reportsApiCall(`/api/report-lists/${reportList.id}`, 'PUT', { name });
            } else {
                const created = await reportsApiCall(`/api/profiles/${currentProfileId}/report-lists`, 'POST', { name });
                currentListId = created.id;
            }
            hideModal();
            loadReportLists();
        } catch (e) {
            alert(e.message);
        }
    });
}

async function editReportList() {
    if (!currentListId) return;
    const lists = await reportsApiCall(`/api/profiles/${currentProfileId}/report-lists`);
    const list = lists.find(l => l.id === currentListId);
    if (list) showReportListModal(list);
}

async function deleteReportList() {
    if (!currentListId) return;
    if (!confirm('Delete this report list and all its reports?')) return;
    try {
        await reportsApiCall(`/api/report-lists/${currentListId}`, 'DELETE');
        currentListId = null;
        loadReportLists();
    } catch (e) {
        alert('Failed to delete: ' + e.message);
    }
}

// --- Game Integrity (iPoker) tab ---
let giCurrentPlayerKey = null;

function giOpenDashboard(playerKey) {
    giCurrentPlayerKey = playerKey;
    const overlay = document.getElementById('giDashboardOverlay');
    const titleEl = document.getElementById('giDashboardTitle');
    if (titleEl) titleEl.textContent = 'Review & Report — ' + playerKey;
    if (overlay) overlay.style.display = 'flex';
    giLoadDashboardData(playerKey);
}

function closeGiDashboard(ev) {
    if (ev && ev.target !== ev.currentTarget) return;
    hideGiDashboard();
}

function hideGiDashboard() {
    const overlay = document.getElementById('giDashboardOverlay');
    if (overlay) overlay.style.display = 'none';
}

async function giLoadDashboardData(playerKey) {
    const notesEl = document.getElementById('giDashboardCaseNotes');
    const filesEl = document.getElementById('giDashboardFilesList');
    const fileInput = document.getElementById('giDashboardFileInput');
    const setBlock = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    if (!playerKey) return;
    try {
        const data = await apiCall('/api/ews/player-dashboard?player_key=' + encodeURIComponent(playerKey));
        const acc = data.account_info;
        const ap = data.activity_profile || {};
        const v = (x) => (x != null && String(x).trim() !== '') ? escapeHtmlResults(String(x).trim()) : '—';
        const accountRows = [
            ['Poker room', ap.poker_room || ap.cardroom],
            ['Nickname', ap.nickname || acc?.nickname || acc?.player_key],
            ['Username', ap.username],
            ['Poker VIP level', ap.poker_vip_level],
            ['Sign up date', ap.sign_up_date],
            ['Poker Player Code', ap.poker_player_code],
            ['Frozen', ap.frozen],
            ['Total Rake / Tournament Fees', (ap.total_rake != null && String(ap.total_rake).trim() !== '' ? ap.total_rake : '—') + ' / ' + (ap.tournament_fees != null && String(ap.tournament_fees).trim() !== '' ? ap.tournament_fees : '—')],
            ['Country', ap.country],
            ['Cardroom', ap.cardroom],
            ['Advertiser', ap.advertiser],
            ['Avatar', ap.avatar],
            ['Original currency', ap.original_currency],
            ['Currency', ap.currency],
            ['Comments', ap.comments],
        ].map(([label, val]) => `<tr><th>${escapeHtmlResults(label)}</th><td>${v(val)}</td></tr>`).join('');
        setBlock('giDashboardAccountInfo', accountRows ? `<table class="gi-aggregate-table">${accountRows}</table>` : '<p class="gi-hint">No account data.</p>');
        const activityRows = [
            ['Rake', ap.rake || ap.total_rake],
            ['STT', ap.stt],
            ['MTT', ap.mtt],
            ['Total income', ap.total_income],
            ['Award points accumulated in period', ap.award_points_accumulated_in_period],
            ['Status points accumulated in period', ap.status_points_accumulated_in_period],
            ['Total award points', ap.total_award_points],
            ['Total status points', ap.total_status_points],
            ['Games played', ap.games_played],
            ['Raked games', ap.raked_games],
            ['MTT Played', ap.mtt_played || acc?.tournaments_played],
            ['Twister Played', ap.twister_played],
            ['Hands Played', ap.hands_played],
            ['Win Ratio', ap.win_ratio],
            ['Profit / Loss', ap.profit_loss],
            ['Cash Payout %', ap.cash_payout_pct],
            ['Login Count', ap.login_count],
            ['Average Buy In / Stake', ap.average_buy_in_stake],
            ['Number of Collusion Entries', ap.number_collusion_entries],
        ].map(([label, val]) => `<tr><th>${escapeHtmlResults(label)}</th><td>${v(val)}</td></tr>`).join('');
        setBlock('giDashboardActivity', activityRows ? `<table class="gi-aggregate-table">${activityRows}</table>` : '<p class="gi-hint">No activity data.</p>');
        const mtt = data.mtt_stats || {};
        const mttRows = [
            ['Tournaments played', mtt.tournament_count != null ? mtt.tournament_count : '—'],
            ['Fee / prize total', mtt.fee_prize_total != null ? mtt.fee_prize_total : '—'],
            ['Prize total', mtt.prize_total != null ? mtt.prize_total : '—'],
        ].map(([label, val]) => `<tr><th>${escapeHtmlResults(label)}</th><td>${val}</td></tr>`).join('');
        setBlock('giDashboardMttStats', mttRows ? `<table class="gi-aggregate-table">${mttRows}</table><p class="gi-hint">Source: ${escapeHtmlResults(mtt.source_table || 'mtt-info-per-player-statistical')}</p>` : '<p class="gi-hint">No MTT data for this player. Ensure Default DB is set and table mtt-info-per-player-statistical exists; player is matched by Player Code.</p>');
        if (notesEl) notesEl.value = data.collusion_comments || '';
        const ews = data.ews_score;
        const outcome = data.outcome;
        if (ews || outcome) {
            let ewsHtml = '';
            if (ews) ewsHtml += `<p><strong>EWS score:</strong> ${ews.score} — ${escapeHtmlResults(ews.suggested_action || '')}</p><p class="gi-hint">${escapeHtmlResults((ews.triggered_rules || '').slice(0, 120))}…</p>`;
            if (outcome) ewsHtml += `<p><strong>Outcome:</strong> ${escapeHtmlResults(outcome.outcome)}</p>`;
            ewsHtml += `<label>Set outcome</label><select id="giDashboardOutcome" class="select-control"><option value="">—</option><option value="cleared" ${(outcome && outcome.outcome === 'cleared') ? 'selected' : ''}>Cleared</option><option value="suspicious" ${(outcome && outcome.outcome === 'suspicious') ? 'selected' : ''}>Suspicious</option><option value="colluder confirmed" ${(outcome && outcome.outcome === 'colluder confirmed') ? 'selected' : ''}>Colluder confirmed</option></select> <button type="button" class="btn btn-primary btn-sm" onclick="giSetPlayerOutcome()">Save outcome</button>`;
            setBlock('giDashboardEwsScore', ewsHtml || '<p class="gi-hint">No EWS score.</p>');
        } else setBlock('giDashboardEwsScore', '<p class="gi-hint">No EWS score.</p><label>Set outcome</label><select id="giDashboardOutcome" class="select-control"><option value="">—</option><option value="cleared">Cleared</option><option value="suspicious">Suspicious</option><option value="colluder confirmed">Colluder confirmed</option></select> <button type="button" class="btn btn-primary btn-sm" onclick="giSetPlayerOutcome()">Save outcome</button>');
        const nick = data.nickname_history || [];
        setBlock('giDashboardNicknameHistory', nick.length ? '<ul class="gi-files-list">' + nick.map(n => '<li>' + escapeHtmlResults(String(n)) + '</li>').join('') + '</ul>' : '<p class="gi-hint">No nickname history.</p>');
        const serials = data.all_serials || [];
        setBlock('giDashboardSerials', serials.length ? '<ul class="gi-files-list">' + serials.map(s => '<li>' + escapeHtmlResults(String(s)) + '</li>').join('') + '</ul>' : '<p class="gi-hint">No serials.</p>');
        const devices = data.all_device_names || [];
        setBlock('giDashboardDevices', devices.length ? '<ul class="gi-files-list">' + devices.map(d => '<li>' + escapeHtmlResults(String(d)) + '</li>').join('') + '</ul>' : '<p class="gi-hint">No device names.</p>');
        const cases = data.poker_cases || [];
        setBlock('giDashboardCases', cases.length ? '<ul class="gi-files-list">' + cases.map(c => '<li>Case #' + c.id + ' ' + escapeHtmlResults(c.status) + '</li>').join('') + '</ul>' : '<p class="gi-hint">No cases.</p>');
        const related = data.related_players || [];
        setBlock('giDashboardRelated', related.length ? '<ul class="gi-files-list">' + related.map(r => '<li>' + escapeHtmlResults(r.player_key) + ' (pair score ' + r.pair_score + ')</li>').join('') + '</ul>' : '<p class="gi-hint">No related players.</p>');
        const reports = data.common_reports || {};
        setBlock('giDashboardCommonReports', '<p>Common SNG Player Report · Common Cash Game Player Report · Common MTT Player Report</p><p class="gi-hint">Summaries: VPIP, PFR, ITM, ROI (when linked to report data).</p>');
        const caseFiles = await fetch('/api/gi/player-dashboard?player_key=' + encodeURIComponent(playerKey) + '&days=7').then(r => r.json()).then(d => d.case_files || []).catch(() => []);
        if (filesEl) filesEl.innerHTML = caseFiles.length ? '<ul class="gi-files-list">' + caseFiles.map(f => '<li>' + escapeHtmlResults(f.name) + ' (' + f.size + ' B)</li>').join('') + '</ul>' : '<p class="gi-hint">No case files yet.</p>';
        if (fileInput) fileInput.value = '';
    } catch (e) {
        setBlock('giDashboardAccountInfo', '<p class="gi-error">Failed to load: ' + escapeHtmlResults(e.message) + '</p>');
    }
}

function giSaveCaseNotesFromDashboard() {
    const notesEl = document.getElementById('giDashboardCaseNotes');
    const key = giCurrentPlayerKey;
    if (!key) return;
    apiCall('/api/gi/player-case', 'PUT', { player_key: key, case_notes: (notesEl && notesEl.value) ? notesEl.value : '' })
        .then(() => { alert('Case notes saved.'); })
        .catch(e => alert('Failed to save: ' + e.message));
}

function giSetPlayerOutcome() {
    const sel = document.getElementById('giDashboardOutcome');
    const key = giCurrentPlayerKey;
    if (!key || !sel || !sel.value) return;
    apiCall('/api/ews/player-outcome', 'PUT', { player_key: key, outcome: sel.value })
        .then(() => { alert('Outcome saved.'); giLoadDashboardData(key); })
        .catch(e => alert('Failed to save: ' + e.message));
}

function giUploadCaseFileFromDashboard() {
    const input = document.getElementById('giDashboardFileInput');
    const key = giCurrentPlayerKey;
    if (!key || !input || !input.files || !input.files.length) {
        alert('Select one or more files first.');
        return;
    }
    const form = new FormData();
    form.append('player_key', key);
    for (let i = 0; i < input.files.length; i++) form.append('file', input.files[i]);
    fetch('/api/gi/player-case-file', { method: 'POST', body: form })
        .then(r => r.json())
        .then(data => {
            if (data.error) alert(data.error);
            else { input.value = ''; giLoadDashboardData(key); }
        })
        .catch(() => alert('Upload failed.'));
}

// --- EWS (Case Management) ---
async function ewsLoadFlaggedPlayers() {
    const tbody = document.getElementById('ewsPlayersTableBody');
    const emptyEl = document.getElementById('ewsPlayersEmpty');
    if (!tbody) return;
    try {
        const data = await apiCall('/api/ews/flagged-players');
        const players = data.players || [];
        if (emptyEl) emptyEl.style.display = players.length ? 'none' : 'block';
        tbody.innerHTML = players.map(p => {
            const scoreClass = p.score >= 70 ? 'ews-critical' : p.score >= 50 ? 'ews-high' : p.score >= 30 ? 'ews-medium' : 'ews-low';
            const key = escapeHtmlResults(p.player_key);
            const keyAttr = String(p.player_key).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const evidence = (p.evidence_summary || '').slice(0, 100);
            const evidenceFull = escapeHtmlResults(p.evidence_summary || '');
            return `<tr>
                <td>${key}</td>
                <td><span class="ews-score ${scoreClass}">${p.score}</span></td>
                <td class="ews-rules">${escapeHtmlResults((p.triggered_rules || '').slice(0, 80))}${(p.triggered_rules || '').length > 80 ? '…' : ''}</td>
                <td class="ews-context" title="${evidenceFull}">${escapeHtmlResults(evidence)}${(p.evidence_summary || '').length > 100 ? '…' : ''}</td>
                <td>${escapeHtmlResults(p.player_outcome || '—')}</td>
                <td><button type="button" class="btn btn-primary btn-sm ews-open-case" data-player="${keyAttr}">Open case</button> <button type="button" class="btn btn-secondary btn-sm ews-view-profile" data-player="${keyAttr}">View profile</button></td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('.ews-open-case').forEach(btn => btn.addEventListener('click', () => ewsOpenCaseForPlayer(btn.dataset.player)));
        tbody.querySelectorAll('.ews-view-profile').forEach(btn => btn.addEventListener('click', () => giOpenDashboard(btn.dataset.player)));
    } catch (e) {
        if (emptyEl) { emptyEl.textContent = 'Could not load: ' + (e.message || 'error'); emptyEl.style.display = 'block'; }
        tbody.innerHTML = '';
    }
}

async function ewsOpenCaseForPlayer(playerKey) {
    try {
        const data = await apiCall('/api/ews/cases', 'POST', { subject_type: 'player', subject_id: playerKey });
        if (data.case_id) { ewsLoadCases(); alert('Case opened.'); }
    } catch (e) { alert(e.message || 'Failed to open case'); }
}

async function ewsOpenCaseForPair(playerA, playerB) {
    try {
        const data = await apiCall('/api/ews/cases', 'POST', { subject_type: 'pair', subject_id: playerA, subject_id_2: playerB });
        if (data.case_id) { ewsLoadCases(); alert('Case opened for pair.'); }
    } catch (e) { alert(e.message || 'Failed to open case'); }
}

// --- Detection System (Game Integrity sub-tab) ---
// Rules listed one after another (no cards).
const DETECTION_RULES = [
    { id: 'physical_proximity', title: 'Physical Proximity', whatItFinds: 'Find players playing from the same location in the same tournaments. Pairs of nicknames that shared the same IP across more than 3 different Tournament codes; shows unique tournaments shared and total win while sharing those IPs.', tooltip: 'Uses shared_game_ip_in_mtts. Pairs with shared IP in >3 tournaments; output: Nicknames involved, Unique tournaments shared, Total win.', subject_type: 'pair' },
];

const DETECTION_CRITERIA_DEFAULTS = {
    'physical_proximity': { min_tournaments: 3 },
    '1.1': { min_net_bb: 0 },
    '1.2': { pct_threshold: 70, max_sessions: 3 },
    '1.3': { min_triangle_bb: 0 },
};

function detectionGetFilters() {
    const daysEl = document.getElementById('detectionDays');
    const days = daysEl && daysEl.value === 'custom' ? null : (daysEl ? parseInt(daysEl.value, 10) : 7);
    let dateFrom = '', dateTo = '';
    if (daysEl && daysEl.value === 'custom') {
        const fromEl = document.getElementById('detectionDateFrom');
        const toEl = document.getElementById('detectionDateTo');
        dateFrom = fromEl ? fromEl.value : '';
        dateTo = toEl ? toEl.value : '';
    }
    const stakeBandEl = document.getElementById('detectionStakeBand');
    const tableSizeEl = document.getElementById('detectionTableSize');
    let min_bb, max_bb;
    const stakeBand = stakeBandEl ? stakeBandEl.value : '';
    if (stakeBand === '0.01-0.5') { min_bb = 0.01; max_bb = 0.5; } else if (stakeBand === '0.5-2') { min_bb = 0.5; max_bb = 2; } else if (stakeBand === '2-5') { min_bb = 2; max_bb = 5; } else if (stakeBand === '5+') { min_bb = 5; max_bb = null; } else { min_bb = null; max_bb = null; }
    return {
        days: days || 7,
        date_from: dateFrom,
        date_to: dateTo,
        stake_band: stakeBand,
        table_size: tableSizeEl ? tableSizeEl.value : '',
        min_bb: min_bb,
        max_bb: max_bb,
        stake: (document.getElementById('detectionStake') || {}).value || '',
        game_type: (document.getElementById('detectionGameType') || {}).value || '',
        room: (document.getElementById('detectionRoom') || {}).value || '',
    };
}

function detectionLoad() {
    const daysEl = document.getElementById('detectionDays');
    const customWrap = document.querySelectorAll('.detection-custom-dates');
    if (daysEl) {
        daysEl.addEventListener('change', () => {
            const show = daysEl.value === 'custom';
            customWrap.forEach(el => { if (el) el.style.display = show ? 'block' : 'none'; });
        });
    }
    detectionRefresh();
    collusionDashboardInit();
}

function detectionGetCriteriaForRule(ruleId) {
    const def = DETECTION_CRITERIA_DEFAULTS[ruleId];
    if (!def) return {};
    if (!window.detectionCriteria) window.detectionCriteria = {};
    if (!window.detectionCriteria[ruleId]) window.detectionCriteria[ruleId] = { ...def };
    return { ...window.detectionCriteria[ruleId] };
}

function detectionBuildQueryString(ruleId, filters) {
    let base = `rule_id=${encodeURIComponent(ruleId)}&days=${filters.days}&date_from=${encodeURIComponent(filters.date_from || '')}&date_to=${encodeURIComponent(filters.date_to || '')}&stake_band=${encodeURIComponent(filters.stake_band || '')}&table_size=${encodeURIComponent(filters.table_size || '')}&stake=${encodeURIComponent(filters.stake || '')}&game_type=${encodeURIComponent(filters.game_type || '')}&room=${encodeURIComponent(filters.room || '')}`;
    if (filters.min_bb != null) base += '&min_bb=' + encodeURIComponent(String(filters.min_bb));
    if (filters.max_bb != null) base += '&max_bb=' + encodeURIComponent(String(filters.max_bb));
    const criteria = detectionGetCriteriaForRule(ruleId);
    Object.keys(criteria).forEach(k => { base += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(String(criteria[k])); });
    return base;
}

async function detectionRefresh() {
    const container = document.getElementById('detectionRules');
    const btn = document.getElementById('btnDetectionRefresh');
    if (!container) return;
    if (btn) btn.disabled = true;
    const filters = detectionGetFilters();
    container.innerHTML = '<p class="section-hint">Loading rule data…</p>';
    try {
        const ruleIds = DETECTION_RULES.map(r => r.id);
        const results = await Promise.all(ruleIds.map(id => apiCall('/api/detection/data?' + detectionBuildQueryString(id, filters)).catch(e => ({ columns: [], rows: [], error: e.message }))));
        container.innerHTML = '';
        DETECTION_RULES.forEach((rule, i) => {
            const data = results[i] || {};
            const card = detectionRenderCard(rule, data.columns || [], data.rows || [], data.time_window || '', data.error, data.empty_reason || '', filters);
            container.appendChild(card);
        });
    } catch (e) {
        container.innerHTML = '<p class="section-hint" style="color:var(--danger);">Failed to load: ' + escapeHtmlResults(e.message || 'error') + '</p>';
    }
    if (btn) btn.disabled = false;
}

function detectionRenderCard(rule, columns, rows, timeWindow, error, emptyReason, filters) {
    filters = filters || {};
    const card = document.createElement('div');
    card.className = 'detection-rule detection-rule-card';
    card.dataset.ruleId = rule.id;
    const colNames = columns.length ? columns : (rows.length && rows[0] ? Object.keys(rows[0]).filter(k => k !== '_evidence') : []);
    const hasCaseCol = colNames.some(c => /case|action|generate/i.test(String(c)));
    const displayCols = hasCaseCol ? colNames.filter(c => !/case|action|generate/i.test(String(c))) : colNames.filter(c => c !== '_evidence');
    let tableHtml = '';
    if (error) {
        tableHtml = '<div class="detection-empty"><p class="detection-empty-title">Error loading data</p><p class="section-hint" style="color:var(--danger);">' + escapeHtmlResults(error) + '</p></div>';
    } else if (displayCols.length && rows.length > 0) {
        tableHtml = '<div class="gi-table-wrap"><table class="gi-players-table detection-table"><thead><tr>' +
            displayCols.map(c => '<th>' + escapeHtmlResults(String(c)) + '</th>').join('') +
            '<th>Case</th></tr></thead><tbody>';
        const windowStr = timeWindow || ('Last ' + (filters.days || 7) + ' days');
        const stakeBandStr = filters.stake_band || '';
        rows.slice(0, 50).forEach((row, rowIdx) => {
            const playerA = row.player_a || row['Player A'] || row['Player'] || '';
            const playerB = row.player_b || row['Player B'] || row['Opponent'] || '';
            const subjectType = rule.subject_type || 'pair';
            const subjId = subjectType === 'pair' ? (playerA || row.player_a) : (playerA || playerB || row['Player'] || row.Player || '');
            const subjId2 = subjectType === 'pair' ? (playerB || row.player_b) : '';
            const evidence = row._evidence != null ? JSON.stringify(row._evidence) : '';
            tableHtml += '<tr>';
            displayCols.forEach(col => {
                const val = row[col];
                tableHtml += '<td>' + escapeHtmlResults(val != null ? String(val) : '') + '</td>';
            });
            tableHtml += '<td><button type="button" class="btn btn-primary btn-sm detection-gen-case" data-subject-type="' + escapeHtmlResults(subjectType) + '" data-subject-id="' + escapeHtmlResults(subjId) + '" data-subject-id-2="' + escapeHtmlResults(subjId2) + '" data-rule-id="' + escapeHtmlResults(rule.id) + '" data-window="' + escapeHtmlResults(windowStr) + '" data-stake-band="' + escapeHtmlResults(stakeBandStr) + '" data-evidence="' + escapeHtmlResults(evidence) + '">Generate a Case</button></td></tr>';
        });
        tableHtml += '</tbody></table></div>';
    } else {
        let msg = 'No results found for this rule.';
        if (timeWindow) msg += ' Time window: ' + escapeHtmlResults(timeWindow) + '.';
        if (emptyReason) msg += ' ' + escapeHtmlResults(emptyReason);
        if (!timeWindow && !emptyReason) msg += ' Source table may be missing or empty; check Defaults → DB connection and that report-named tables exist.';
        tableHtml = '<div class="detection-empty"><p class="detection-empty-title">No results</p><p class="section-hint">' + msg + '</p></div>';
    }
    const whatItFinds = rule.whatItFinds || rule.description || '';
    let criteriaHtml = '';
    if (rule.criteria && rule.criteria.length) {
        if (!window.detectionCriteria) window.detectionCriteria = {};
        if (!window.detectionCriteria[rule.id]) window.detectionCriteria[rule.id] = {};
        const crit = window.detectionCriteria[rule.id];
        rule.criteria.forEach(c => {
            const val = (crit[c.key] !== undefined && crit[c.key] !== '') ? crit[c.key] : c.default;
            if (crit[c.key] === undefined) window.detectionCriteria[rule.id][c.key] = val;
            criteriaHtml += '<div class="detection-criteria-item"><label for="detection-' + escapeHtmlResults(rule.id) + '-' + escapeHtmlResults(c.key) + '">' + escapeHtmlResults(c.label) + '</label><input type="' + (c.type || 'number') + '" id="detection-' + escapeHtmlResults(rule.id) + '-' + escapeHtmlResults(c.key) + '" class="input-control detection-criteria-input" data-rule-id="' + escapeHtmlResults(rule.id) + '" data-param="' + escapeHtmlResults(c.key) + '" value="' + escapeHtmlResults(String(val)) + '" style="width:100px;"></div>';
        });
        criteriaHtml = '<div class="detection-criteria"><p class="detection-criteria-title">Search criteria</p><div class="detection-criteria-row">' + criteriaHtml + '</div><button type="button" class="btn btn-secondary btn-sm detection-refresh-rule" data-rule-id="' + escapeHtmlResults(rule.id) + '">Refresh this rule</button></div>';
    }
    const tooltip = rule.tooltip || whatItFinds;
    card.innerHTML = '<div class="detection-rule-card-header">' +
        '<h3 class="detection-rule-name" title="' + escapeHtmlResults(tooltip) + '">' + escapeHtmlResults(rule.title) + ' <span class="detection-info-icon" title="' + escapeHtmlResults(tooltip) + '">ⓘ</span></h3>' +
        '<p class="detection-what-it-finds"><strong>What this rule finds:</strong> ' + escapeHtmlResults(whatItFinds) + '</p>' +
        (timeWindow && rows.length > 0 ? '<p class="section-hint">' + escapeHtmlResults(timeWindow) + '</p>' : '') +
        '</div>' + criteriaHtml + tableHtml;
    card.querySelectorAll('.detection-criteria-input').forEach(input => {
        const syncCriteria = function() {
            const rid = this.dataset.ruleId;
            const param = this.dataset.param;
            if (!window.detectionCriteria[rid]) window.detectionCriteria[rid] = {};
            const v = this.value;
            window.detectionCriteria[rid][param] = this.type === 'number' ? (v === '' ? 0 : parseFloat(v)) : v;
        };
        input.addEventListener('change', syncCriteria);
        input.addEventListener('input', syncCriteria);
    });
    card.querySelectorAll('.detection-refresh-rule').forEach(btn => {
        btn.addEventListener('click', function() { detectionRefreshOneRule(this.dataset.ruleId); });
    });
    card.querySelectorAll('.detection-gen-case').forEach(btn => {
        btn.addEventListener('click', function() {
            let evidence = null;
            try {
                if (this.dataset.evidence) evidence = JSON.parse(this.dataset.evidence);
            } catch (e) {}
            detectionGenerateCase(this.dataset.subjectType, this.dataset.subjectId, this.dataset.subjectId2, {
                rule_id: this.dataset.ruleId || '',
                calculation_window: this.dataset.window || '',
                stake_band: this.dataset.stakeBand || '',
                evidence: evidence,
            });
        });
    });
    return card;
}

async function detectionRefreshOneRule(ruleId) {
    const card = document.querySelector('.detection-rule-card[data-rule-id="' + ruleId + '"]');
    if (!card) return;
    const rule = DETECTION_RULES.find(r => r.id === ruleId);
    if (!rule) return;
    const filters = detectionGetFilters();
    const url = '/api/detection/data?' + detectionBuildQueryString(ruleId, filters);
    card.querySelector('.gi-table-wrap, .detection-empty')?.classList.add('detection-loading');
    try {
        const data = await apiCall(url);
        const colNames = data.columns && data.columns.length ? data.columns : (data.rows && data.rows[0] ? Object.keys(data.rows[0]).filter(k => k !== '_evidence') : []);
        const rows = data.rows || [];
        const hasCaseCol = colNames.some(c => /case|action|generate/i.test(String(c)));
        const displayCols = hasCaseCol ? colNames.filter(c => !/case|action|generate/i.test(String(c))) : colNames.filter(c => c !== '_evidence');
        const windowStr = data.time_window || ('Last ' + (filters.days || 7) + ' days');
        const stakeBandStr = filters.stake_band || '';
        let tableHtml = '';
        if (rows.length > 0 && displayCols.length) {
            tableHtml = '<div class="gi-table-wrap"><table class="gi-players-table detection-table"><thead><tr>' +
                displayCols.map(c => '<th>' + escapeHtmlResults(String(c)) + '</th>').join('') + '<th>Case</th></tr></thead><tbody>';
            rows.slice(0, 50).forEach(row => {
                const playerA = row.player_a || row['Player A'] || row['Player'] || '';
                const playerB = row.player_b || row['Player B'] || row['Opponent'] || '';
                const subjectType = rule.subject_type || 'pair';
                const subjId = subjectType === 'pair' ? (playerA || row.player_a) : (playerA || playerB || row['Player'] || row.Player || '');
                const subjId2 = subjectType === 'pair' ? (playerB || row.player_b) : '';
                const evidence = row._evidence != null ? JSON.stringify(row._evidence) : '';
                tableHtml += '<tr>';
                displayCols.forEach(col => { tableHtml += '<td>' + escapeHtmlResults(row[col] != null ? String(row[col]) : '') + '</td>'; });
                tableHtml += '<td><button type="button" class="btn btn-primary btn-sm detection-gen-case" data-subject-type="' + escapeHtmlResults(subjectType) + '" data-subject-id="' + escapeHtmlResults(subjId) + '" data-subject-id-2="' + escapeHtmlResults(subjId2) + '" data-rule-id="' + escapeHtmlResults(rule.id) + '" data-window="' + escapeHtmlResults(windowStr) + '" data-stake-band="' + escapeHtmlResults(stakeBandStr) + '" data-evidence="' + escapeHtmlResults(evidence) + '">Generate a Case</button></td></tr>';
            });
            tableHtml += '</tbody></table></div>';
        } else {
            let msg = 'No results found.';
            if (data.time_window) msg += ' Time window: ' + escapeHtmlResults(data.time_window) + '.';
            if (data.empty_reason) msg += ' ' + escapeHtmlResults(data.empty_reason);
            tableHtml = '<div class="detection-empty"><p class="detection-empty-title">No results</p><p class="section-hint">' + msg + '</p></div>';
        }
        const wrap = card.querySelector('.gi-table-wrap') || card.querySelector('.detection-empty');
        if (wrap) {
            const frag = document.createRange().createContextualFragment(tableHtml);
            wrap.replaceWith(frag);
            card.querySelectorAll('.detection-gen-case').forEach(btn => {
                btn.addEventListener('click', function() {
                    let evidence = null;
                    try { if (this.dataset.evidence) evidence = JSON.parse(this.dataset.evidence); } catch (e) {}
                    detectionGenerateCase(this.dataset.subjectType, this.dataset.subjectId, this.dataset.subjectId2, {
                        rule_id: this.dataset.ruleId || '',
                        calculation_window: this.dataset.window || '',
                        stake_band: this.dataset.stakeBand || '',
                        evidence: evidence,
                    });
                });
            });
        }
    } catch (e) {
        const wrap = card.querySelector('.gi-table-wrap') || card.querySelector('.detection-empty');
        if (wrap) wrap.outerHTML = '<div class="detection-empty"><p class="detection-empty-title">Error</p><p class="section-hint" style="color:var(--danger);">' + escapeHtmlResults(e.message || 'error') + '</p></div>';
    }
    card.querySelector('.gi-table-wrap, .detection-empty')?.classList.remove('detection-loading');
}

async function detectionGenerateCase(subjectType, subjectId, subjectId2, opts) {
    if (!subjectId) { alert('No subject to create a case for.'); return; }
    try {
        const payload = { subject_type: subjectType || 'player', subject_id: subjectId };
        if ((subjectType || '') === 'pair' && subjectId2) payload.subject_id_2 = subjectId2;
        if (opts && typeof opts === 'object') {
            if (opts.rule_id) payload.rule_id = opts.rule_id;
            if (opts.calculation_window) payload.calculation_window = opts.calculation_window;
            if (opts.stake_band) payload.stake_band = opts.stake_band;
            if (opts.evidence != null) payload.evidence = opts.evidence;
        }
        const data = await apiCall('/api/ews/cases', 'POST', payload);
        if (data.case_id) { alert('Case created. You can open it from Case Management.'); ewsLoadCases(); }
    } catch (e) { alert(e.message || 'Failed to create case'); }
}

function ewsFormatRule11Detail(evidenceSummary) {
    try {
        const d = JSON.parse(evidenceSummary);
        if (!d.summary_line) return null;
        let tableHtml = '';
        if (d.table_rows && d.table_rows.length) {
            const headers = ['Opponent', 'A→B (BB)', 'B→A (BB)', 'Net Transfer', 'Stake (BB)', 'Time window', 'Comparison to baseline'];
            tableHtml = '<table class="ews-rule11-table"><thead><tr>' + headers.map(h => '<th>' + escapeHtmlResults(h) + '</th>').join('') + '</tr></thead><tbody>';
            d.table_rows.forEach(row => {
                tableHtml += '<tr><td>' + escapeHtmlResults(row.opponent || '') + '</td><td>' + escapeHtmlResults(String(row.a_to_b_bb ?? '—')) + '</td><td>' + escapeHtmlResults(String(row.b_to_a_bb ?? '—')) + '</td><td>' + escapeHtmlResults(String(row.net_transfer_bb ?? '—')) + '</td><td>' + escapeHtmlResults(String(row.stake_bb ?? '—')) + '</td><td>' + escapeHtmlResults(String(row.time_window ?? '—')) + '</td><td>' + escapeHtmlResults(String(row.comparison_baseline ?? '—')) + '</td></tr>';
            });
            tableHtml += '</tbody></table>';
        }
        const dataDisplay = d.data_display || {};
        const dataRows = [
            ['A_to_B_amount', dataDisplay.a_to_b_amount],
            ['B_to_A_amount', dataDisplay.b_to_a_amount],
            ['net_amount', dataDisplay.net_amount],
            ['currency', dataDisplay.currency],
            ['stake (BB)', dataDisplay.stake_bb],
            ['Normalised BB', dataDisplay.normalised_bb],
            ['Supporting hands (Game Code)', dataDisplay.supporting_hands_game_codes],
        ].filter(([, v]) => v != null && v !== '').map(([k, v]) => '<tr><td>' + escapeHtmlResults(k) + '</td><td>' + escapeHtmlResults(String(v)) + '</td></tr>').join('');
        return '<div class="ews-rule11-detail">' +
            '<p class="ews-rule11-rule">' + escapeHtmlResults(d.rule_group || '') + '</p>' +
            '<p class="ews-rule11-name">' + escapeHtmlResults(d.rule_name || '') + '</p>' +
            '<h5>What to show</h5><p class="ews-rule11-summary">' + escapeHtmlResults(d.summary_line) + '</p>' + tableHtml +
            '<h5>Why it triggered</h5><p>' + escapeHtmlResults(d.why_triggered || '') + '</p>' +
            '<h5>Data to display</h5><table class="ews-rule11-data">' + dataRows + '</table>' +
            '<h5>DB source</h5><p class="ews-rule11-db">' + escapeHtmlResults(d.db_source || '') + '</p></div>';
    } catch (e) {
        return null;
    }
}

async function ewsLoadPairs() {
    const tbody = document.getElementById('ewsPairsTableBody');
    const emptyEl = document.getElementById('ewsPairsEmpty');
    if (!tbody) return;
    try {
        const data = await apiCall('/api/ews/flagged-pairs');
        const pairs = data.pairs || [];
        if (emptyEl) emptyEl.style.display = pairs.length ? 'none' : 'block';
        window.ewsLastPairs = pairs;
        tbody.innerHTML = pairs.map((p) => {
            const scoreClass = p.score >= 70 ? 'ews-critical' : p.score >= 50 ? 'ews-high' : p.score >= 30 ? 'ews-medium' : 'ews-low';
            const contextPreview = (p.evidence_summary || '').slice(0, 80);
            const evidenceFull = escapeHtmlResults(p.evidence_summary || '');
            return `<tr>
                <td>${escapeHtmlResults(p.player_a)}</td>
                <td>${escapeHtmlResults(p.player_b)}</td>
                <td><span class="ews-score ${scoreClass}">${p.score}</span></td>
                <td class="ews-rules">${escapeHtmlResults((p.triggered_rules || '').slice(0, 60))}${(p.triggered_rules || '').length > 60 ? '…' : ''}</td>
                <td class="ews-context" title="${evidenceFull}">${escapeHtmlResults(contextPreview)}${(contextPreview || '').length >= 80 ? '…' : ''}</td>
                <td><button type="button" class="btn btn-primary btn-sm ews-pair-case" data-a="${escapeHtmlResults(p.player_a)}" data-b="${escapeHtmlResults(p.player_b)}">Open case</button></td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('.ews-pair-case').forEach(btn => btn.addEventListener('click', () => ewsOpenCaseForPair(btn.dataset.a, btn.dataset.b)));
    } catch (e) {
        if (emptyEl) { emptyEl.textContent = 'Could not load: ' + (e.message || 'error'); emptyEl.style.display = 'block'; }
        tbody.innerHTML = '';
    }
}

async function ewsLoadCases() {
    const tbody = document.getElementById('ewsCasesTableBody');
    const emptyEl = document.getElementById('ewsCasesEmpty');
    const statusFilter = document.getElementById('ewsCaseStatusFilter');
    const status = statusFilter && statusFilter.value ? statusFilter.value : '';
    if (!tbody) return;
    try {
        const url = status ? `/api/ews/cases?status=${encodeURIComponent(status)}` : '/api/ews/cases';
        const data = await apiCall(url);
        const cases = data.cases || [];
        if (emptyEl) emptyEl.style.display = cases.length ? 'none' : 'block';
        tbody.innerHTML = cases.map(c => {
            const subj = c.subject_type === 'pair' ? `${escapeHtmlResults(c.subject_id)} / ${escapeHtmlResults(c.subject_id_2 || '')}` : escapeHtmlResults(c.subject_id);
            return `<tr>
                <td>${subj}</td>
                <td>${escapeHtmlResults(c.status)}</td>
                <td>${escapeHtmlResults(c.severity || '—')}</td>
                <td>${escapeHtmlResults((c.updated_at || '').slice(0, 19))}</td>
                <td><button type="button" class="btn btn-secondary btn-sm ews-view-case" data-id="${c.id}">View</button></td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('.ews-view-case').forEach(btn => btn.addEventListener('click', () => ewsViewCase(parseInt(btn.dataset.id, 10))));
    } catch (e) {
        if (emptyEl) { emptyEl.textContent = 'Could not load: ' + (e.message || 'error'); emptyEl.style.display = 'block'; }
        tbody.innerHTML = '';
    }
}

function ewsViewCase(caseId) {
    window.ewsCurrentCaseId = caseId;
    const overlay = document.getElementById('ewsCaseModal');
    if (overlay) {
        overlay.style.display = 'flex';
        ewsLoadCaseDetail(caseId);
    } else {
        alert('Case detail modal not found. Case ID: ' + caseId);
    }
}

async function ewsLoadCaseDetail(caseId) {
    const body = document.getElementById('ewsCaseModalBody');
    if (!body) return;
    try {
        const c = await apiCall(`/api/ews/cases/${caseId}`);
        body.innerHTML = `
            <div class="ews-case-detail">
                <p><strong>Subject:</strong> ${c.subject_type === 'pair' ? escapeHtmlResults(c.subject_id + ' / ' + (c.subject_id_2 || '')) : escapeHtmlResults(c.subject_id)}</p>
                <p><strong>Status:</strong> ${escapeHtmlResults(c.status)} <strong>Severity:</strong> ${escapeHtmlResults(c.severity || '—')}</p>
                <label>Notes</label>
                <ul id="ewsCaseNotesList">${(c.notes || []).map(n => '<li>' + escapeHtmlResults(n.content) + ' <small>' + (n.created_at || '').slice(0, 19) + '</small></li>').join('')}</ul>
                <input type="text" id="ewsCaseNewNote" class="input-control" placeholder="Add note…">
                <button type="button" class="btn btn-primary btn-sm" onclick="ewsAddCaseNote()">Add note</button>
                <label>Files</label>
                <ul id="ewsCaseFilesList">${(c.files || []).map(f => '<li>' + escapeHtmlResults(f.filename) + '</li>').join('')}</ul>
                <input type="file" id="ewsCaseFileInput" class="input-control">
                <button type="button" class="btn btn-secondary btn-sm" onclick="ewsUploadCaseFile()">Upload file</button>
                <label>Status</label>
                <select id="ewsCaseStatusSelect" class="select-control"><option value="open" ${c.status === 'open' ? 'selected' : ''}>Open</option><option value="under review" ${c.status === 'under review' ? 'selected' : ''}>Under review</option><option value="closed" ${c.status === 'closed' ? 'selected' : ''}>Closed</option></select>
                <button type="button" class="btn btn-primary btn-sm" onclick="ewsUpdateCaseStatus()">Update status</button>
            </div>`;
    } catch (e) {
        body.innerHTML = '<p class="gi-error">Failed to load case: ' + escapeHtmlResults(e.message) + '</p>';
    }
}

async function ewsAddCaseNote() {
    const input = document.getElementById('ewsCaseNewNote');
    const caseId = window.ewsCurrentCaseId;
    if (!caseId || !input || !input.value.trim()) return;
    try {
        await apiCall(`/api/ews/cases/${caseId}/notes`, 'POST', { content: input.value.trim() });
        input.value = '';
        ewsLoadCaseDetail(caseId);
    } catch (e) { alert(e.message || 'Failed to add note'); }
}

async function ewsUploadCaseFile() {
    const input = document.getElementById('ewsCaseFileInput');
    const caseId = window.ewsCurrentCaseId;
    if (!caseId || !input || !input.files || !input.files[0]) { alert('Select a file.'); return; }
    const form = new FormData();
    form.append('file', input.files[0]);
    try {
        await fetch(`/api/ews/cases/${caseId}/files`, { method: 'POST', body: form });
        input.value = '';
        ewsLoadCaseDetail(caseId);
    } catch (e) { alert('Upload failed: ' + e.message); }
}

async function ewsUpdateCaseStatus() {
    const sel = document.getElementById('ewsCaseStatusSelect');
    const caseId = window.ewsCurrentCaseId;
    if (!caseId || !sel) return;
    try {
        await apiCall(`/api/ews/cases/${caseId}`, 'PUT', { status: sel.value });
        ewsLoadCaseDetail(caseId);
        ewsLoadCases();
    } catch (e) { alert(e.message || 'Failed to update'); }
}

function ewsCloseCaseModal() {
    const overlay = document.getElementById('ewsCaseModal');
    if (overlay) overlay.style.display = 'none';
}

async function ewsRunEvaluation() {
    const btn = document.getElementById('btnEwsRunEval');
    if (btn) btn.disabled = true;
    try {
        const data = await apiCall('/api/ews/run-evaluation', 'POST');
        alert(`Evaluation complete. Players: ${data.players_evaluated || 0}, Pairs: ${data.pairs_evaluated || 0}.`);
        ewsLoadFlaggedPlayers();
        ewsLoadPairs();
    } catch (e) { alert(e.message || 'Evaluation failed'); }
    if (btn) btn.disabled = false;
}

// --- Collusion Dashboard (tweakable thresholds + processor API) ---
function collusionDashboardInit() {
    const pairs = [
        ['collusionSharedIp', 'collusionSharedIpVal', false],
        ['collusionLoss', 'collusionLossVal', false],
        ['collusionVpip', 'collusionVpipVal', false],
        ['collusionHands', 'collusionHandsVal', false],
        ['collusionScore', 'collusionScoreVal', false]
    ];
    pairs.forEach(function (p) {
        const input = document.getElementById(p[0]);
        const span = document.getElementById(p[1]);
        if (!input || !span) return;
        span.textContent = input.value;
        input.addEventListener('input', function () { span.textContent = input.value; });
    });
    const btn = document.getElementById('btnCollusionRun');
    if (btn) btn.addEventListener('click', collusionRunAnalysis);
}

async function collusionRunAnalysis() {
    const btn = document.getElementById('btnCollusionRun');
    const errEl = document.getElementById('collusionError');
    const tbody = document.getElementById('collusionTableBody');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (tbody) tbody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';
    if (btn) btn.disabled = true;
    const settings = {
        sharedIpThreshold: parseInt(document.getElementById('collusionSharedIp')?.value || '3', 10),
        lossThreshold: parseInt(document.getElementById('collusionLoss')?.value || '-500', 10),
        minVpipThreshold: parseInt(document.getElementById('collusionVpip')?.value || '50', 10),
        minHandsRequired: parseInt(document.getElementById('collusionHands')?.value || '100', 10),
        caseTriggerScore: parseInt(document.getElementById('collusionScore')?.value || '70', 10),
        weights: {
            ip: parseInt(document.getElementById('collusionWip')?.value || '50', 10),
            wealth: parseInt(document.getElementById('collusionWwealth')?.value || '30', 10),
            vpip: parseInt(document.getElementById('collusionWvpip')?.value || '20', 10)
        }
    };
    try {
        const res = await fetch(API + '/api/collusion/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        const data = await res.json();
        if (tbody) {
            if (data.error) {
                tbody.innerHTML = '<tr><td colspan="3">' + escapeHtmlResults(data.error) + '</td></tr>';
            } else if (!data.cases || data.cases.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3">No cases above threshold. Adjust sliders and run again.</td></tr>';
            } else {
                tbody.innerHTML = data.cases.map(function (c) {
                    return '<tr><td>' + escapeHtmlResults(c.nickname) + '</td><td>' + escapeHtmlResults(String(c.risk_score)) + '</td><td>' + escapeHtmlResults(c.reason || '') + '</td></tr>';
                }).join('');
            }
        }
        if (data.error && errEl) { errEl.textContent = data.error; errEl.style.display = 'block'; }
    } catch (e) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="3">' + escapeHtmlResults(e.message || 'Request failed') + '</td></tr>';
        if (errEl) { errEl.textContent = e.message || 'Request failed'; errEl.style.display = 'block'; }
    }
    if (btn) btn.disabled = false;
}

// --- Trust & Safety Triage (real-time) + Case Workspace ---
let triageSocket = null;
let triageCases = [];

function triageLoad() {
    triageLoadRuleSettings();
    triageLoadCases();
    triageConnectSocket();
    triageBindSliders();
    const saveBtn = document.getElementById('btnTriageSaveRules');
    if (saveBtn) saveBtn.addEventListener('click', triageSaveRuleSettings);
}

function triageBindSliders() {
    const pairs = [['triageSharedIp', 'triageSharedIpVal'], ['triageLoss', 'triageLossVal'], ['triageVpip', 'triageVpipVal'], ['triageScore', 'triageScoreVal']];
    pairs.forEach(function (p) {
        const input = document.getElementById(p[0]);
        const span = document.getElementById(p[1]);
        if (input && span) { span.textContent = input.value; input.addEventListener('input', function () { span.textContent = input.value; }); }
    });
}

async function triageLoadRuleSettings() {
    try {
        const data = await apiCall('/api/collusion/rule-settings');
        const el = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
        el('triageSharedIp', data.sharedIpThreshold);
        el('triageSharedIpVal', data.sharedIpThreshold);
        el('triageLoss', data.lossThreshold);
        el('triageLossVal', data.lossThreshold);
        el('triageVpip', data.minVpipThreshold);
        el('triageVpipVal', data.minVpipThreshold);
        el('triageScore', data.caseTriggerScore);
        el('triageScoreVal', data.caseTriggerScore);
    } catch (e) { /* ignore */ }
}

async function triageSaveRuleSettings() {
    const statusEl = document.getElementById('triageSaveStatus');
    try {
        await fetch(API + '/api/collusion/rule-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sharedIpThreshold: parseInt(document.getElementById('triageSharedIp')?.value || '2', 10),
                lossThreshold: parseInt(document.getElementById('triageLoss')?.value || '-500', 10),
                minVpipThreshold: parseInt(document.getElementById('triageVpip')?.value || '40', 10),
                minHandsRequired: 500,
                caseTriggerScore: parseInt(document.getElementById('triageScore')?.value || '60', 10),
                weights: { ip: 50, wealth_dump: 40, high_vpip: 20 }
            })
        });
        if (statusEl) { statusEl.textContent = 'Saved. Scanner will use these on next run.'; statusEl.style.color = 'var(--success, green)'; setTimeout(() => { statusEl.textContent = ''; }, 3000); }
    } catch (e) { if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.style.color = 'var(--danger)'; } }
}

async function triageLoadCases() {
    const tbody = document.getElementById('triageTableBody');
    if (!tbody) return;
    try {
        const list = await apiCall('/api/collusion/cases');
        triageCases = Array.isArray(list) ? list : [];
        triageRenderCases(tbody, triageCases);
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6">Failed to load cases</td></tr>';
    }
}

function triageRenderCases(tbody, cases) {
    if (!cases || cases.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6">No cases yet. The scanner runs every 60s.</td></tr>';
        return;
    }
    const scoreClass = (s) => s >= 80 ? 'risk-high' : s >= 70 ? 'risk-mid' : 'risk-low';
    tbody.innerHTML = cases.map(function (c) {
        const score = c.risk_score != null ? c.risk_score : 0;
        return '<tr data-case-id="' + (c.id || '') + '">' +
            '<td><span class="risk-badge ' + scoreClass(score) + '">' + escapeHtmlResults(String(score)) + '</span></td>' +
            '<td>' + escapeHtmlResults(c.player_nickname || '') + '</td>' +
            '<td class="triage-scenarios-cell">' + escapeHtmlResults(c.triggered_scenarios || '') + '</td>' +
            '<td>' + escapeHtmlResults(c.status || 'Open') + '</td>' +
            '<td>' + escapeHtmlResults(c.assigned_agent || '—') + '</td>' +
            '<td><button type="button" class="btn btn-primary btn-sm triage-investigate-btn" data-case-id="' + (c.id || '') + '" data-nickname="' + escapeHtmlResults(c.player_nickname || '') + '">Investigate</button></td></tr>';
    }).join('');
    tbody.querySelectorAll('.triage-investigate-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { openCaseWorkspace(btn.dataset.caseId, btn.dataset.nickname); });
    });
}

function triageConnectSocket() {
    if (triageSocket) return;
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        triageSocket = io(protocol + '//' + host, { path: '/socket.io', transports: ['polling'] });
        triageSocket.on('new_case_alert', function (payload) {
            triageCases = [payload].concat(triageCases);
            const tbody = document.getElementById('triageTableBody');
            if (tbody) triageRenderCases(tbody, triageCases);
            const flash = document.getElementById('triageAlertFlash');
            if (flash) { flash.style.display = 'block'; flash.classList.add('triage-flash-on'); setTimeout(function () { flash.style.display = 'none'; flash.classList.remove('triage-flash-on'); }, 3000); }
        });
    } catch (e) { /* socket not available */ }
}

let currentCaseWorkspaceId = null;

function openCaseWorkspace(caseId, nickname) {
    currentCaseWorkspaceId = caseId;
    document.getElementById('caseWorkspaceNickname').textContent = nickname || '';
    document.getElementById('caseWorkspaceOverlay').style.display = 'flex';
    caseWorkspaceLoad(caseId, nickname);
}

function closeCaseWorkspace() {
    document.getElementById('caseWorkspaceOverlay').style.display = 'none';
    currentCaseWorkspaceId = null;
}

async function caseWorkspaceLoad(caseId, nickname) {
    const profileNickname = document.getElementById('caseProfileNickname');
    const kpiVpip = document.getElementById('caseKpiVpip');
    const kpiHands = document.getElementById('caseKpiHands');
    const kpiBb100 = document.getElementById('caseKpiBb100');
    const kpiWin = document.getElementById('caseKpiWin');
    const networkBody = document.getElementById('caseNetworkBody');
    const notesEl = document.getElementById('caseWorkspaceNotes');
    notesEl.innerHTML = '';
    if (profileNickname) profileNickname.textContent = nickname || '—';
    if (caseId) try {
        const caseData = await apiCall('/api/collusion/cases/' + caseId);
        document.getElementById('caseWorkspaceStatus').value = caseData.status || 'Open';
        document.getElementById('caseWorkspaceAgent').value = caseData.assigned_agent || '';
        document.getElementById('caseWorkspaceDecision').value = caseData.decision_summary || '';
        (caseData.notes || []).forEach(function (n) {
            const div = document.createElement('div');
            div.className = 'case-note-item';
            div.innerHTML = '<span class="case-note-time">' + escapeHtmlResults((n.created_at || '').slice(0, 19)) + '</span> ' + (n.agent ? '<span class="case-note-agent">' + escapeHtmlResults(n.agent) + '</span>: ' : '') + escapeHtmlResults(n.content || '');
            notesEl.appendChild(div);
        });
    } catch (e) { /* */ }
    if (!caseId) {
        document.getElementById('btnCaseWorkspaceSave').disabled = true;
        document.getElementById('btnCaseWorkspaceAddNote').disabled = true;
    } else {
        document.getElementById('btnCaseWorkspaceSave').disabled = false;
        document.getElementById('btnCaseWorkspaceAddNote').disabled = false;
    }
    try {
        const enc = encodeURIComponent(nickname || '');
        const data = await apiCall('/api/player/' + enc);
        const profile = data.profile || {};
        const network = data.network || [];
        if (kpiVpip) kpiVpip.textContent = profile.vpip != null ? profile.vpip + '%' : '—';
        if (kpiHands) kpiHands.textContent = profile.hands != null ? profile.hands : '—';
        if (kpiBb100) kpiBb100.textContent = profile.bb100 != null ? profile.bb100 : '—';
        if (kpiWin) kpiWin.textContent = profile.earnings_from_others != null ? profile.earnings_from_others : '—';
        if (networkBody) {
            networkBody.innerHTML = network.length === 0 ? '<tr><td colspan="4">No shared IP / tournament data</td></tr>' : network.map(function (r) {
                return '<tr><td>' + escapeHtmlResults(r.shared_ips || '') + '</td><td>' + escapeHtmlResults(r.tournament_code || '') + '</td><td>' + escapeHtmlResults(r.nicknames_involved || '') + '</td><td>' + escapeHtmlResults(r.total_win != null ? String(r.total_win) : '') + '</td></tr>';
            }).join('');
        }
    } catch (e) {
        if (kpiVpip) kpiVpip.textContent = '—';
        if (kpiHands) kpiHands.textContent = '—';
        if (kpiBb100) kpiBb100.textContent = '—';
        if (kpiWin) kpiWin.textContent = '—';
        if (networkBody) networkBody.innerHTML = '<tr><td colspan="4">Error loading 360 data</td></tr>';
    }
    document.getElementById('btnCaseWorkspaceSave').onclick = function () { caseWorkspaceSave(caseId); };
    document.getElementById('btnCaseWorkspaceAddNote').onclick = function () { caseWorkspaceAddNote(caseId); };
}

async function caseWorkspaceSave(caseId) {
    const status = document.getElementById('caseWorkspaceStatus').value;
    const agent = document.getElementById('caseWorkspaceAgent').value;
    const decision = document.getElementById('caseWorkspaceDecision').value;
    try {
        await fetch(API + '/api/collusion/cases/' + caseId, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status, assigned_agent: agent, decision_summary: decision })
        });
        triageLoadCases();
    } catch (e) { alert('Save failed'); }
}

async function caseWorkspaceAddNote(caseId) {
    const input = document.getElementById('caseWorkspaceNoteInput');
    const content = (input && input.value || '').trim();
    if (!content) return;
    const agent = (document.getElementById('caseWorkspaceAgent') && document.getElementById('caseWorkspaceAgent').value || '').trim();
    try {
        const note = await apiCall('/api/collusion/cases/' + caseId + '/notes', 'POST', { content: content, agent: agent });
        input.value = '';
        const div = document.createElement('div');
        div.className = 'case-note-item';
        div.innerHTML = '<span class="case-note-time">' + (note.created_at || '').slice(0, 19) + '</span> ' + (note.agent ? '<span class="case-note-agent">' + escapeHtmlResults(note.agent) + '</span>: ' : '') + escapeHtmlResults(note.content || '');
        document.getElementById('caseWorkspaceNotes').appendChild(div);
    } catch (e) { alert('Add note failed'); }
}

/* ——— Operations dashboard (PostgreSQL metrics; Reports service :5000) ——— */
let _opsAutoTimer = null;
window._opsCharts = window._opsCharts || {};

function opsDashboardStopAuto() {
    if (_opsAutoTimer) {
        clearInterval(_opsAutoTimer);
        _opsAutoTimer = null;
    }
}

function opsDashboardDestroyCharts() {
    const charts = window._opsCharts || {};
    Object.keys(charts).forEach((k) => {
        try {
            charts[k].destroy();
        } catch (e) {}
        delete charts[k];
    });
}

function opsDashboardFormat(n) {
    if (n == null || n === '') return '—';
    if (typeof n === 'number' && !Number.isFinite(n)) return '—';
    if (typeof n === 'number' && Number.isInteger(n)) return n.toLocaleString();
    if (typeof n === 'number') return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return String(n);
}

function opsNaNum(row, k) {
    if (!row || k == null) return null;
    const v = row[k];
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** X-axis labels like 04-07T10:00 (month-day T hour:minute); day-only → MM-DD */
function opsChartAxisTime(raw) {
    if (raw == null || raw === '') return '';
    const s = String(raw).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (iso) return iso[2] + '-' + iso[3] + 'T' + iso[4] + ':' + iso[5];
    const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (day) return day[2] + '-' + day[3];
    return s.length > 20 ? opsChartAxisTime(s.slice(0, 19)) : s;
}

function opsNaTimeLabel(tsKey, row) {
    const v = row && tsKey ? row[tsKey] : null;
    return opsChartAxisTime(v);
}

function opsMergeFeesBuyinsByDay(feesArr, buyinsArr) {
    const m = new Map();
    (feesArr || []).forEach((r) => {
        const t = String(r.t);
        const cur = m.get(t) || { t: t, fees: 0, buyins: 0 };
        cur.fees = Number(r.v) || 0;
        m.set(t, cur);
    });
    (buyinsArr || []).forEach((r) => {
        const t = String(r.t);
        const cur = m.get(t) || { t: t, fees: 0, buyins: 0 };
        cur.buyins = Number(r.v) || 0;
        m.set(t, cur);
    });
    return Array.from(m.values()).sort((a, b) => a.t.localeCompare(b.t));
}

function opsToggleEmpty(canvasId, emptyId, isEmpty, msg) {
    const cv = document.getElementById(canvasId);
    const em = document.getElementById(emptyId);
    if (!cv || !em) return;
    if (isEmpty) {
        cv.style.display = 'none';
        em.hidden = false;
        em.textContent = msg || 'No data for this chart.';
    } else {
        cv.style.display = 'block';
        em.hidden = true;
    }
}

function opsRowsHaveAnyNumeric(rows, keys) {
    if (!rows || !rows.length) return false;
    return rows.some((row) => keys.some((k) => opsNaNum(row, k) != null));
}

function opsDashboardOnShow() {
    opsDashboardStopAuto();
    const autoSel = document.getElementById('opsDashboardAuto');
    const sec = autoSel ? parseInt(autoSel.value, 10) || 0 : 0;
    opsDashboardRefresh();
    if (sec > 0) {
        _opsAutoTimer = setInterval(() => opsDashboardRefresh(), sec * 1000);
    }
    if (autoSel) autoSel.onchange = () => opsDashboardOnShow();
    const hrs = document.getElementById('opsDashboardHours');
    if (hrs) hrs.onchange = () => opsDashboardRefresh();
}

async function opsDashboardRefresh() {
    if (typeof Chart === 'undefined') {
        const st = document.getElementById('opsDashboardStatus');
        if (st) st.textContent = 'Chart.js failed to load. Check network or CDN.';
        return;
    }
    const statusEl = document.getElementById('opsDashboardStatus');
    const kpiEl = document.getElementById('opsDashboardKpis');
    const tablesEl = document.getElementById('opsDashboardTables');
    if (!kpiEl) return;
    const hours = (document.getElementById('opsDashboardHours') && document.getElementById('opsDashboardHours').value) || '24';
    const dbEl = document.getElementById('defaultDbConn');
    const dbConn = (dbEl && dbEl.value && dbEl.value.trim()) ? dbEl.value.trim() : '';
    let qs = '?hours=' + encodeURIComponent(hours);
    if (dbConn) qs += '&db_connection_string=' + encodeURIComponent(dbConn);
    if (statusEl) statusEl.textContent = 'Loading…';
    let data;
    try {
        const res = await fetch(REPORTS_API + '/api/ops-dashboard/metrics' + qs);
        data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Error: ' + (e.message || e);
        return;
    }
    if (statusEl) {
        const errPart = (data.errors && data.errors.length) ? ' · ' + data.errors.length + ' partial warning(s)' : '';
        const metaNote = (data.meta && data.meta.tournament_dc_cardroom_note) ? ' · ' + data.meta.tournament_dc_cardroom_note : '';
        statusEl.textContent = 'Updated ' + (data.refreshed_at || '').replace('T', ' ').slice(0, 19) + 'Z · window ' + (data.hours || hours) + 'h' + errPart + metaNote;
    }
    const K = data.kpis || {};
    const kpis = [
        { label: 'Logins (window)', value: opsDashboardFormat(K.logins_window), hint: 'Login activity extract' },
        { label: 'Unique players (logins)', value: opsDashboardFormat(K.unique_players_login_window), hint: 'Distinct Player Code' },
        { label: 'Tournament fees (window)', value: opsDashboardFormat(K.tournament_fees_window), hint: 'Sum of Fees column' },
        { label: 'Tournament buy-ins (window)', value: opsDashboardFormat(K.tournament_buyins_window), hint: 'Sum of Buy-ins' },
        { label: 'Connected players (latest)', value: opsDashboardFormat(K.network_connected_latest), hint: 'Network activity snapshot' },
        { label: 'Online players (latest)', value: opsDashboardFormat(K.online_players), hint: 'Business monitoring' },
        { label: 'Current logins (latest)', value: opsDashboardFormat(K.current_logins), hint: 'Business monitoring' },
        { label: 'Disconnection rate (latest %)', value: opsDashboardFormat(K.disconnection_rate_latest), hint: 'Network disconnection rate' },
        { label: 'Tournament DC events', value: opsDashboardFormat(K.tournament_disconnection_events_window), hint: 'Tournament disconnection report' },
    ];
    kpiEl.innerHTML = kpis.map((k) => (
        '<div class="ops-dashboard-kpi" title="' + (k.hint || '').replace(/"/g, '&quot;') + '">' +
        '<div class="ops-dashboard-kpi-label">' + k.label + '</div>' +
        '<div class="ops-dashboard-kpi-value">' + k.value + '</div></div>'
    )).join('');
    if (tablesEl && data.tables) {
        let listHtml = Object.entries(data.tables).map(([key, name]) => (
            '<li><strong>' + key + '</strong>: ' + (name ? '<code>' + name + '</code>' : '<span class="ops-dashboard-missing">not found</span>') + '</li>'
        )).join('');
        const M2 = data.meta || {};
        const hints = [];
        if (M2.database) hints.push('DB: <code>' + M2.database + '</code>');
        if (M2.network_activity_row_count != null) hints.push('network_activity rows: ' + M2.network_activity_row_count);
        if (M2.login_time_column) hints.push('Login time column: <code>' + M2.login_time_column + '</code>');
        if (M2.network_statistics_date_column) hints.push('Network time column: <code>' + M2.network_statistics_date_column + '</code>');
        if (M2.tournament_dc_cardroom_column) hints.push('Tournament DC cardroom column: <code>' + M2.tournament_dc_cardroom_column + '</code>');
        if (M2.sng_casino_column) hints.push('SNG casino column: <code>' + M2.sng_casino_column + '</code>');
        if (M2.sng_stats_date_column) hints.push('SNG stats date: <code>' + M2.sng_stats_date_column + '</code>');
        if (hints.length) listHtml += '<li class="ops-dashboard-meta-line">' + hints.join(' · ') + '</li>';
        tablesEl.innerHTML = listHtml;
    }
    opsDashboardDestroyCharts();
    const grid = '#94a3b8';
    const tick = '#cbd5e1';
    const commonOpts = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: tick, boxWidth: 10, font: { size: 10 } } } },
        scales: {
            x: {
                ticks: {
                    color: grid,
                    maxRotation: 45,
                    minRotation: 0,
                    font: { size: 10 },
                    autoSkip: true,
                    maxTicksLimit: 32,
                },
                grid: { color: 'rgba(148,163,184,0.12)' },
            },
            y: { ticks: { color: grid, font: { size: 10 } }, grid: { color: 'rgba(148,163,184,0.12)' } },
        },
    };
    /* Tight bars: high categoryPercentage uses most of the x-axis per tick; barPercentage fills the group slot */
    const opsBarDense = {
        categoryPercentage: 0.98,
        barPercentage: 0.92,
        borderRadius: 4,
        borderWidth: 0,
    };
    /* Grouped charts (many series per category): slightly thinner siblings so labels still fit */
    const opsBarDenseGrouped = {
        categoryPercentage: 0.98,
        barPercentage: 0.82,
        borderRadius: 3,
        borderWidth: 0,
    };
    const opsBarOpts = {
        ...commonOpts,
        datasets: { bar: opsBarDense },
    };
    const opsBarOptsGrouped = {
        ...commonOpts,
        datasets: { bar: opsBarDenseGrouped },
    };
    const S = data.series || {};
    const M = data.meta || {};
    const tsKey = 'Statistics date';
    const na = S.network_activity_full || [];
    const tblNetworkActivity = (data.tables || {}).network_activity;
    function opsNetChartEmpty(detailMsg) {
        if (!tblNetworkActivity) {
            return 'No table network_activity in this database. Confirm Default DB matches where scheduled reports import (e.g. game_integrity).';
        }
        if (!na.length) {
            return 'network_activity has no rows, or the time column failed to load. Verify imports and check Resolved tables below.';
        }
        return detailMsg || 'Values missing for these metrics (unexpected column names).';
    }

    const netTableKeys = [
        ['Avg # of real tables', '#22d3ee'],
        ['Max # of real tables', '#a78bfa'],
        ['Min # of real tables', '#6366f1'],
        ['Average # of fun tables', '#94a3b8'],
        ['Max # of fun tables', '#64748b'],
        ['Min # of fun tables', '#475569'],
    ];
    const hasNetTables = opsRowsHaveAnyNumeric(na, netTableKeys.map((x) => x[0]));
    if (!hasNetTables) {
        opsToggleEmpty('opsChartNetTables', 'opsEmptyNetTables', true, opsNetChartEmpty('Real/fun table columns not found on rows.'));
    } else {
        opsToggleEmpty('opsChartNetTables', 'opsEmptyNetTables', false);
        window._opsCharts.netTables = new Chart(document.getElementById('opsChartNetTables'), {
            type: 'bar',
            data: {
                labels: na.map((r) => opsNaTimeLabel(tsKey, r)),
                datasets: netTableKeys.map(([k, col]) => ({
                    label: k.replace('Average # of ', 'Avg '),
                    data: na.map((r) => opsNaNum(r, k)),
                    backgroundColor: col + 'B3',
                    hoverBackgroundColor: col,
                    spanGaps: true,
                })),
            },
            options: opsBarOptsGrouped,
        });
    }

    const netPlayerKeys = [
        ['Average # of real players', '#22d3ee'],
        ['Max # of real players', '#a78bfa'],
        ['Min # of real players', '#6366f1'],
        ['Average # of fun players', '#94a3b8'],
        ['Max # of fun players', '#64748b'],
        ['Min # of fun players', '#475569'],
    ];
    const hasNetPlayers = opsRowsHaveAnyNumeric(na, netPlayerKeys.map((x) => x[0]));
    if (!hasNetPlayers) {
        opsToggleEmpty('opsChartNetPlayers', 'opsEmptyNetPlayers', true, opsNetChartEmpty('Real/fun player columns not found on rows.'));
    } else {
        opsToggleEmpty('opsChartNetPlayers', 'opsEmptyNetPlayers', false);
        window._opsCharts.netPlayers = new Chart(document.getElementById('opsChartNetPlayers'), {
            type: 'bar',
            data: {
                labels: na.map((r) => opsNaTimeLabel(tsKey, r)),
                datasets: netPlayerKeys.map(([k, col]) => ({
                    label: k,
                    data: na.map((r) => opsNaNum(r, k)),
                    backgroundColor: col + 'B3',
                    hoverBackgroundColor: col,
                    spanGaps: true,
                })),
            },
            options: opsBarOptsGrouped,
        });
    }

    const netConnKeys = [
        ['Average # of connected players', '#22d3ee'],
        ['Max # of connected players', '#a78bfa'],
        ['Min # of connected players', '#6366f1'],
    ];
    const hasNetConn = opsRowsHaveAnyNumeric(na, netConnKeys.map((x) => x[0]));
    if (!hasNetConn) {
        opsToggleEmpty('opsChartNetConnected', 'opsEmptyNetConnected', true, opsNetChartEmpty('Connected-player columns not found on rows.'));
    } else {
        opsToggleEmpty('opsChartNetConnected', 'opsEmptyNetConnected', false);
        window._opsCharts.netConn = new Chart(document.getElementById('opsChartNetConnected'), {
            type: 'bar',
            data: {
                labels: na.map((r) => opsNaTimeLabel(tsKey, r)),
                datasets: netConnKeys.map(([k, col]) => ({
                    label: k.replace('Average # of ', 'Avg '),
                    data: na.map((r) => opsNaNum(r, k)),
                    backgroundColor: col + 'B3',
                    hoverBackgroundColor: col,
                    spanGaps: true,
                })),
            },
            options: opsBarOptsGrouped,
        });
    }

    const netTourneyKeys = [
        ['Average # of tournaments', '#22d3ee'],
        ['Max # of tournaments', '#a78bfa'],
        ['Min # of tournaments', '#6366f1'],
        ['Average # of players in tournaments', '#34d399'],
        ['Max # of players in tournaments', '#10b981'],
        ['Min # of players in tournaments', '#059669'],
    ];
    const hasNetTourney = opsRowsHaveAnyNumeric(na, netTourneyKeys.map((x) => x[0]));
    if (!hasNetTourney) {
        opsToggleEmpty('opsChartNetTourneys', 'opsEmptyNetTourneys', true, opsNetChartEmpty('Tournament / players-in-tournament columns not found on rows.'));
    } else {
        opsToggleEmpty('opsChartNetTourneys', 'opsEmptyNetTourneys', false);
        window._opsCharts.netTourneys = new Chart(document.getElementById('opsChartNetTourneys'), {
            type: 'bar',
            data: {
                labels: na.map((r) => opsNaTimeLabel(tsKey, r)),
                datasets: netTourneyKeys.map(([k, col]) => ({
                    label: k.replace('Average # of ', 'Avg ').slice(0, 42),
                    data: na.map((r) => opsNaNum(r, k)),
                    backgroundColor: col + 'B3',
                    hoverBackgroundColor: col,
                    spanGaps: true,
                })),
            },
            options: opsBarOptsGrouped,
        });
    }

    const logins = S.logins_by_hour || [];
    if (!logins.length) {
        const loginHint = M.login_time_column
            ? ('No logins in ' + hours + 'h window (column ' + M.login_time_column + ').')
            : ('login_activity_by_player: timestamp column not found — use Login Date Time or LoginDate.');
        opsToggleEmpty('opsChartLogins', 'opsEmptyLogins', true, loginHint);
    } else {
        opsToggleEmpty('opsChartLogins', 'opsEmptyLogins', false);
        window._opsCharts.logins = new Chart(document.getElementById('opsChartLogins'), {
            type: 'bar',
            data: {
                labels: logins.map((r) => opsChartAxisTime(r.t)),
                datasets: [{ label: 'Logins', data: logins.map((r) => r.v), backgroundColor: 'rgba(99,102,241,0.62)' }],
            },
            options: opsBarOpts,
        });
    }

    const feesCasino = (data.bars && data.bars.fees_by_casino) || [];
    if (!feesCasino.length) {
        opsToggleEmpty('opsChartFeesCasino', 'opsEmptyFeesCasino', true, 'No fee totals by casino (need sng_twister_and_mtt + Casino column + Fees in window).');
    } else {
        opsToggleEmpty('opsChartFeesCasino', 'opsEmptyFeesCasino', false);
        window._opsCharts.feesCasino = new Chart(document.getElementById('opsChartFeesCasino'), {
            type: 'bar',
            data: {
                labels: feesCasino.map((r) => r.label),
                datasets: [{ label: 'Fees', data: feesCasino.map((r) => r.value), backgroundColor: 'rgba(52,211,153,0.62)' }],
            },
            options: { ...opsBarOpts, indexAxis: 'y' },
        });
    }

    const mix = S.tournament_mix || [];
    if (!mix.length) {
        opsToggleEmpty('opsChartMix', 'opsEmptyMix', true, 'No tournament rows in last 7 days for mix chart.');
    } else {
        opsToggleEmpty('opsChartMix', 'opsEmptyMix', false);
        const colors = ['#6366f1', '#22d3ee', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#94a3b8', '#e2e8f0'];
        window._opsCharts.mix = new Chart(document.getElementById('opsChartMix'), {
            type: 'doughnut',
            data: {
                labels: mix.map((r) => r.label),
                datasets: [{ data: mix.map((r) => r.value), backgroundColor: colors }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'right', labels: { color: tick, boxWidth: 12 } } },
            },
        });
    }

    const fees = S.fees_by_day || [];
    if (!fees.length) {
        opsToggleEmpty('opsChartFees', 'opsEmptyFees', true, 'No fees_by_day data (sng_twister_and_mtt empty or Stats date missing).');
    } else {
        opsToggleEmpty('opsChartFees', 'opsEmptyFees', false);
        window._opsCharts.fees = new Chart(document.getElementById('opsChartFees'), {
            type: 'bar',
            data: {
                labels: fees.map((r) => opsChartAxisTime(r.t)),
                datasets: [{ label: 'Fees', data: fees.map((r) => r.v), backgroundColor: 'rgba(52,211,153,0.62)' }],
            },
            options: opsBarOpts,
        });
    }

    const buyins = S.buyins_by_day || [];
    if (!buyins.length) {
        opsToggleEmpty('opsChartBuyins', 'opsEmptyBuyins', true, 'No buy-ins by day (sng_twister_and_mtt + Buy-ins column).');
    } else {
        opsToggleEmpty('opsChartBuyins', 'opsEmptyBuyins', false);
        window._opsCharts.buyins = new Chart(document.getElementById('opsChartBuyins'), {
            type: 'bar',
            data: {
                labels: buyins.map((r) => opsChartAxisTime(r.t)),
                datasets: [{ label: 'Buy-ins', data: buyins.map((r) => r.v), backgroundColor: 'rgba(99,102,241,0.62)' }],
            },
            options: opsBarOpts,
        });
    }

    const comboFb = opsMergeFeesBuyinsByDay(S.fees_by_day, S.buyins_by_day);
    if (!comboFb.length) {
        opsToggleEmpty('opsChartFeesBuyinsCombo', 'opsEmptyFeesBuyinsCombo', true, 'No fees or buy-ins by day for the combined chart (SNG stats date).');
    } else {
        opsToggleEmpty('opsChartFeesBuyinsCombo', 'opsEmptyFeesBuyinsCombo', false);
        window._opsCharts.feesBuyinsCombo = new Chart(document.getElementById('opsChartFeesBuyinsCombo'), {
            type: 'bar',
            data: {
                labels: comboFb.map((r) => opsChartAxisTime(r.t)),
                datasets: [
                    { label: 'Fees', data: comboFb.map((r) => r.fees), backgroundColor: 'rgba(52,211,153,0.62)' },
                    { label: 'Buy-ins', data: comboFb.map((r) => r.buyins), backgroundColor: 'rgba(99,102,241,0.62)' },
                ],
            },
            options: opsBarOpts,
        });
    }

    const disc = S.disconnection_rate || [];
    if (!disc.length) {
        opsToggleEmpty('opsChartDisc', 'opsEmptyDisc', true, 'No network_disconnection_rate rows.');
    } else {
        opsToggleEmpty('opsChartDisc', 'opsEmptyDisc', false);
        window._opsCharts.disc = new Chart(document.getElementById('opsChartDisc'), {
            type: 'bar',
            data: {
                labels: disc.map((r) => opsChartAxisTime(r.t)),
                datasets: [{ label: 'Rate %', data: disc.map((r) => r.v), backgroundColor: 'rgba(251,146,60,0.62)' }],
            },
            options: opsBarOpts,
        });
    }

    const bars = (data.bars && data.bars.tournament_dc_by_cardroom) || [];
    if (!bars.length) {
        opsToggleEmpty('opsChartCardrooms', 'opsEmptyCardrooms', true, 'No tournament disconnection rows, or Cardroom/Casino column not found.');
    } else {
        opsToggleEmpty('opsChartCardrooms', 'opsEmptyCardrooms', false);
        window._opsCharts.cardrooms = new Chart(document.getElementById('opsChartCardrooms'), {
            type: 'bar',
            data: {
                labels: bars.map((r) => r.label),
                datasets: [{ label: 'Events', data: bars.map((r) => r.value), backgroundColor: 'rgba(56,189,248,0.62)' }],
            },
            options: { ...opsBarOpts, indexAxis: 'y' },
        });
    }
}

window.opsDashboardRefresh = opsDashboardRefresh;
window.opsDashboardOnShow = opsDashboardOnShow;

