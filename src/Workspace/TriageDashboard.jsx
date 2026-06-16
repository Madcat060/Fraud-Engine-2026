/**
 * TriageDashboard.jsx – Real-time triage view. WebSocket for new_case_alert;
 * Cases table: Risk Score, Player Nickname, Triggered Scenarios, Status, Assigned Agent, Investigate.
 * Fraud Rule Config is linked from the Game Integrity tab (green button) to /rules.
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { io } from 'socket.io-client';
import { playerProfileUrl } from '../Investigation/adminLinks';

const API = '';

function riskClass(score) {
  if (score >= 90) return 'risk-high';
  if (score >= 80) return 'risk-high';
  if (score >= 70) return 'risk-mid';
  return 'risk-low';
}

function isHighConfidence(score) {
  return typeof score === 'number' && score >= 90;
}

// Tooltip definitions for rules
const RULE_TOOLTIPS = {
  'Rule 1':
    'Cash margin (new account): High (Σ P/L ÷ Σ bets) × 100 from cash sessions only, within the configured signup-age window.',
  'Rule 2':
    'Major income spike: Primary_Major_income_sessions warehouse "% Win" and Win vs floors, signup age from Primary_Account_information.',
  'Rule 3':
    'Twister common games: lifetime distinct Twister tournament overlap with another player vs min shared count and min overlap % (both players must meet the floor) on Primary_SNG_Twister_and_MTT.',
  'Rule 4':
    'MTT common games: same counting as Rule 3 but Tournament type = MTT only; min overlap % applies if either player meets the floor.',
  'Rule 5':
    'SNG common games: same counting as Rule 3 but Tournament type = SNG only; min overlap % applies if either player meets the floor.',
};

/** Tag pills inside “Why” detail — dark-panel contrast (not pastel on charcoal). */
function getTagColor(tag) {
  if (!tag || !tag.trim()) {
    return {
      backgroundColor: 'rgba(51, 65, 85, 0.45)',
      color: '#cbd5e1',
      border: '1px solid rgba(148, 163, 184, 0.35)',
    };
  }
  const t = tag.toLowerCase();
  if (t.includes('cash')) {
    return {
      backgroundColor: 'rgba(30, 58, 138, 0.5)',
      color: '#bfdbfe',
      border: '1px solid rgba(96, 165, 250, 0.4)',
    };
  }
  if (t.includes('mtt') || t.includes('tournament')) {
    return {
      backgroundColor: 'rgba(120, 80, 20, 0.45)',
      color: '#fde68a',
      border: '1px solid rgba(251, 191, 36, 0.35)',
    };
  }
  if (t.includes('global')) {
    return {
      backgroundColor: 'rgba(55, 48, 120, 0.5)',
      color: '#ddd6fe',
      border: '1px solid rgba(167, 139, 250, 0.35)',
    };
  }
  if (t.includes('major')) {
    return {
      backgroundColor: 'rgba(91, 33, 182, 0.45)',
      color: '#e9d5ff',
      border: '1px solid rgba(167, 139, 250, 0.35)',
    };
  }
  if (t.includes('twister common') || t.includes('mtt common') || t.includes('sng common')) {
    return {
      backgroundColor: 'rgba(30, 58, 95, 0.5)',
      color: '#bfdbfe',
      border: '1px solid rgba(147, 197, 253, 0.4)',
    };
  }
  return {
    backgroundColor: 'rgba(51, 65, 85, 0.45)',
    color: '#e2e8f0',
    border: '1px solid rgba(148, 163, 184, 0.35)',
  };
}

const SCENARIO_LINE_RE =
  /^(Rule \d+.*?):\s*(?:Triggered (\d+) times\. Example:\s*)?(?:\[(.*?)\])?\s*(?:\((.*?)\))?:\s*(.*)$/;

/** Turn legacy key=value fragments into short readable sentences for expanded "Why". */
function humanizeScenarioFragment(raw) {
  if (raw == null || typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (!s.includes('=') || s.length < 6) return s;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 && !parts[0].includes('=')) return s;
  const sentences = [];
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) {
      sentences.push(p);
      continue;
    }
    const key = p.slice(0, eq).trim().replace(/_/g, ' ');
    const val = p.slice(eq + 1).trim();
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    sentences.push(`${cap}: ${val}`);
  }
  return sentences.join('. ') + (sentences.length ? '.' : '');
}

function parseScenarioItems(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((scenario, index) => {
      const match = scenario.match(SCENARIO_LINE_RE);
      const ruleNumM = scenario.match(/^Rule (\d+)/);
      const overlapBracket = scenario.match(/Common tournament overlap \[(\d+)\]/i);
      const ruleNum = ruleNumM ? ruleNumM[1] : overlapBracket ? overlapBracket[1] : null;
      const tooltipKey = ruleNum ? `Rule ${ruleNum}` : null;
      const ruleTooltip = tooltipKey && RULE_TOOLTIPS[tooltipKey] ? RULE_TOOLTIPS[tooltipKey] : '';
      const triggerCount = match ? match[2] : null;
      let chip = ruleNum ? `R${ruleNum}` : `#${index + 1}`;
      if (triggerCount) chip = `${chip}×${triggerCount}`;
      const title = [ruleTooltip && `Rule ${ruleNum}: ${ruleTooltip}`, scenario.length > 160 ? `${scenario.slice(0, 157)}…` : scenario]
        .filter(Boolean)
        .join('\n\n');
      return { scenario, match, ruleNum, chip, title: title || scenario };
    });
}

/** Compact chips in the row; full narrative in a scrollable panel when expanded. */
function TriggeredScenariosCell({ text }) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => parseScenarioItems(text), [text]);
  if (!items.length) return '—';

  return (
    <div className="triage-scenarios-compact">
      <div className="triage-scenarios-chips">
        {items.map((it, i) => (
          <span key={i} className="triage-scenario-chip" title={it.title}>
            {it.chip}
          </span>
        ))}
        <button
          type="button"
          className="triage-scenarios-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? 'Hide detail' : `Why (${items.length})`}
        </button>
      </div>
      {open && (
        <ul className="triage-scenarios-detail-list">
          {items.map((it, index) => {
            const { scenario, match } = it;
            if (!match) {
              return (
                <li key={index} className="triage-scenarios-detail-item triage-scenarios-detail-fallback">
                  {humanizeScenarioFragment(scenario)}
                </li>
              );
            }
            const [, rulePrefix, triggerCount, tag, ruleName, description] = match;
            const tagStyles = tag ? getTagColor(tag) : getTagColor('');
            const descDisplay =
              description && description.includes('=') ? humanizeScenarioFragment(description) : description;
            return (
              <li key={index} className="triage-scenarios-detail-item">
                <div className="triage-scenarios-detail-head">
                  <span className="triage-scenarios-detail-rule">{rulePrefix}</span>
                  {triggerCount && (
                    <span className="triage-scenarios-detail-count">{triggerCount}×</span>
                  )}
                  {tag && (
                    <span className="triage-scenarios-detail-tag" style={tagStyles}>
                      {tag}
                    </span>
                  )}
                  {ruleName && <span className="triage-scenarios-detail-name">({ruleName})</span>}
                </div>
                {descDisplay && <div className="triage-scenarios-detail-desc">{descDisplay}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Must match backend ``MASTER_CATEGORIES`` + "All". Legacy rows with unknown categories bucket to General.
const CASE_TABS = ['All', 'Chip Dumping', 'New Account High Win', 'Common Games', 'General'];

const ACTIVE_CASE_STATUSES = ['Open', 'Investigating'];

/** Tab badges: unclaimed queue size = Open only (per product request). */
function isOpenCase(c) {
  return ((c && c.status) || 'Open') === 'Open';
}

/** Status filter dropdown values (table scope). */
const STATUS_SCOPE = {
  active_queue: 'active_queue',
  open: 'open',
  investigating: 'investigating',
  closed_cleared: 'closed_cleared',
  closed_banned: 'closed_banned',
  all: 'all',
};

function normalizeStatus(s) {
  return (s || 'Open').trim();
}

function caseMatchesStatusScope(c, scope) {
  const st = normalizeStatus(c?.status);
  switch (scope) {
    case STATUS_SCOPE.active_queue:
      return ACTIVE_CASE_STATUSES.includes(st);
    case STATUS_SCOPE.open:
      return st === 'Open';
    case STATUS_SCOPE.investigating:
      return st === 'Investigating';
    case STATUS_SCOPE.closed_cleared:
      return st === 'Closed - Cleared';
    case STATUS_SCOPE.closed_banned:
      return st === 'Closed - Banned';
    case STATUS_SCOPE.all:
      return true;
    default:
      return ACTIVE_CASE_STATUSES.includes(st);
  }
}

/** CSS modifier for status badge in triage table. */
function triageStatusModifier(status) {
  const s = normalizeStatus(status);
  if (s === 'Open') return 'open';
  if (s === 'Investigating') return 'investigating';
  if (s === 'Closed - Cleared') return 'closed-cleared';
  if (s === 'Closed - Banned') return 'closed-banned';
  return 'other';
}

/** Tab buckets for case rows (excludes "All"). */
const TRIAGE_CATEGORY_VALUES = ['Chip Dumping', 'New Account High Win', 'Common Games', 'General'];

/**
 * Map investigation queue rows to Chip Dumping (Rule 1) / New Account High Win (Rule 2) from
 * engine reason text when the DB still has legacy categories (e.g. Collusion Suspect).
 * Order matches engine ``_CATEGORY_TAB_PRIORITY``: Rule 1 wins when both appear.
 */
function deriveTriageCategoryFromCase(c) {
  const text = `${c.triggered_scenarios || ''}\n${c.reason || ''}`;
  if (!text.trim()) return null;
  const hasR1 = /Rule\s*1\s*\[Cash\]/i.test(text);
  const hasR2 = /Rule\s*2\s*\[Major\]/i.test(text);
  const hasCommon =
    /Rule\s*3\s*\[Twister Common\]/i.test(text) ||
    /Rule\s*4\s*\[MTT Common\]/i.test(text) ||
    /Rule\s*5\s*\[SNG Common\]/i.test(text);
  if (hasR1) return 'Chip Dumping';
  if (hasR2) return 'New Account High Win';
  if (hasCommon) return 'Common Games';
  if (/\bRule\s+1\b/i.test(text)) return 'Chip Dumping';
  if (/\bRule\s+2\b/i.test(text)) return 'New Account High Win';
  if (/\bRule\s+[345]\b/i.test(text) && /Common/i.test(text)) return 'Common Games';
  return null;
}

function normalizeCaseCategory(c) {
  const raw = c && typeof c.category === 'string' ? c.category.trim() : '';
  if (raw === 'Chip Dumping' || raw === 'New Account High Win' || raw === 'Common Games') {
    return raw;
  }
  const derived = deriveTriageCategoryFromCase(c);
  if (derived) return derived;
  if (raw === 'General' || !raw) return 'General';
  if (CASE_TABS.includes(raw) && raw !== 'All') return raw;
  return 'General';
}

function caseRefFor(c) {
  if (!c) return '';
  if (c.case_ref) return c.case_ref;
  if (c.id != null) return `#${c.id}`;
  return '';
}

/** Count for a tab: Open status only; exact category match, or General bucket for unknown categories. */
function getTabCount(cases, tabName) {
  if (tabName === 'All') {
    return (cases || []).filter((c) => isOpenCase(c)).length;
  }
  return (cases || []).filter((c) => {
    if (!isOpenCase(c)) return false;
    const cat = c.category || 'General';
    return cat === tabName || (!CASE_TABS.includes(cat) && tabName === 'General');
  }).length;
}

/** Search across nickname, player code, case ref / id, status, triggered scenarios / reason text. */
function caseMatchesSearch(c, qRaw) {
  const q = (qRaw || '').trim().toLowerCase();
  if (!q) return true;
  const ref = caseRefFor(c).toLowerCase();
  const idStr = c.id != null ? String(c.id) : '';
  const scenarios = String(c.triggered_scenarios || c.reason || '').toLowerCase();
  return (
    (c.player_nickname || '').toLowerCase().includes(q) ||
    (c.player_code || '').toLowerCase().includes(q) ||
    ref.includes(q) ||
    (q.startsWith('#') ? ref.includes(q) : idStr.includes(q)) ||
    (c.status || '').toLowerCase().includes(q) ||
    scenarios.includes(q)
  );
}

/** Effective category for pills (after normalizeAndSortCases, category is always a tab bucket). */
function effectiveCategory(c) {
  const cat = c.category || 'General';
  return TRIAGE_CATEGORY_VALUES.includes(cat) ? cat : 'General';
}

/** Maps engine/UI category to CSS modifier + tooltip (risk column pill under score). */
const CATEGORY_PILL_MODIFIER = {
  'Chip Dumping': 'chip',
  'New Account High Win': 'majorwin',
  'Common Games': 'common',
  'General': 'general',
};

const CATEGORY_PILL_TITLE = {
  'Chip Dumping': 'Rule 1 — Cash margin / new-account cash play (Primary_Cash_table_session_summary)',
  'New Account High Win':
    'Rule 2 — Major-income warehouse % Win spike (Primary_Major_income_sessions + account signup age)',
  'Common Games': 'Rules 3–5 — Common tournament overlap (Twister / MTT / SNG)',
  'General': 'General: legacy or uncategorised bucket',
};

/** Under-score pill for Common Games: Twister Common vs MTT Common vs SNG Common from reason text. */
function commonGamesPillFromReason(caseItem) {
  const text = `${caseItem.triggered_scenarios || ''}\n${caseItem.reason || ''}`;
  if (/Rule\s*3\s*\[Twister Common\]/i.test(text)) {
    return {
      label: 'Twister Common',
      mod: 'commontwister',
      title: 'Rule 3 — Twister lifetime tournament overlap (Primary_SNG_Twister_and_MTT)',
    };
  }
  if (/Rule\s*4\s*\[MTT Common\]/i.test(text)) {
    return {
      label: 'MTT Common',
      mod: 'commonmtt',
      title: 'Rule 4 — MTT lifetime tournament overlap (Primary_SNG_Twister_and_MTT)',
    };
  }
  if (/Rule\s*5\s*\[SNG Common\]/i.test(text)) {
    return {
      label: 'SNG Common',
      mod: 'commonsng',
      title: 'Rule 5 — SNG lifetime tournament overlap (Primary_SNG_Twister_and_MTT)',
    };
  }
  return {
    label: 'Common Games',
    mod: 'common',
    title: CATEGORY_PILL_TITLE['Common Games'],
  };
}

function categoryPillForCase(caseItem) {
  const cat = effectiveCategory(caseItem);
  if (cat === 'Common Games') {
    const { label, mod, title } = commonGamesPillFromReason(caseItem);
    return {
      label,
      className: `triage-category-pill triage-category-pill--${mod}`,
      title,
    };
  }
  const mod = CATEGORY_PILL_MODIFIER[cat] || 'general';
  return {
    label: cat,
    className: `triage-category-pill triage-category-pill--${mod}`,
    title: CATEGORY_PILL_TITLE[cat] || `Category: ${cat}`,
  };
}

function sortCasesByRisk(arr) {
  arr.sort((a, b) => {
    const sa = Number(a.risk_score) || 0;
    const sb = Number(b.risk_score) || 0;
    if (isHighConfidence(sa) && !isHighConfidence(sb)) return -1;
    if (!isHighConfidence(sa) && isHighConfidence(sb)) return 1;
    return sb - sa;
  });
  return arr;
}

/** Normalize categories from API payload, then sort by risk (high-confidence first). */
function normalizeAndSortCases(list) {
  const arr = Array.isArray(list) ? list : [];
  const normalized = arr.map((c) => ({ ...c, category: normalizeCaseCategory(c) }));
  return sortCasesByRisk(normalized);
}

function normalizeCasesResponse(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.cases)) return json.cases;
  return [];
}

/** Strictly greater than threshold (per triage column filter). Empty threshold = no filter. */
function casePassesColumnMins(c, mins) {
  if (!mins) return true;
  const rs = Number(c.risk_score);
  if (mins.riskScore !== '' && String(mins.riskScore).trim() !== '') {
    const t = Number(mins.riskScore);
    if (Number.isFinite(t) && Number.isFinite(rs) && !(rs > t)) return false;
  }
  const roi = c.roi != null && c.roi !== '' ? Number(c.roi) : NaN;
  if (mins.globalRoi !== '' && String(mins.globalRoi).trim() !== '') {
    const t = Number(mins.globalRoi);
    if (Number.isFinite(t) && Number.isFinite(roi) && !(roi > t)) return false;
  }
  const cw = c.win_rate_cash != null && c.win_rate_cash !== '' ? Number(c.win_rate_cash) : NaN;
  if (mins.cashWinPct !== '' && String(mins.cashWinPct).trim() !== '') {
    const t = Number(mins.cashWinPct);
    if (Number.isFinite(t) && Number.isFinite(cw) && !(cw > t)) return false;
  }
  const th = Number(c.total_hands ?? 0);
  if (mins.totalHands !== '' && String(mins.totalHands).trim() !== '') {
    const t = Number(mins.totalHands);
    if (Number.isFinite(t) && !(th > t)) return false;
  }
  const twp =
    c.twister_win_pct != null && c.twister_win_pct !== ''
      ? Number(c.twister_win_pct)
      : c.network_data?.twister_win_pct != null
        ? Number(c.network_data.twister_win_pct)
        : NaN;
  if (mins.twisterWinPct !== '' && String(mins.twisterWinPct).trim() !== '') {
    const t = Number(mins.twisterWinPct);
    if (Number.isFinite(t) && Number.isFinite(twp) && !(twp > t)) return false;
  }
  const tplayed = Number(c.twisters_played ?? c.network_data?.twisters_played ?? 0);
  if (mins.twisterPlayed !== '' && String(mins.twisterPlayed).trim() !== '') {
    const t = Number(mins.twisterPlayed);
    if (Number.isFinite(t) && !(tplayed > t)) return false;
  }
  return true;
}

function extractRuleIdsFromCase(c) {
  const text = `${c.triggered_scenarios || ''}\n${c.reason || ''}`;
  const ids = new Set();
  let m;
  const reR = /\bR(\d+)\b/gi;
  while ((m = reR.exec(text))) ids.add(Number(m[1]));
  const reRule = /Rule\s+(\d+)/gi;
  while ((m = reRule.exec(text))) ids.add(Number(m[1]));
  return ids;
}

/** Count how many visible cases mention each rule id (at most once per case per rule). */
function countRuleMix(cases) {
  const map = {};
  for (const c of cases || []) {
    for (const id of extractRuleIdsFromCase(c)) {
      if (!Number.isFinite(id)) continue;
      map[id] = (map[id] || 0) + 1;
    }
  }
  return Object.entries(map)
    .map(([k, v]) => ({ id: Number(k), count: v }))
    .sort((a, b) => a.id - b.id);
}

export default function TriageDashboard({ onInvestigate }) {
  const [cases, setCases] = useState([]);
  const [activeCategory, setActiveCategory] = useState(CASE_TABS[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusScope, setStatusScope] = useState(STATUS_SCOPE.active_queue);
  const [columnMins, setColumnMins] = useState({
    riskScore: '',
    globalRoi: '',
    cashWinPct: '',
    totalHands: '',
    twisterPlayed: '',
    twisterWinPct: '',
  });
  const [showRuleMix, setShowRuleMix] = useState(false);

  const filteredCases = useMemo(() => {
    const all = cases || [];
    const q = searchQuery.trim();
    const pool = q
      ? all.filter((c) => caseMatchesSearch(c, q) && caseMatchesStatusScope(c, statusScope))
      : all.filter((c) => caseMatchesStatusScope(c, statusScope));
    let out =
      activeCategory === 'All' ? pool : pool.filter((c) => effectiveCategory(c) === activeCategory);
    out = out.filter((c) => casePassesColumnMins(c, columnMins));
    return out;
  }, [cases, activeCategory, searchQuery, statusScope, columnMins]);

  const ruleMixCounts = useMemo(() => countRuleMix(filteredCases), [filteredCases]);

  const [flash, setFlash] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanDays, setScanDays] = useState(90);
  const [continuousScanActive, setContinuousScanActive] = useState(false);
  const socketRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const scanDaysRef = useRef(scanDays);
  useEffect(() => {
    scanDaysRef.current = scanDays;
  }, [scanDays]);

  /** Ref-backed runner so the 15-minute interval always uses current scan days and is not a stale closure. */
  const runCollusionScan = useCallback(() => {
    setIsScanning(true);
    const days = parseInt(String(scanDaysRef.current), 10) || 90;
    fetch(API + '/api/collusion/scan/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.status === 'running') {
          setIsScanning(false);
          return;
        }
        setTimeout(() => setIsScanning(false), 60000);
      })
      .catch(() => setIsScanning(false));
  }, []);

  const runCollusionScanRef = useRef(runCollusionScan);
  useEffect(() => {
    runCollusionScanRef.current = runCollusionScan;
  }, [runCollusionScan]);

  const toggleContinuousScan = () => {
    if (continuousScanActive) {
      if (scanIntervalRef.current != null) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
      setContinuousScanActive(false);
      setIsScanning(false);
      return;
    }
    setContinuousScanActive(true);
    runCollusionScanRef.current();
    scanIntervalRef.current = window.setInterval(() => {
      runCollusionScanRef.current();
    }, 15 * 60 * 1000);
  };

  useEffect(() => {
    return () => {
      if (scanIntervalRef.current != null) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    fetch(API + '/api/collusion/cases')
      .then((r) => r.json())
      .then((json) => setCases(normalizeAndSortCases(normalizeCasesResponse(json))))
      .catch(() => setCases([]));
  }, []);

  // Poll case list every 60s so the table stays current when background scans finish (Socket.IO still drives instant alerts).
  useEffect(() => {
    const id = setInterval(() => {
      fetch(API + '/api/collusion/cases')
        .then((r) => r.json())
        .then((json) => setCases(normalizeAndSortCases(normalizeCasesResponse(json))))
        .catch(() => {});
    }, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // In dev mode (Vite on 5173), connect to backend on 5001. In production (served from Flask), use same host.
    const isDev = window.location.port === '5173';
    const socketUrl = isDev ? 'http://localhost:5001' : window.location.origin;
    
    // Only create connection if one doesn't exist or is disconnected
    if (!socketRef.current || !socketRef.current.connected) {
      // Polling only: Werkzeug (Flask dev server) does not support WebSocket upgrades; websocket
      // attempts cause "Invalid frame header" in the browser console.
      socketRef.current = io(socketUrl, {
        path: '/socket.io',
        transports: ['polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        timeout: 20000,
      });
      
      socketRef.current.on('connect', () => {
        console.log('[Socket.IO] Connected to server');
      });
      
      socketRef.current.on('disconnect', (reason) => {
        console.log('[Socket.IO] Disconnected:', reason);
      });
      
      socketRef.current.on('connect_error', (error) => {
        console.error('[Socket.IO] Connection error:', error);
      });
      
      socketRef.current.on('reconnect', (attemptNumber) => {
        console.log('[Socket.IO] Reconnected after', attemptNumber, 'attempts');
      });
      
      socketRef.current.on('reconnect_attempt', (attemptNumber) => {
        console.log('[Socket.IO] Reconnection attempt', attemptNumber);
      });
      
      socketRef.current.on('reconnect_failed', () => {
        console.error('[Socket.IO] Reconnection failed');
      });
    }
    
    socketRef.current.on('new_case_alert', (payload) => {
      console.log('[Socket.IO] Received new_case_alert', payload ? 'with payload' : 'empty');
      setIsScanning(false);
      if (payload && payload.cases && Array.isArray(payload.cases)) {
        setCases(normalizeAndSortCases(payload.cases));
      } else if (payload && (payload.id != null || payload.player_code != null || payload.player_nickname != null)) {
        setCases((prev) => {
          const single = { ...payload, category: normalizeCaseCategory(payload) };
          return sortCasesByRisk([single, ...prev]);
        });
      }
      setFlash(true);
      setTimeout(() => setFlash(false), 3000);
    });
    socketRef.current.on('scan_error', (data) => {
      console.error('[Socket.IO] Backend reported a crash:', data?.error);
      alert('The background scan crashed: ' + (data?.error || 'Unknown error'));
      setIsScanning(false);
      setContinuousScanActive(false);
      if (scanIntervalRef.current != null) {
        clearInterval(scanIntervalRef.current);
        scanIntervalRef.current = null;
      }
    });
    
    // Cleanup function
    return () => {
      if (socketRef.current) {
        console.log('[Socket.IO] Cleaning up connection');
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []); // Empty dependency array ensures this only runs once on mount

  return (
    <div className="triage-dashboard">
      <div className="triage-table-wrap card-panel triage-card-tight">
      <div className="triage-cases-toolbar">
        <h3 className="triage-subtitle triage-subtitle-tight triage-cases-title">Cases</h3>
        <div className="triage-toolbar-right">
          <div className="triage-status-scope-inline">
            <label htmlFor="triageStatusScope">Show</label>
            <select
              id="triageStatusScope"
              className="input-control triage-status-scope-select"
              value={statusScope}
              onChange={(e) => setStatusScope(e.target.value)}
            >
              <option value={STATUS_SCOPE.active_queue}>Active queue (Open + Investigating)</option>
              <option value={STATUS_SCOPE.open}>Open only (unclaimed)</option>
              <option value={STATUS_SCOPE.investigating}>Investigating (claimed)</option>
              <option value={STATUS_SCOPE.closed_cleared}>Closed – Cleared</option>
              <option value={STATUS_SCOPE.closed_banned}>Closed – Banned</option>
              <option value={STATUS_SCOPE.all}>All statuses</option>
            </select>
          </div>
          <div className="triage-case-search-inline">
            <label htmlFor="triageCaseSearch">Search cases</label>
            <div className="triage-case-search-row">
              <input
                id="triageCaseSearch"
                type="search"
                placeholder="Nickname, player code, #case id, status…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-control triage-case-search-input"
                autoComplete="off"
              />
              <label className="triage-rule-mix-toggle" title="Count rules across the visible table (respects search, category, status, and column mins)">
                <input
                  type="checkbox"
                  checked={showRuleMix}
                  onChange={(e) => setShowRuleMix(e.target.checked)}
                />
                <span>Rule mix</span>
              </label>
            </div>
          </div>
          <div className="triage-manual-scan-inline">
            <label htmlFor="scanDays">Scan (days)</label>
            <input
              id="scanDays"
              type="number"
              min="1"
              max="365"
              value={scanDays}
              onChange={(e) => setScanDays(e.target.value)}
              className="input-control triage-scan-days-input"
            />
            <button
              type="button"
              className={continuousScanActive ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'}
              onClick={toggleContinuousScan}
              disabled={isScanning && !continuousScanActive}
            >
              {continuousScanActive ? 'Stop continuous scan' : isScanning ? 'Scanning…' : 'Run scan'}
            </button>
          </div>
        </div>
      </div>
      {showRuleMix && ruleMixCounts.length > 0 && (
        <div className="triage-rule-mix-bar" role="status" aria-label="Rule counts in visible cases">
          {ruleMixCounts.map(({ id, count }) => (
            <span key={id} className="triage-rule-mix-chip">
              R{id}
              <span className="triage-rule-mix-chip__n">{count}</span>
            </span>
          ))}
        </div>
      )}
      {searchQuery.trim() ? (
        <p className="triage-search-hint">
          Search matches nickname, player code, case id, status, and <strong>triggered scenarios</strong> (e.g. R1). The <strong>Show</strong> filter still applies.
        </p>
      ) : null}
      <p className="triage-tab-count-hint">
        Tab counts = <strong>Open</strong> cases only (per category). <strong>Chip Dumping</strong> = Rule 1 (cash margin);{' '}
        <strong>New Account High Win</strong> = Rule 2 (major-income % Win); <strong>Common Games</strong> = Rules 3–5
        (Twister / MTT / SNG tournament overlap). The pill under the score shows Twister Common, MTT Common, or SNG Common.
        Older rows with legacy categories appear under <strong>General</strong>.
      </p>
      {/* Category Tabs — badge counts are Open-only; unknown DB category counts under General */}
      <div className="triage-tabs triage-tabs-tight triage-tabs--darkrow">
        {CASE_TABS.map((tab) => {
          const count = getTabCount(cases, tab);
          const isActive = activeCategory === tab;
          return (
            <button
              key={tab}
              type="button"
              className={`triage-cat-tab${isActive ? ' triage-cat-tab--active' : ''}`}
              onClick={() => setActiveCategory(tab)}
            >
              {tab}
              <span
                className={`triage-cat-count triage-cat-count--${count <= 0 ? 'zero' : count < 100 ? 'mid' : 'high'}${isActive ? ' triage-cat-count--on' : ''}`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
      {flash && (
        <div className="triage-alert-flash triage-flash-on">
          New case received
        </div>
      )}
      <div className="gi-table-wrap">
        <table className="gi-players-table triage-table">
          <thead>
            <tr>
              <th>Risk score</th>
              <th>Case ID</th>
              <th>Player code</th>
              <th>Nickname</th>
              <th>Net profit</th>
              <th>Lifetime rake</th>
              <th>Lifetime fee</th>
              <th title="Row count: Primary_SNG_Twister_and_MTT where Tournament type = Twister (includes rows without a tournament code).">
                Twister played
              </th>
              <th className="triage-th-metric-hint">
                <abbr title="Per Twister row: profit = Total win − Buy-ins − Fees − Jackpot fees (same economic P/L as warehouse &quot;profit&quot;). Win % = 100 × (rows with profit &gt; 0) ÷ (all Twister rows). Negative profit counts as a loss.">
                  Twister win %
                </abbr>
              </th>
              <th>Cash win %</th>
              <th className="triage-th-metric-hint">
                <abbr
                  title="Cash margin % — (Σ Total profit/loss ÷ Σ Total bets) × 100 from Primary_Cash_table_session_summary. Stored on the case as roi."
                >
                  Cash margin %
                </abbr>
              </th>
              <th>Total hands</th>
              <th>Triggered scenarios</th>
              <th>Status</th>
              <th>Assigned agent</th>
              <th>Actions</th>
            </tr>
            <tr className="triage-col-filter-row">
              <th title="Show rows with risk score strictly greater than this value">
                <input
                  type="number"
                  className="triage-col-filter-input"
                  placeholder="Min"
                  aria-label="Risk score greater than"
                  value={columnMins.riskScore}
                  onChange={(e) => setColumnMins((m) => ({ ...m, riskScore: e.target.value }))}
                />
              </th>
              <th colSpan={4} />
              <th colSpan={2} />
              <th title="Show rows with Twister count strictly greater than this value">
                <input
                  type="number"
                  step={1}
                  min={0}
                  className="triage-col-filter-input"
                  placeholder="Min"
                  aria-label="Twister tournaments played greater than"
                  value={columnMins.twisterPlayed}
                  onChange={(e) => setColumnMins((m) => ({ ...m, twisterPlayed: e.target.value }))}
                />
              </th>
              <th title="Show rows with Twister win % strictly greater than this value">
                <input
                  type="number"
                  step="any"
                  className="triage-col-filter-input"
                  placeholder="Min"
                  aria-label="Twister win percent greater than"
                  value={columnMins.twisterWinPct}
                  onChange={(e) => setColumnMins((m) => ({ ...m, twisterWinPct: e.target.value }))}
                />
              </th>
              <th title="Show rows with cash win % strictly greater than this value">
                <input
                  type="number"
                  step="any"
                  className="triage-col-filter-input"
                  placeholder="Min"
                  aria-label="Cash win percent greater than"
                  value={columnMins.cashWinPct}
                  onChange={(e) => setColumnMins((m) => ({ ...m, cashWinPct: e.target.value }))}
                />
              </th>
              <th title="Show rows with Cash Margin % strictly greater than this value">
                <input
                  type="number"
                  step="any"
                  className="triage-col-filter-input"
                  placeholder="Min"
                  aria-label="Cash margin greater than"
                  value={columnMins.globalRoi}
                  onChange={(e) => setColumnMins((m) => ({ ...m, globalRoi: e.target.value }))}
                />
              </th>
              <th title="Show rows with total hands strictly greater than this value">
                <input
                  type="number"
                  step={1}
                  min={0}
                  className="triage-col-filter-input"
                  placeholder="Min"
                  aria-label="Total hands greater than"
                  value={columnMins.totalHands}
                  onChange={(e) => setColumnMins((m) => ({ ...m, totalHands: e.target.value }))}
                />
              </th>
              <th colSpan={4} />
            </tr>
          </thead>
          <tbody>
            {filteredCases.length === 0 && (
              <tr>
                <td colSpan={16} className="triage-table-empty">
                  {searchQuery.trim()
                    ? 'No cases match your search and filters in this category.'
                    : statusScope === STATUS_SCOPE.active_queue
                      ? 'No active cases (Open + Investigating) in this category.'
                      : 'No cases match the selected status in this category.'}
                </td>
              </tr>
            )}
            {filteredCases.map((c) => {
              const categoryPill = categoryPillForCase(c);
              return (
              <tr key={c.id}>
                <td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className={`risk-badge ${riskClass(c.risk_score)}`}>{Number(c.risk_score).toFixed(1)}</span>
                      {isHighConfidence(c.risk_score) && (
                        <span title="High Confidence" style={{ color: '#d97706', fontSize: '1.2em' }}>★</span>
                      )}
                    </div>
                    <span className={categoryPill.className} title={categoryPill.title}>
                      {categoryPill.label}
                    </span>
                  </div>
                </td>
                <td className="triage-case-ref-cell">{caseRefFor(c) || '—'}</td>
                <td>
                  {c.player_code && String(c.player_code).trim() ? (
                    <a
                      className="admin-quick-link"
                      href={playerProfileUrl(String(c.player_code).trim())}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {c.player_code}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  {c.player_code && String(c.player_code).trim() ? (
                    <a
                      className="admin-quick-link"
                      href={playerProfileUrl(String(c.player_code).trim())}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {c.player_nickname || '—'}
                    </a>
                  ) : (
                    c.player_nickname || '—'
                  )}
                </td>
                <td style={{ color: (c.network_data?.total_profit_loss ?? c.net_profit ?? 0) < 0 ? '#dc2626' : '#16a34a', fontWeight: 'bold' }}>{Number(c.network_data?.total_profit_loss ?? c.net_profit ?? 0).toFixed(2)}</td>
                <td>{Number(c.lifetime_rake ?? 0).toFixed(2)}</td>
                <td title="From Primary_Account_information.&quot;Lifetime Fee&quot; (per scan)">
                  {Number(c.account_lifetime_fee ?? c.network_data?.account_lifetime_fee ?? 0).toFixed(2)}
                </td>
                <td>{Number(c.twisters_played ?? c.network_data?.twisters_played ?? 0).toLocaleString()}</td>
                <td style={{ fontWeight: 'bold' }}>
                  {(() => {
                    const played = Number(c.twisters_played ?? c.network_data?.twisters_played ?? 0);
                    if (!played) return '—';
                    const w = c.twister_win_pct ?? c.network_data?.twister_win_pct;
                    if (w == null || w === '' || !Number.isFinite(Number(w))) return '—';
                    return `${Number(w).toFixed(2)}%`;
                  })()}
                </td>
                <td style={{ fontWeight: 'bold' }}>{c.win_rate_cash != null ? Number(c.win_rate_cash).toFixed(2) + '%' : '—'}</td>
                <td
                  style={{
                    color:
                      c.roi == null || c.roi === '' || !Number.isFinite(Number(c.roi))
                        ? undefined
                        : Number(c.roi) < 0
                          ? '#dc2626'
                          : '#16a34a',
                    fontWeight: 'bold',
                  }}
                >
                  {c.roi != null && c.roi !== '' && Number.isFinite(Number(c.roi))
                    ? `${Number(c.roi).toFixed(2)}%`
                    : '—'}
                </td>
                <td>{Number(c.total_hands ?? 0).toLocaleString()}</td>
                <td className="triage-scenarios-cell triage-scenarios-td">
                  <TriggeredScenariosCell text={c.triggered_scenarios} />
                </td>
                <td>
                  <span
                    className={`triage-status-badge triage-status-badge--${triageStatusModifier(c.status)}`}
                    title={normalizeStatus(c.status)}
                  >
                    {normalizeStatus(c.status)}
                  </span>
                </td>
                <td>{c.assigned_agent || '—'}</td>
                <td>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onInvestigate && onInvestigate(c.id, c.player_code || c.player_nickname)}>
                    Investigate
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}