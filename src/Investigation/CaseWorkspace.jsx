/**
 * CaseWorkspace.jsx – Investigation modal: core/statistical info, related players, financial charts, sessions.
 * Uses GET /api/player/<player_code> global_view and case notes from the open case.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CaseAttachments from './CaseAttachments';
import FinancialChart from './FinancialChart';
import HardwareTwins from './HardwareTwins';
import InvestigatorHUD from './InvestigatorHUD';
import NetworkAndSessions from './NetworkAndSessions';
import CollusionInsightCharts, { CommonSngOverlapMiniChart } from './CollusionInsightCharts';
import { playerProfileUrl, sessionCodeSearchUrl, tournamentEditUrl } from './adminLinks';

const API = '';

const STATUS_OPTIONS = ['Open', 'Investigating', 'Closed - Cleared', 'Closed - Banned'];

function AvatarIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  );
}

function formatVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number' && !Number.isInteger(v)) return Number(v).toFixed(2);
  return String(v);
}

/**
 * Format currency value with optional currency code
 * @param {number} value - The numeric value to format
 * @param {string|null|undefined} currency - The currency code (e.g., 'USD', 'EUR', 'GBP')
 * @returns {string} Formatted string (e.g., "€150.00" or "150.00 GBP" or "1,250.50")
 */
function formatCurrency(value, currency = null) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value !== 'number') {
    const num = Number(value);
    if (isNaN(num)) return '—';
    value = num;
  }
  
  // Format number with commas and 2 decimal places
  const formatted = value.toLocaleString(undefined, { 
    minimumFractionDigits: 2, 
    maximumFractionDigits: 2 
  });
  
  // If currency is provided and not empty, append it
  if (currency && String(currency).trim() !== '') {
    const currencyUpper = String(currency).trim().toUpperCase();
    // Use currency symbol for common currencies, otherwise append code
    const currencyMap = {
      'USD': '$',
      'EUR': '€',
      'GBP': '£',
      'JPY': '¥',
      'CAD': 'C$',
      'AUD': 'A$',
    };
    const symbol = currencyMap[currencyUpper];
    if (symbol) {
      return `${symbol}${formatted}`;
    }
    return `${formatted} ${currencyUpper}`;
  }
  
  // No currency symbol, just return formatted number
  return formatted;
}

/** Overlap % from Primary_Common_SNG_player_report (nullable). */
function formatOverlapPct(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}%`;
}

/** Green if &lt;= 30%, red if &gt; 30% (overlap concentration risk). */
function overlapPctStyle(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return { color: n > 30 ? '#f87171' : '#4ade80' };
}

function formatOptionalTourneyCount(value) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/** Profit / ROI emphasis for dark tables (no light cell backgrounds). */
function sessionFinancialClass(profit, roi) {
  const p = Number(profit);
  const r = Number(roi);
  if (r > 150) return 'session-fin-chipdump';
  if (!Number.isNaN(p) && p > 0) return 'session-fin-pos';
  if (!Number.isNaN(p) && p < 0) return 'session-fin-neg';
  return '';
}

/** Format duration in seconds as "Xh Ym" */
function formatDuration(sec) {
  if (!sec) return '—';
  const s = Number(sec);
  if (isNaN(s) || s < 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

/** Get value from session record trying multiple possible column names */
function getSessionVal(row, keys) {
  if (!row || typeof row !== 'object') return '';
  const k = Array.isArray(keys) ? keys : [keys];
  for (const key of k) {
    if (key in row && row[key] !== null && row[key] !== undefined && String(row[key]).trim() !== '') return row[key];
  }
  return '';
}

/** Show 0 and other valid numbers; only null/undefined/NaN → em dash. */
function formatStatInt(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return String(Math.trunc(n));
}

function formatStatHours(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return '—';
  return n.toFixed(2);
}

const AGENT_PRESET_OPTIONS = ['Phil', 'Dmitrijs', 'Danail', 'Daniele', 'Venelin'];

function investigationStatusWrapClass(s) {
  const x = (s || 'Open').trim();
  if (x === 'Open') return 'inv-agent-status-wrap inv-agent-status-wrap--open';
  if (x === 'Investigating') return 'inv-agent-status-wrap inv-agent-status-wrap--investigating';
  if (x === 'Closed - Cleared') return 'inv-agent-status-wrap inv-agent-status-wrap--closed-cleared';
  if (x === 'Closed - Banned') return 'inv-agent-status-wrap inv-agent-status-wrap--closed-banned';
  return 'inv-agent-status-wrap';
}

/** Split ISO-like datetime into { dateStr, timeStr } for session tables. */
function splitDateTime(val) {
  if (!val || val === '—') return { dateStr: '—', timeStr: '—' };
  try {
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) {
      const s = String(val);
      const t = s.includes('T') ? s.replace('T', ' ') : s;
      const parts = t.trim().split(/\s+/);
      return { dateStr: parts[0] || '—', timeStr: parts[1]?.slice(0, 8) || '—' };
    }
    const pad = (n) => String(n).padStart(2, '0');
    return {
      dateStr: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  } catch {
    return { dateStr: '—', timeStr: '—' };
  }
}

/** Left-rail navigation: smooth-scroll to section anchors in the player workspace. */
const INVESTIGATION_NAV_GROUPS = [
  { label: 'Desk', items: [{ id: 'inv-agent', label: 'Agent center' }] },
  {
    label: 'Player',
    items: [
      { id: 'inv-profile360', label: '360° snapshot' },
      { id: 'inv-core', label: 'Core identity' },
      { id: 'inv-lifetime', label: 'Lifetime stats' },
    ],
  },
  {
    label: 'Signals',
    items: [
      { id: 'inv-hud', label: 'Behavioral stats' },
      { id: 'inv-network', label: 'Sessions & major income' },
      { id: 'inv-twins', label: 'Hardware twins' },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { id: 'inv-charts', label: 'Charts' },
      { id: 'inv-related', label: 'Related accounts' },
      { id: 'inv-sessions', label: 'Recent sessions' },
      { id: 'inv-live-report', label: 'Live EFOP' },
    ],
  },
];

function scrollToInvSection(id) {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Embedded screenshots in notes: paste inserts a data URL; we render images inline. */
const NOTE_DATA_IMG_RE = /(data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+)/gi;

const MAX_NOTE_LENGTH = 480000;

/** Strip note HTML to text nodes, <br>, and <img src="data:image/..."> only (no scripts / remote URLs). */
function sanitizeAgentNoteHtml(html) {
  if (typeof document === 'undefined' || !html || !String(html).trim()) return '';
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const out = document.createElement('div');
    const walk = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          out.appendChild(document.createTextNode(node.textContent));
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const t = node.tagName.toLowerCase();
          if (t === 'img') {
            const src = node.getAttribute('src') || '';
            if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(src)) {
              const img = document.createElement('img');
              img.setAttribute('src', src);
              img.setAttribute('alt', '');
              img.className = 'agent-note-inline-img';
              out.appendChild(img);
            }
          } else if (t === 'br') {
            out.appendChild(document.createElement('br'));
          } else {
            walk(node);
          }
        }
      }
    };
    walk(doc.body);
    return out.innerHTML;
  } catch {
    return '';
  }
}

function insertImageAtCaret(editable, dataUrl) {
  if (!editable || !dataUrl.startsWith('data:image/')) return;
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = '';
  img.className = 'agent-note-composer-img';
  const sel = window.getSelection();
  if (sel?.rangeCount) {
    const range = sel.getRangeAt(0);
    if (!editable.contains(range.commonAncestorContainer)) {
      editable.appendChild(img);
      editable.appendChild(document.createElement('br'));
      return;
    }
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    editable.appendChild(img);
    editable.appendChild(document.createElement('br'));
  }
}

function AgentNoteContent({ text }) {
  if (text == null || text === '') return null;
  const s = String(text);
  if (/<img/i.test(s) || /^<[\w!]/i.test(s.trim())) {
    const clean = sanitizeAgentNoteHtml(s);
    if (!clean) return null;
    return <div className="agent-note-html-body" dangerouslySetInnerHTML={{ __html: clean }} />;
  }
  const parts = s.split(NOTE_DATA_IMG_RE);
  return (
    <span className="agent-note-content-root">
      {parts.map((part, i) => {
        if (/^data:image\//i.test(part)) {
          return <img key={i} src={part} alt="" className="agent-note-inline-img" loading="lazy" />;
        }
        return (
          <span key={i} className="agent-note-text-chunk">
            {part}
          </span>
        );
      })}
    </span>
  );
}

export default function CaseWorkspace({ caseId, playerCode, onClose }) {
  const [caseData, setCaseData] = useState(null);
  const [globalView, setGlobalView] = useState(null);
  const [status, setStatus] = useState('Open');
  const [assignedAgent, setAssignedAgent] = useState('');
  const [decisionSummary, setDecisionSummary] = useState('');
  const noteComposerRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [liveReportData, setLiveReportData] = useState(null);
  const [isFetchingReport, setIsFetchingReport] = useState(false);
  const [selectedReportId, setSelectedReportId] = useState('13750'); // Default EFOP
  const [error, setError] = useState(null);
  const [isLoadingCase, setIsLoadingCase] = useState(false);
  const [isLoadingPlayer, setIsLoadingPlayer] = useState(false);
  const [agentCenterExpanded, setAgentCenterExpanded] = useState(false);
  /** Related players: default show only hardware+IP (Both); other modes for broader link review. */
  const [relatedMatchFilter, setRelatedMatchFilter] = useState('both');
  const caseDataRef = useRef(null);

  useEffect(() => {
    caseDataRef.current = caseData;
  }, [caseData]);

  useEffect(() => {
    if (!caseId) return;
    setIsLoadingCase(true);
    setError(null);
    try {
      fetch(API + '/api/collusion/cases/' + caseId)
        .then((r) => {
          if (!r.ok) {
            throw new Error(`HTTP ${r.status}: ${r.statusText}`);
          }
          return r.json();
        })
        .then((data) => {
          setCaseData(data || null);
          setStatus(data?.status || 'Open');
          setAssignedAgent(data?.assigned_agent || '');
          setDecisionSummary(data?.decision_summary || '');
          setIsLoadingCase(false);
        })
        .catch((err) => {
          console.error('Error fetching case data:', err);
          setError(err.message || 'Failed to load case data');
          setIsLoadingCase(false);
        });
    } catch (err) {
      console.error('Error in case fetch:', err);
      setError(err.message || 'Failed to load case data');
      setIsLoadingCase(false);
    }
  }, [caseId]);

  useEffect(() => {
    if (!playerCode) return;
    setIsLoadingPlayer(true);
    setError(null);
    try {
      const caseCreated = caseData?.created_at;
      const qs =
        caseCreated != null && String(caseCreated).trim() !== ''
          ? `?case_created_at=${encodeURIComponent(String(caseCreated))}`
          : '';
      fetch(API + '/api/player/' + encodeURIComponent(playerCode) + qs)
        .then((r) => {
          if (!r.ok) {
            throw new Error(`HTTP ${r.status}: ${r.statusText}`);
          }
          return r.json();
        })
        .then((data) => {
          if (data?.error && !data?.global_view) {
            throw new Error(data.message || data.error || 'Player not found');
          }
          setGlobalView(data?.global_view ?? data ?? {});
          setIsLoadingPlayer(false);
        })
        .catch((err) => {
          console.error('Error fetching player profile:', err);
          setError(err.message || 'Failed to load player data');
          setGlobalView(null);
          setIsLoadingPlayer(false);
        });
    } catch (err) {
      console.error('Error in player fetch:', err);
      setError(err.message || 'Failed to load player data');
      setIsLoadingPlayer(false);
    }
  }, [playerCode, caseData?.created_at]);

  // Charts use `global_view.timelineData` + `cumulative_performance` from GET /api/player (same data as /chart-data).
  // Skipping a second request avoids duplicate DB aggregation and speeds Investigation load.

  const persistCaseFields = useCallback(async () => {
    if (!caseId) throw new Error('No case id');
    const res = await fetch(API + '/api/collusion/cases/' + caseId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, assigned_agent: assignedAgent, decision_summary: decisionSummary }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText);
    }
    setCaseData((prev) => ({ ...prev, ...data, notes: prev?.notes || data.notes || [] }));
  }, [caseId, status, assignedAgent, decisionSummary]);

  useEffect(() => {
    if (!caseId || !caseData) return;
    const cd = caseDataRef.current;
    if (!cd) return;
    const same =
      status === (cd.status || 'Open') &&
      assignedAgent === (cd.assigned_agent || '') &&
      (decisionSummary || '') === (cd.decision_summary || '');
    if (same) return;
    const t = setTimeout(() => {
      setSaving(true);
      persistCaseFields()
        .catch((e) => console.error('Auto-save failed:', e))
        .finally(() => setSaving(false));
    }, 500);
    return () => clearTimeout(t);
  }, [status, assignedAgent, decisionSummary, caseId, caseData, persistCaseFields]);

  const saveCase = async () => {
    setSaving(true);
    try {
      await persistCaseFields();
    } catch (e) {
      alert('Failed to save case: ' + (e.message || String(e)));
    } finally {
      setSaving(false);
    }
  };

  const handleComposerPaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.indexOf('image') === 0) {
        e.preventDefault();
        const blob = items[i].getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = String(ev.target?.result || '');
          if (!dataUrl.startsWith('data:image/')) return;
          insertImageAtCaret(noteComposerRef.current, dataUrl);
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  }, []);

  const isNoteComposerEmpty = useCallback(() => {
    const el = noteComposerRef.current;
    if (!el) return true;
    const txt = (el.innerText || '').replace(/\u200b/g, '').trim();
    const hasImg = !!(el.querySelector && el.querySelector('img'));
    return !txt && !hasImg;
  }, []);

  const addNote = async () => {
    const el = noteComposerRef.current;
    if (!el || isNoteComposerEmpty()) return;
    const raw = el.innerHTML || '';
    const content = sanitizeAgentNoteHtml(raw);
    const textOnly = content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!textOnly && !content.includes('<img')) return;
    if (content.length > MAX_NOTE_LENGTH) {
      alert(
        `Note is too large (${content.length} characters). Max is about ${MAX_NOTE_LENGTH} — use Evidence & attachments for large files, or shorten the image.`
      );
      return;
    }
    try {
      const res = await fetch(API + '/api/collusion/cases/' + caseId + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, agent: assignedAgent }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert('Failed to add note: ' + (data.error || res.statusText));
        return;
      }
      setCaseData((prev) => ({ ...prev, notes: [...(prev?.notes || []), data] }));
      el.innerHTML = '';
    } catch (e) {
      console.error(e);
      alert('Network error while adding note.');
    }
  };

  const fetchLiveReport = async () => {
    if (!playerCode) return;
    setIsFetchingReport(true);
    setLiveReportData(null);
    try {
      const res = await fetch(`${API}/api/player/${encodeURIComponent(playerCode)}/live-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_id: selectedReportId,
          report_version: '3.0',
          outputs: 'Player2Username,Player2Nickname,PlayerCode2,Player2Cardroom,SessionCode,StartDate,EndDate,Player2Frozen,NoOfCommonHands,EarningsFromOpponent,CurrencyCode'
        })
      });
      const json = await res.json();
      if (json.status === 'success') {
        setLiveReportData(json.data);
      } else {
        alert('Failed to fetch report: ' + json.message);
      }
    } catch (e) {
      alert('Network error while fetching report.');
    } finally {
      setIsFetchingReport(false);
    }
  };

  /** Must run every render (before any early return) — hooks order must stay fixed. */
  const investigationNavGroups = useMemo(() => {
    const groups = INVESTIGATION_NAV_GROUPS.map((g) => ({
      ...g,
      items: [...g.items],
    }));
    if (caseData?.suspicious_sessions?.length) {
      const sig = groups.find((x) => x.label === 'Signals');
      if (sig) {
        sig.items = [{ id: 'inv-suspicious', label: 'Suspicious sessions' }, ...sig.items];
      }
    }
    return groups;
  }, [caseData?.suspicious_sessions]);

  // Handle error state
  if (error && !globalView && !caseData) {
    return (
      <div className="case-workspace modal investigation-portal investigation-portal--loading-only">
        <div className="investigation-portal-loading-card">
          <p className="investigation-portal-loading-title">Error loading data</p>
          <p className="investigation-portal-loading-msg">{error}</p>
          <button type="button" className="btn btn-secondary btn-sm investigation-portal-loading-btn" onClick={() => { setError(null); window.location.reload(); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Handle error responses gracefully
  if (globalView && globalView.error && !globalView.global_view) {
    return (
      <div className="case-workspace modal investigation-portal investigation-portal--loading-only">
        <div className="investigation-portal-loading-card">
          <p className="investigation-portal-loading-title">Error loading player data</p>
          <p className="investigation-portal-loading-msg">{globalView?.message || globalView?.error || 'Unknown error occurred'}</p>
        </div>
      </div>
    );
  }

  // Extract data with comprehensive optional chaining and fallbacks
  const notes = Array.isArray(caseData?.notes) ? caseData.notes : [];
  const profile = globalView?.profile || {};
  const network = Array.isArray(globalView?.network) ? globalView.network : [];
  const core = globalView?.core_info || {};
  const stats = globalView?.statistical_info || {};
  const triggers = globalView?.network_triggers;
  const v2Summary = globalView?.v2_summary || {};
  const sessionHistory = Array.isArray(globalView?.session_history) ? globalView.session_history : [];
  const mttSessions = Array.isArray(globalView?.mtt_sessions) ? globalView.mtt_sessions : [];
  const spikeLog = Array.isArray(globalView?.spike_log) ? globalView.spike_log : [];
  const cumulativePerformance = Array.isArray(globalView?.cumulative_performance) ? globalView.cumulative_performance : [];

  const nd = caseData?.network_data || {};
  
  // KPI strip: live global_view (Primary_* tables) first; same sources as triage Net Profit (network_data.total_profit_loss) as fallback
  const kpiTotalProfit =
    v2Summary.total_profit ??
    core?.total_profit ??
    stats?.total_profit ??
    nd?.total_profit_loss ??
    caseData?.network_data?.total_profit_loss ??
    caseData?.total_profit_loss ??
    caseData?.net_profit;
  const kpiCashProfit = v2Summary.cash_profit ?? stats?.cash_profit ?? null;
  const kpiMttProfit = v2Summary.mtt_profit ?? stats?.mtt_profit ?? null;
  const kpiTwisterProfit = v2Summary.twister_profit ?? stats?.twister_profit ?? null;
  const kpiTwisterTotalWin = v2Summary.twister_total_win ?? stats?.twister_total_win ?? null;
  const kpiSngProfit = v2Summary.sng_profit ?? stats?.sng_profit ?? null;
  const kpiNetProfit = kpiTotalProfit;
  const kpiCashMarginPct = v2Summary.cash_roi ?? null;
  const kpiMttRoi = v2Summary.mtt_roi ?? stats?.mtt_roi ?? caseData?.mtt_roi;
  const kpiCashWinPct = stats?.cash_win_pct ?? caseData?.win_rate_cash;
  const kpiTotalHands = v2Summary.total_hands ?? stats?.total_hands ?? core?.total_hands ?? caseData?.total_hands;
  const kpiLifetimeRake = v2Summary.lifetime_rake ?? core?.total_rake_fees ?? stats?.total_rake_fees ?? caseData?.lifetime_rake;
  const kpiLifetimeFees = v2Summary.lifetime_fee ?? v2Summary.lifetime_total_fees ?? stats?.lifetime_fee ?? stats?.lifetime_total_fees ?? caseData?.lifetime_total_fees;
  const kpiTournamentsPlayed = v2Summary.total_tournaments ?? stats?.total_tournaments ?? caseData?.total_tournaments;
  const kpiTwistersPlayed = v2Summary.twisters_played ?? stats?.twister_sng_played ?? null;
  const kpiThreeBet = profile?.three_bet ?? profile?.playstyle_stats?.three_bet ?? caseData?.three_bet;
  const kpiMttWinPct = stats?.win_rate_mtt ?? v2Summary.win_rate_mtt ?? caseData?.win_rate_mtt;
  const kpiTotalTwisterBuyinRaw =
    v2Summary.total_twister_buyin ??
    stats?.total_twister_buyin ??
    nd?.total_twister_buyin ??
    caseData?.network_data?.total_twister_buyin;
  const kpiTotalTwisterBuyinFromBalance =
    kpiTwisterTotalWin != null &&
    kpiTwisterProfit != null &&
    Number.isFinite(Number(kpiTwisterTotalWin)) &&
    Number.isFinite(Number(kpiTwisterProfit))
      ? Math.max(0, Number(kpiTwisterTotalWin) - Number(kpiTwisterProfit))
      : null;
  const kpiTotalTwisterBuyin =
    kpiTotalTwisterBuyinRaw != null && kpiTotalTwisterBuyinRaw !== ''
      ? Number(kpiTotalTwisterBuyinRaw)
      : kpiTotalTwisterBuyinFromBalance;
  const kpiTotalMttBuyin = v2Summary.total_mtt_buyin ?? stats?.total_mtt_buyin ?? stats?.mtt_buyin ?? null;
  const kpiMttTotalWin = v2Summary.mtt_total_win ?? stats?.mtt_total_win ?? null;
  const kpiTwisterTournamentsWon = v2Summary.twister_tournaments_won ?? stats?.twister_tournaments_won ?? null;
  const kpiMttTournamentsWon = v2Summary.mtt_tournaments_won ?? stats?.mtt_tournaments_won ?? null;
  const kpiMttTournamentsPlayed = v2Summary.mtt_tournaments_played ?? stats?.mtt_tournaments_played ?? null;
  const kpiTwisterWinPct = v2Summary.twister_win_pct ?? stats?.twister_win_pct ?? null;

  const cashPayoutPct = stats?.cash_payout_pct ?? null;

  const netProfit = kpiNetProfit;
  const mttRoi = kpiMttRoi;
  const totalHands = kpiTotalHands;
  const lifetimeRake = kpiLifetimeRake;

  // Core Information — backend core_info strict lowercase keys: username, nickname, country, cardroom, sign_up_date, frozen, poker_player_code
  const nickname = core?.nickname ?? caseData?.player_nickname ?? playerCode ?? '—';
  const username = core?.username ?? '—';
  const country = core?.country ?? '—';
  const cardroom = core?.cardroom ?? '—';
  const signUpDate = core?.sign_up_date ?? '—';
  const frozen = core?.frozen ?? '—';
  const pokerPlayerCode = core?.poker_player_code ?? playerCode ?? '—';
  const totalRakeFees = core?.total_rake_fees ?? stats?.total_rake_fees ?? lifetimeRake ?? '—';
  const ipokerCollusion = core?.ipoker_collusion ?? v2Summary?.ipoker_collusion ?? '—';
  const vipLevel = core?.vip ?? '—';
  const vipLevelNum = Number(String(vipLevel).replace(/[^\d.-]/g, ''));
  const vipIsElevated = Number.isFinite(vipLevelNum) && vipLevelNum === 11;
  const advertiser = core?.advertiser ?? '—';
  const headerPlayerCode = core?.poker_player_code ?? playerCode;
  const headerProfileHref =
    headerPlayerCode != null && String(headerPlayerCode).trim() !== '' && String(headerPlayerCode).trim() !== '—'
      ? playerProfileUrl(String(headerPlayerCode).trim())
      : null;

  // Step 2 Lifetime Statistics (from core / statistical_info: Primary_Major_income_sessions + Primary_Cash_table_session_summary)
  const coreTotalProfit =
    v2Summary.total_profit ??
    core?.total_profit ??
    stats?.total_profit ??
    nd?.total_profit_loss ??
    caseData?.network_data?.total_profit_loss ??
    netProfit;
  const coreTotalHands = v2Summary.total_hands ?? core?.total_hands ?? stats?.total_hands ?? totalHands;
  const coreTotalRake = v2Summary.lifetime_rake ?? core?.total_rake ?? core?.total_rake_fees ?? stats?.total_rake ?? lifetimeRake;
  const coreTotalHours = stats?.total_hours ?? stats?.stat_total_duration_hours ?? core?.total_hours ?? null;
  const statDaysActive = stats?.stat_days_active ?? stats?.ls_days_active ?? nd?.ls_days_active;
  const statSessionCount = stats?.total_sessions ?? caseData?.total_sessions ?? nd?.ls_total_sessions ?? nd?.total_sessions;
  const coreHandsPerHour = (coreTotalHours != null && Number(coreTotalHours) > 0 && coreTotalHands != null)
    ? Number(coreTotalHands) / Number(coreTotalHours)
    : null;

  const isGhostAccount = (nd?.ls_total_hands === 0 || nd?.ls_total_hands == null) && (nd?.ls_total_logins === 0 || nd?.ls_total_logins == null);

  const relatedPlayers = Array.isArray(globalView?.related_players) ? globalView.related_players : [];
  const isRelatedHighRisk = relatedPlayers.length > 5;
  const filteredRelatedPlayers = (() => {
    const list = relatedPlayers;
    if (relatedMatchFilter === 'all') return list;
    const want =
      relatedMatchFilter === 'both'
        ? 'Both'
        : relatedMatchFilter === 'ip'
          ? 'IP'
          : relatedMatchFilter === 'serial'
            ? 'Serial'
            : 'Both';
    return list.filter((rp) => (rp.match_via || 'IP') === want);
  })();
  const syndicateNetwork = Array.isArray(profile?.syndicate_network) ? profile.syndicate_network : [];
  const commonSngOverlap = Array.isArray(profile?.common_sng_report_overlap)
    ? profile.common_sng_report_overlap
    : [];
  const commonSngOverlapFiltered = commonSngOverlap.filter((row) => Number(row.common_tournaments) >= 5);
  const gameplayNetwork = syndicateNetwork.length > 0
    ? syndicateNetwork.map((r) => {
        const accomplice = r?.accomplice ?? r?.related_player ?? '—';
        const accompliceCode = (r?.accomplice_player_code ?? r?.related_player_code ?? '').toString().trim() || null;
        const sharedGames = Number(r?.shared_games ?? r?.shared_mtts ?? 0) || 0;
        const totalAccompliceWin = Number(r?.total_accomplice_win ?? r?.related_winnings ?? 0) || 0;
        const targetWin = Number(r?.target_winnings ?? 0) || 0;
        const combined = Number(r?.combined_winnings ?? totalAccompliceWin + targetWin) || 0;
        return {
          related_player: accomplice,
          related_player_code: accompliceCode,
          shared_games: sharedGames,
          shared_mtts: sharedGames,
          shared_twisters: Number(r?.shared_twisters ?? 0) || 0,
          related_winnings: totalAccompliceWin,
          target_winnings: targetWin,
          combined_winnings: combined,
        };
      })
    : (Array.isArray(network) ? network : []);

  // Financial timeline: prefer API timelineData, else build from sessionHistory so charts work
  const timelineFromApi = Array.isArray(globalView?.timelineData) && globalView.timelineData.length > 0
    ? globalView.timelineData
    : [];
  const timelineFromSessions = Array.isArray(sessionHistory) && sessionHistory.length > 0
    ? (() => {
        let cum = 0;
        return [...sessionHistory]
          .sort((a, b) => {
            const da = (a?.start_date ?? a?.['Start date'] ?? '').toString();
            const db = (b?.start_date ?? b?.['Start date'] ?? '').toString();
            return da.localeCompare(db);
          })
          .map((s) => {
            const profit = Number(s?.profit ?? (s?.Win != null && s?.Buy != null ? Number(s.Win) - Number(s.Buy) : 0)) ?? 0;
            cum += profit;
            return {
              Date: (s?.start_date ?? s?.['Start date'] ?? '').toString().slice(0, 16),
              date: (s?.start_date ?? s?.['Start date'] ?? '').toString().slice(0, 16),
              Profit: cum,
              net_win: cum,
              cumulative_profit: cum,
            };
          });
      })()
    : [];
  const financialTimeline = timelineFromApi.length > 0
    ? timelineFromApi.map((d) => ({
        date: d?.date ?? d?.play_date ?? d?.Date ?? '',
        net_win: Number(d?.daily_profit ?? d?.Profit ?? d?.['Cash game net win'] ?? d?.net_win ?? 0),
        cumulative_profit: d?.cumulative_profit != null ? Number(d.cumulative_profit) : undefined,
        cumulative_rake: d?.cumulative_rake != null ? Number(d.cumulative_rake) : undefined,
        avg_stake: d?.avg_stake ?? d?.stake,
      }))
    : timelineFromSessions.map((d) => ({
        date: d?.date ?? d?.Date ?? '',
        net_win: d?.net_win ?? d?.Profit ?? 0,
        cumulative_profit: d?.cumulative_profit,
        cumulative_rake: d?.cumulative_rake,
      }));

  // Lifetime cumulative performance: prefer API cumulative_performance, else financialTimeline
  const cumulativePerformanceData = cumulativePerformance.length > 0
    ? cumulativePerformance.map((d) => ({
        date: d?.date ?? d?.Date ?? '',
        Date: d?.Date ?? d?.date ?? '',
        cumulative_profit: d?.cumulative_profit != null ? Number(d.cumulative_profit) : 0,
        cumulative_rake: d?.cumulative_rake != null ? Number(d.cumulative_rake) : undefined,
      }))
    : financialTimeline;

  // Chip-dumping-style flag: final cumulative_profit < 0 and downward slope > 45° (drop >= range)
  const chipDumpingFlag = (() => {
    const arr = cumulativePerformanceData.filter((d) => d?.cumulative_profit != null);
    if (arr.length < 2) return false;
    const first = Number(arr[0].cumulative_profit) || 0;
    const last = Number(arr[arr.length - 1].cumulative_profit) || 0;
    if (last >= 0) return false;
    const values = arr.map((d) => Number(d.cumulative_profit) || 0);
    const minP = Math.min(...values);
    const maxP = Math.max(...values);
    const range = maxP - minP;
    if (range <= 0) return false;
    const drop = first - last;
    return drop >= range;
  })();

  // Stake jump heuristic: any two consecutive points with stake ratio > 10x
  const stakeValues = timelineFromApi.map((d) => Number(d?.avg_stake ?? d?.stake ?? 0));
  const hasStakeJump = stakeValues.length >= 2 && stakeValues.some((s, i) => {
    const next = stakeValues[i + 1];
    if (next == null) return false;
    const lo = Math.min(s, next);
    const hi = Math.max(s, next);
    return lo > 0 && hi / lo > 10;
  });

  const isTriggersArray = Array.isArray(triggers);
  const triggerRowsFromTriggers = isTriggersArray
    ? (triggers || []).flatMap((t) => {
        const out = [];
        if (t['Tournament ID'] && t['Tournament ID'] !== '—') out.push({ type: 'Tournament', id: t['Tournament ID'] });
        if (t['Session ID'] && t['Session ID'] !== '—') out.push({ type: 'Session', id: t['Session ID'] });
        return out;
      })
    : [
        ...(triggers?.tournament_codes || []).map((id) => ({ type: 'Tournament', id })),
        ...(triggers?.session_codes || []).map((id) => ({ type: 'Session', id })),
      ];
  // Network table rows: use full network array so we can show Tournament ID and Session ID
  const triggerRowsFromNetwork = (network || []).map((r) => ({
    nicknames_involved: r?.nicknames_involved ?? '—',
    tournament_code: r?.tournament_code ?? '—',
    session_code: r?.session_code ?? '—',
    shared_ips: r?.shared_ips ?? '—',
    total_win: r?.total_win ?? '—',
  }));
  const triggerRowsFromSessions =
    !triggerRowsFromTriggers.length &&
    (!network || !network.length) &&
    Array.isArray(sessionHistory) &&
    sessionHistory.length > 0
      ? sessionHistory.slice(0, 10).map((s) => ({
          nicknames_involved: core?.nickname ?? nickname ?? '—',
          tournament_code: getSessionVal(s, ['Tournament ID', 'tournament_id']),
          session_code: getSessionVal(s, ['Session code', 'Session Code', 'session_code', 'session id', 'Session ID']),
          shared_ips: '—',
          total_win: getSessionVal(s, ['Win', 'Total Win', 'win_amount', 'profit']),
        }))
      : [];
  const triggerRows = triggerRowsFromTriggers.length
    ? triggerRowsFromTriggers
    : (triggerRowsFromNetwork.length ? triggerRowsFromNetwork : triggerRowsFromSessions);
  const networkTableUsesTriggers = triggerRowsFromTriggers.length > 0;

  if (!caseId && !playerCode) {
    return (
      <div className="case-workspace modal investigation-portal investigation-portal--loading-only">
        <div className="investigation-portal-loading-card">
          <p className="investigation-portal-loading-msg">No case data selected.</p>
        </div>
      </div>
    );
  }

  if (caseId && isLoadingCase) {
    return (
      <div className="case-workspace modal investigation-portal investigation-portal--loading-only">
        <div className="investigation-portal-loading-card investigation-portal-loading-card--busy">
          <div className="investigation-portal-loading-spinner" aria-hidden="true" />
          <p className="investigation-portal-loading-msg">Loading case…</p>
        </div>
      </div>
    );
  }

  if (caseId && caseData == null && !isLoadingCase) {
    return (
      <div className="case-workspace modal investigation-portal investigation-portal--loading-only">
        <div className="investigation-portal-loading-card">
          <p className="investigation-portal-loading-title">Case not found</p>
          <p className="investigation-portal-loading-msg">Failed to load case data.</p>
          {error && <p className="investigation-portal-loading-err">{error}</p>}
        </div>
      </div>
    );
  }

  // Show loading state if playerCode is set but globalView is still loading
  if (playerCode && isLoadingPlayer) {
    return (
      <div className="case-workspace modal investigation-portal investigation-portal--loading-only">
        <div className="investigation-portal-loading-card investigation-portal-loading-card--busy">
          <div className="investigation-portal-loading-spinner" aria-hidden="true" />
          <p className="investigation-portal-loading-msg">Loading player data…</p>
        </div>
      </div>
    );
  }

  const kpiAsideCards = (
    <>
      <div className="kpi-card kpi-card-compact kpi-line-accent kpi-line-accent--cyan">
                  <span className="kpi-label">Total Net Profit</span>
        <span className={`kpi-value ${Number(kpiNetProfit ?? 0) >= 0 ? 'positive' : 'negative'}`}>
          {kpiNetProfit != null ? Number(kpiNetProfit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                  </span>
                </div>
      <div className="kpi-card kpi-card-compact kpi-line-accent kpi-line-accent--violet">
        <span
          className="kpi-label kpi-label-hint"
          title="Cash margin % — (Σ Total profit/loss ÷ Σ Total bets) × 100 from Primary_Cash_table_session_summary only. Same definition as Fraud Rule 1."
        >
          Cash Margin %
        </span>
        <span
          className={`kpi-value${kpiCashMarginPct == null ? '' : Number(kpiCashMarginPct) >= 0 ? ' positive' : ' negative'}`}
        >
          {kpiCashMarginPct != null ? `${Number(kpiCashMarginPct).toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className="kpi-card kpi-card-compact">
        <span className="kpi-label">MTT ROI</span>
        <span className={`kpi-value ${Number(kpiMttRoi ?? 0) >= 0 ? 'positive' : 'negative'}`}>
          {kpiMttRoi != null ? `${Number(kpiMttRoi).toFixed(2)}%` : '—'}
        </span>
      </div>
      <div className="kpi-card kpi-card-compact">
        <span className="kpi-label">Cash Payout %</span>
        <span className={`kpi-value${cashPayoutPct != null && cashPayoutPct < 50 ? ' kpi-value-warn' : ''}`}>
                    {cashPayoutPct != null ? `${Number(cashPayoutPct).toFixed(2)}%` : '—'}
                  </span>
                </div>
      <div className="kpi-card kpi-card-compact">
                  <span className="kpi-label">Cash Win %</span>
        <span className={`kpi-value ${Number(kpiCashWinPct ?? 0) >= 0 ? 'positive' : 'negative'}`}>
          {kpiCashWinPct != null ? `${Number(kpiCashWinPct).toFixed(2)}%` : '—'}
                  </span>
                </div>
      <div className="kpi-card kpi-card-compact">
                  <span className="kpi-label">MTT Win %</span>
        <span className={`kpi-value ${Number(kpiMttWinPct ?? 0) >= 0 ? 'positive' : 'negative'}`}>
          {kpiMttWinPct != null ? `${Number(kpiMttWinPct).toFixed(2)}%` : '—'}
                  </span>
                </div>
      <div className="kpi-card kpi-card-compact">
                  <span className="kpi-label">Total Hands</span>
        <span className="kpi-value">{kpiTotalHands != null ? Number(kpiTotalHands).toLocaleString() : '—'}</span>
                </div>
      <div className="kpi-card kpi-card-compact kpi-line-accent kpi-line-accent--violet">
        <span className="kpi-label kpi-label-hint" title="Primary_Account_information.Lifetime Rake">
          Lifetime Rake
        </span>
        <span className="kpi-value">{kpiLifetimeRake != null ? formatCurrency(Number(kpiLifetimeRake)) : '—'}</span>
      </div>
      <div className="kpi-card kpi-card-compact">
        <span className="kpi-label kpi-label-hint" title="Primary_Account_information.Lifetime Fee">
          Lifetime Fee
        </span>
        <span className="kpi-value">{kpiLifetimeFees != null ? formatCurrency(Number(kpiLifetimeFees)) : '—'}</span>
      </div>
    </>
  );

  return (
    <div className="case-workspace modal player-page-shell investigation-portal">
      <div className="investigation-portal__layout">
        <aside className="investigation-portal__sidebar" aria-label="Investigation navigation">
          <div className="investigation-portal__brand">
            <span className="investigation-portal__brand-mark" aria-hidden="true" />
            <div>
              <div className="investigation-portal__brand-title">Investigation</div>
              <div className="investigation-portal__brand-sub">Fraud engine</div>
                  </div>
          </div>
          <nav className="investigation-portal__nav">
            {investigationNavGroups.map((g) => (
              <div key={g.label} className="investigation-portal__nav-group">
                <div className="investigation-portal__nav-group-label">{g.label}</div>
                {g.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="investigation-portal__nav-btn"
                    onClick={() => scrollToInvSection(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="investigation-portal__sidebar-glance">
            <div className="investigation-portal__glance-label">Quick glance</div>
            <div className="investigation-portal__glance-row">
              <span>Net profit</span>
              <strong className={Number(kpiNetProfit ?? 0) >= 0 ? 'investigation-portal__glance-pos' : 'investigation-portal__glance-neg'}>
                {kpiNetProfit != null ? Number(kpiNetProfit).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
              </strong>
            </div>
            <div className="investigation-portal__glance-row">
              <span>Hands</span>
              <strong>{kpiTotalHands != null ? Number(kpiTotalHands).toLocaleString() : '—'}</strong>
            </div>
            <div className="investigation-portal__glance-row">
              <span>3-Bet</span>
              <strong>{kpiThreeBet != null ? `${Number(kpiThreeBet).toFixed(1)}%` : '—'}</strong>
            </div>
          </div>
        </aside>
        <div className="investigation-portal__main">
          <header className="investigation-portal__topbar case-workspace-header player-page-header-bar">
            <div className="investigation-portal__topbar-inner">
              <div className="investigation-portal__identity">
                <div className="investigation-portal__avatar-ring" aria-hidden="true">
                  <AvatarIcon />
                </div>
                <div className="player-page-header-titles">
                  <h3 className="player-page-title investigation-portal__page-title">Player Page</h3>
                  <p className="player-page-nickname investigation-portal__hero-nick">
                    {headerProfileHref ? (
                      <a className="admin-quick-link" href={headerProfileHref} target="_blank" rel="noopener noreferrer">
                        {nickname || playerCode || '—'}
                      </a>
                    ) : (
                      nickname || playerCode || '—'
                    )}
                  </p>
                  {(caseData?.case_ref || caseId != null) && (
                    <p className="investigation-portal__case-ref" aria-label="Case reference">
                      Case {caseData?.case_ref || `#${caseId}`}
                    </p>
                  )}
                </div>
              </div>
              <button type="button" className="modal-close investigation-portal__close" onClick={onClose} aria-label="Close">
                &times;
              </button>
            </div>
          </header>
          <div className="investigation-portal__scroll">
            <div className="case-workspace-body player-page-body-inner investigation-portal__body-pad">
              <div className="player-page-columns investigation-portal__columns">
                <main className="player-page-main">
            <section id="inv-agent" className="global-view-card player-agent-panel agent-action-center gv-panel-tight inv-anchor">
              <button
                type="button"
                className="agent-action-center__toggle"
                onClick={() => setAgentCenterExpanded((v) => !v)}
                aria-expanded={agentCenterExpanded}
              >
                <span className="agent-action-center__toggle-lead" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
                  </svg>
                </span>
                <span className="agent-action-center__toggle-text">
                  <span className="agent-action-center__title">Agent Action Center</span>
                  <span className="agent-action-center__subtitle">Case controls, notes &amp; evidence</span>
                </span>
                <span className="agent-action-center__chevron" aria-hidden="true">
                  {agentCenterExpanded ? '▼' : '▶'}
                </span>
              </button>
              {!agentCenterExpanded && (
                <p className="section-hint agent-action-center__collapsed-hint">
                  Expand for live reports, assignment, status, notes (including pasted screenshots), and file uploads.
                </p>
              )}
              {agentCenterExpanded ? (
                <>
                  {(caseData?.case_ref || caseId != null) && (
                    <div className="agent-action-center__case-pill">
                      <span className="agent-action-center__case-pill-label">Case</span>
                      <strong>{caseData?.case_ref || `#${caseId}`}</strong>
                    </div>
                  )}
                  <div className="agent-action-center__section">
                    <div className="agent-action-center__section-label">Assignment &amp; outcome</div>
                    <div className="player-agent-panel-grid">
                      <div className="case-form-group player-agent-field">
                        <label>Live Playtech report</label>
                        <div className="player-agent-report-row">
                          <select
                            className="select-control"
                            value={selectedReportId}
                            onChange={(e) => setSelectedReportId(e.target.value)}
                          >
                            <option value="13750">EFOP (Earnings From Opponent)</option>
                          </select>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={fetchLiveReport}
                            disabled={isFetchingReport}
                          >
                            {isFetchingReport ? 'Pulling…' : 'Fetch 7-Day'}
                          </button>
                        </div>
                      </div>
                      <div className="case-form-group player-agent-field">
                        <label>Agent</label>
                        <select
                          className="select-control"
                          value={assignedAgent || ''}
                          onChange={(e) => setAssignedAgent(e.target.value)}
                        >
                          <option value="">— Select —</option>
                          {AGENT_PRESET_OPTIONS.map((a) => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                          {assignedAgent && !AGENT_PRESET_OPTIONS.includes(assignedAgent) ? (
                            <option value={assignedAgent}>{assignedAgent}</option>
                          ) : null}
                        </select>
                      </div>
                      <div className={`case-form-group player-agent-field ${investigationStatusWrapClass(status)}`}>
                        <label>Status</label>
                        <select className="select-control inv-agent-status-select" value={status || 'Open'} onChange={(e) => setStatus(e.target.value)}>
                          {(STATUS_OPTIONS || []).map((o) => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      </div>
                      <div className="case-form-group player-agent-field player-agent-span-2">
                        <label>Decision summary (when closing)</label>
                        <textarea
                          className="input-control"
                          rows={2}
                          placeholder="Short closure summary for audit trail"
                          value={decisionSummary}
                          onChange={(e) => setDecisionSummary(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="player-agent-actions">
                      <button type="button" className="btn btn-primary agent-action-center__save-btn" onClick={saveCase} disabled={saving || !caseId}>
                        {saving ? 'Saving…' : 'Save case'}
                      </button>
                      <span className="section-hint player-agent-autosave-hint">Status, agent, and decision summary also save automatically shortly after you stop typing.</span>
                    </div>
                  </div>
                  <div className="agent-action-center__section player-agent-notes-block">
                    <div className="agent-action-center__section-label">Investigator notes</div>
                    <p className="agent-action-center__paste-hint">Type here and paste screenshots with <kbd>Ctrl</kbd>+<kbd>V</kbd> — pictures show inline before you save.</p>
                    <div className="case-notes-timeline player-notes-timeline agent-action-center__notes-scroll">
                      {(notes || []).length === 0 && <p className="section-hint">No notes yet.</p>}
                      {(notes || []).map((n) => (
                        <div key={n.id} className="case-note-item agent-action-center__note-card">
                          <div className="agent-action-center__note-meta">
                            <span className="case-note-time">{(n.created_at || '').slice(0, 19).replace('T', ' ')}</span>
                            {n.agent ? <span className="case-note-agent">{n.agent}</span> : null}
                          </div>
                          <div className="agent-action-center__note-body">
                            <AgentNoteContent text={n.content} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="case-form-group agent-action-center__add-note">
                      <label htmlFor="agent-note-composer">Add note</label>
                      <div
                        id="agent-note-composer"
                        ref={noteComposerRef}
                        className="input-control agent-action-center__note-composer"
                        contentEditable
                        role="textbox"
                        aria-multiline="true"
                        aria-label="Investigator note — type or paste images"
                        data-placeholder="Findings, rationale, or paste a screenshot (Ctrl+V)…"
                        onPaste={handleComposerPaste}
                        suppressContentEditableWarning
                      />
                      <div className="agent-action-center__add-note-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={addNote} disabled={!caseId}>
                          Add note
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="agent-action-center__section player-agent-attachments">
                    <div className="agent-action-center__section-label">Evidence &amp; attachments</div>
                    <CaseAttachments caseId={caseId} />
                  </div>
                </>
              ) : null}
            </section>

            {/* ——— 360° Player Profile ——— */}
            <div id="inv-profile360" className="global-view-card gv-panel-tight player-profile-card inv-anchor">
              <h5 className="player-panel-heading">360° Player Profile</h5>
              <div className="player-profile-three-col investigation-player-profile player-profile-two-col-wide">
                <div className="player-profile-pillar player-profile-pillar--financial">
                  <div className="player-profile-pillar__head">
                    <span className="player-profile-pillar__icon" aria-hidden="true">💰</span>
                    <h6 className="player-profile-pillar__title">Financials</h6>
                  </div>
                  <div className="player-profile-pillar__rows">
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="Same as triage Net Profit: cash Σ Total profit/loss + tournament Σ (Total win − Buy-ins − Fees − Jackpot fees) across Primary_SNG_Twister_and_MTT (all types)"
                      >
                        Total profit
                      </span>
                      <span className={`player-profile-pillar__val ${Number(kpiNetProfit ?? 0) >= 0 ? 'player-profile-pillar__val--pos' : 'player-profile-pillar__val--neg'}`}>
                        {kpiNetProfit != null ? formatCurrency(Number(kpiNetProfit)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span className="player-profile-pillar__label">Cash profit</span>
                      <span className={`player-profile-pillar__val ${Number(kpiCashProfit ?? 0) >= 0 ? 'player-profile-pillar__val--pos' : 'player-profile-pillar__val--neg'}`}>
                        {kpiCashProfit != null ? formatCurrency(Number(kpiCashProfit)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="Tournament type = MTT only"
                      >
                        MTT profit
                      </span>
                      <span className={`player-profile-pillar__val ${Number(kpiMttProfit ?? 0) >= 0 ? 'player-profile-pillar__val--pos' : 'player-profile-pillar__val--neg'}`}>
                        {kpiMttProfit != null ? formatCurrency(Number(kpiMttProfit)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="Σ (Buy-ins + Fees + Jackpot fees) where Tournament type = MTT"
                      >
                        Total MTT buy-in
                      </span>
                      <span className="player-profile-pillar__val">
                        {kpiTotalMttBuyin != null ? formatCurrency(Number(kpiTotalMttBuyin)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="Tournament type = Twister only"
                      >
                        Twister profit
                      </span>
                      <span className={`player-profile-pillar__val ${Number(kpiTwisterProfit ?? 0) >= 0 ? 'player-profile-pillar__val--pos' : 'player-profile-pillar__val--neg'}`}>
                        {kpiTwisterProfit != null ? formatCurrency(Number(kpiTwisterProfit)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="Σ (Buy-ins + Fees + Jackpot fees) where Tournament type = Twister"
                      >
                        Total Twister buy-in
                      </span>
                      <span className="player-profile-pillar__val">
                        {kpiTotalTwisterBuyin != null ? formatCurrency(Number(kpiTotalTwisterBuyin)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="SNG and any other tournament net after MTT and Twister (Σ tournament net − MTT − Twister)"
                      >
                        SNG &amp; other profit
                      </span>
                      <span className={`player-profile-pillar__val ${Number(kpiSngProfit ?? 0) >= 0 ? 'player-profile-pillar__val--pos' : 'player-profile-pillar__val--neg'}`}>
                        {kpiSngProfit != null ? formatCurrency(Number(kpiSngProfit)) : '—'}
                      </span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span className="player-profile-pillar__label">Lifetime rake</span>
                      <span className="player-profile-pillar__val">{kpiLifetimeRake != null ? formatCurrency(Number(kpiLifetimeRake)) : '—'}</span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span className="player-profile-pillar__label">Lifetime fee</span>
                      <span className="player-profile-pillar__val">{kpiLifetimeFees != null ? formatCurrency(Number(kpiLifetimeFees)) : '—'}</span>
                    </div>
                  </div>
                </div>

                <div className="player-profile-pillar player-profile-pillar--volume">
                  <div className="player-profile-pillar__head">
                    <span className="player-profile-pillar__icon" aria-hidden="true">📊</span>
                    <h6 className="player-profile-pillar__title">Volume &amp; win frequencies</h6>
                  </div>
                  <div className="player-profile-pillar__rows">
                    <div className="player-profile-pillar__row">
                      <span className="player-profile-pillar__label">Cash hands played</span>
                      <span className="player-profile-pillar__val">{kpiTotalHands != null ? Number(kpiTotalHands).toLocaleString() : '—'}</span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="COUNT(DISTINCT Tournament code) where Tournament type is MTT or SNG"
                      >
                        Tournaments played (MTT + SNG)
                      </span>
                      <span className="player-profile-pillar__val">{kpiTournamentsPlayed != null ? Number(kpiTournamentsPlayed).toLocaleString() : '—'}</span>
                    </div>
                    <div className="player-profile-pillar__row">
                      <span
                        className="player-profile-pillar__label player-profile-pillar__label--help"
                        title="COUNT(DISTINCT Tournament code) where Tournament type = Twister"
                      >
                        Twisters played
                      </span>
                      <span className="player-profile-pillar__val">{kpiTwistersPlayed != null ? Number(kpiTwistersPlayed).toLocaleString() : '—'}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ——— Suspicious sessions forensics (case payload) ——— */}
            {caseData?.suspicious_sessions && caseData.suspicious_sessions.length > 0 && (
              <div id="inv-suspicious" className="global-view-card inv-anchor inv-suspicious-card">
                <h5 className="inv-suspicious-card__title">
                  Suspicious sessions forensics
                </h5>
                <div className="gi-table-wrap inv-suspicious-table-wrap">
                  <table className="gi-players-table inv-suspicious-table">
                    <thead>
                      <tr>
                        <th>Session Code</th>
                        <th>Date</th>
                        <th>Table Name</th>
                        <th>IP Address</th>
                        <th style={{ textAlign: 'right' }}>Hands</th>
                        <th style={{ textAlign: 'right' }}>Invested</th>
                        <th style={{ textAlign: 'right' }}>Profit</th>
                        <th style={{ textAlign: 'right' }}>Session ROI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {caseData.suspicious_sessions.map((session, index) => {
                        const invested = Number(session.invested ?? 0);
                        const profit = Number(session.profit ?? 0);
                        const roi = Number(session.roi ?? 0);
                        const finCls = sessionFinancialClass(profit, roi);
                        const formatDate = (dateStr) => {
                          if (!dateStr) return '—';
                          try {
                            const d = new Date(dateStr);
                            if (isNaN(d.getTime())) return String(dateStr).slice(0, 16);
                            return d.toLocaleString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                          } catch (e) {
                            return String(dateStr).slice(0, 16);
                          }
                        };
                        const sc = session.session_code;
                        const scHref = sc != null && String(sc).trim() ? sessionCodeSearchUrl(String(sc).trim()) : null;
                        return (
                          <tr key={index} className="inv-suspicious-table__row">
                            <td>
                              <span className="inv-suspicious-table__mono">
                                {scHref ? (
                                  <a className="admin-quick-link" href={scHref} target="_blank" rel="noopener noreferrer">{String(sc)}</a>
                                ) : (
                                  session.session_code || '—'
                                )}
                              </span>
                            </td>
                            <td>{formatDate(session.date)}</td>
                            <td>{session.table ?? '—'}</td>
                            <td className="inv-suspicious-table__mono">{session.ip ?? '—'}</td>
                            <td style={{ textAlign: 'right' }}>{Number(session.hands ?? 0).toLocaleString()}</td>
                            <td style={{ textAlign: 'right' }}>${invested.toFixed(2)}</td>
                            <td className={`num ${finCls}`.trim()}>${profit.toFixed(2)}</td>
                            <td className={`num ${finCls}`.trim()}>{roi.toFixed(2)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="inv-suspicious-card__foot">
                  <p className="inv-suspicious-card__foot-text">
                    ⚠️ <strong>{caseData.suspicious_sessions.length}</strong> suspicious session(s) detected with high ROI and low hand counts, indicating potential chip dumping activity.
                  </p>
                </div>
              </div>
            )}

            <div className="player-page-core-lifetime-grid">
            <div id="inv-core" className="global-view-card core-info-card gv-panel-tight player-page-core-card inv-anchor">
              <h5 className="player-panel-heading">Core Information</h5>
              <div className="core-info-header player-page-core-header">
                <div className="core-info-avatar" aria-hidden="true">
                  <AvatarIcon />
                </div>
                <div className="player-page-core-cols">
                  <div className="core-info-block" style={{ borderRight: '1px solid #e2e8f0', paddingRight: '16px' }}>
                    <h6 style={{ margin: '0 0 10px 0', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#64748b' }}>Identity</h6>
                    <div className="core-info-fields" style={{ display: 'grid', gridAutoRows: 'minmax(1.25em, auto)', gap: '2px' }}>
                      <div className="core-info-row">
                        <span className="core-info-label">Nickname</span>
                        <span className="core-info-value">
                          {(() => {
                            const nick = core?.nickname ?? nickname ?? '—';
                            const pc = core?.poker_player_code ?? playerCode;
                            const href = pc != null && String(pc).trim() && String(pc).trim() !== '—' ? playerProfileUrl(String(pc).trim()) : null;
                            return href ? (
                              <a className="admin-quick-link" href={href} target="_blank" rel="noopener noreferrer">{formatVal(nick)}</a>
                            ) : (
                              formatVal(nick)
                            );
                          })()}
                        </span>
                      </div>
                      <div className="core-info-row">
                        <span className="core-info-label">Player Code</span>
                        <span className="core-info-value" style={{ fontFamily: 'monospace', letterSpacing: '0.5px' }}>
                          {(() => {
                            const pc = core?.poker_player_code ?? pokerPlayerCode ?? '—';
                            const href = pc != null && String(pc).trim() && String(pc).trim() !== '—' ? playerProfileUrl(String(pc).trim()) : null;
                            return href ? (
                              <a className="admin-quick-link" href={href} target="_blank" rel="noopener noreferrer">{formatVal(pc)}</a>
                            ) : (
                              formatVal(pc)
                            );
                          })()}
                        </span>
                      </div>
                      <div className="core-info-row"><span className="core-info-label">Username</span><span className="core-info-value" style={{ fontFamily: 'monospace', letterSpacing: '0.5px' }}>{formatVal(core?.username ?? '—')}</span></div>
                      <div className="core-info-row"><span className="core-info-label">Country</span><span className="core-info-value">{formatVal(core?.country ?? '—')}</span></div>
                      <div className="core-info-row"><span className="core-info-label">Sign Up Date</span><span className="core-info-value">{formatVal(core?.sign_up_date ?? '—')}</span></div>
                      <div className="core-info-row"><span className="core-info-label">Signup IP</span><span className="core-info-value" style={{ fontFamily: 'monospace', fontSize: '11px' }}>{formatVal(core?.signup_ip ?? '—')}</span></div>
                      <div className="core-info-row"><span className="core-info-label">Signup serial</span><span className="core-info-value" style={{ fontFamily: 'monospace', fontSize: '11px' }}>{formatVal(core?.signup_serial ?? '—')}</span></div>
                    </div>
                  </div>
                  <div className="core-info-block">
                    <h6 style={{ margin: '0 0 10px 0', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#64748b' }}>Account Status</h6>
                    <div className="core-info-fields" style={{ display: 'grid', gridAutoRows: 'minmax(1.25em, auto)', gap: '2px' }}>
                      <div className="core-info-row"><span className="core-info-label">Cardroom</span><span className="core-info-value">{formatVal(core?.cardroom ?? '—')}</span></div>
                      <div className="core-info-row">
                        <span className="core-info-label">VIP Level</span>
                        <span className={`core-info-value${vipIsElevated ? ' core-info-vip--warn' : ''}`}>{formatVal(vipLevel ?? '—')}</span>
                      </div>
                      <div className="core-info-row"><span className="core-info-label">Frozen Status</span><span className="core-info-value">{formatVal(core?.frozen ?? '—')}</span></div>
                      <div className="core-info-row"><span className="core-info-label">iPoker Collusion</span><span className="core-info-value">{formatVal(ipokerCollusion ?? '—')}</span></div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="comments-section">
                <h6>Comments / Collusion Comments</h6>
                {core?.comments && <p className="comments-text">{core.comments}</p>}
                {core?.collusion_comments && <p className="comments-text">{core.collusion_comments}</p>}
                {notes.length === 0 && !core?.comments && !core?.collusion_comments ? (
                  <p className="section-hint">No notes yet.</p>
                ) : (
                  <ul className="case-notes-list">
                    {Array.isArray(notes) && notes.map((n) => (
                      <li key={n?.id || Math.random()} className="case-note-item">
                        <span className="case-note-time">{(n?.created_at || '').slice(0, 19)}</span>
                        {n?.agent && <span className="case-note-agent">{n.agent}: </span>}
                        <AgentNoteContent text={n?.content || ''} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div id="inv-lifetime" className="global-view-card statistical-info-card gv-panel-tight player-page-lifetime-card inv-anchor">
              <h5 className="player-panel-heading">Lifetime Statistics</h5>
              {(nd.ls_days_active != null || stats?.stat_days_active != null || stats?.ls_days_active != null || stats?.total_logins != null || stats?.unique_ips != null || stats?.unique_serials != null || kpiTotalHands != null || caseData?.total_sessions != null || kpiNetProfit != null || kpiLifetimeRake != null || core?.total_profit != null || core?.total_hands != null || core?.total_rake != null || core?.total_hours != null || kpiTwistersPlayed != null || kpiMttTournamentsPlayed != null) ? (
                <div className="inv-lifetime-bands">
                  <div className="inv-lifetime-band inv-lifetime-band--activity">
                    <div className="inv-lifetime-band__label">Activity</div>
                    <div className="inv-lifetime-band__rows">
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Days active</span>
                        <span className="inv-lifetime-metric-value">{formatStatInt(statDaysActive)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Sessions</span>
                        <span className="inv-lifetime-metric-value">{formatStatInt(statSessionCount)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Total hours</span>
                        <span className="inv-lifetime-metric-value">{formatStatHours(coreTotalHours)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">
                          Hands/hour
                          <Tooltip title="Over 100 hands/hour typically indicates intense multi-tabling or bot assistance.">
                            <span className="inv-lifetime-help" aria-hidden="true">(?)</span>
                          </Tooltip>
                        </span>
                        <span className="inv-lifetime-metric-value">
                          {coreHandsPerHour != null && Number.isFinite(coreHandsPerHour) && coreHandsPerHour > 0 ? Math.round(coreHandsPerHour) : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="inv-lifetime-band inv-lifetime-band--infra">
                    <div className="inv-lifetime-band__label">Infrastructure</div>
                    <div className="inv-lifetime-band__rows">
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Logins</span>
                        <span className="inv-lifetime-metric-value">{stats?.total_logins ?? '0'}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Unique IPs</span>
                        <span className="inv-lifetime-metric-value">{stats?.unique_ips ?? '0'}</span>
                      </div>
                      <div className="inv-lifetime-metric-row inv-lifetime-metric-row--warn">
                        <span className="inv-lifetime-metric-label">Unique serials</span>
                        <span
                          className="inv-lifetime-metric-value"
                          style={{ color: Number(stats?.unique_serials ?? 0) > 2 ? '#f87171' : undefined }}
                        >
                          {stats?.unique_serials ?? '0'}
                        </span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">
                          IP volatility
                          <Tooltip title="High volatility (&gt; 50%) indicates frequent network switching, potential account sharing, or VPN usage.">
                            <span className="inv-lifetime-help" aria-hidden="true">(?)</span>
                          </Tooltip>
                        </span>
                        <span
                          className="inv-lifetime-metric-value stat-metric-nowrap"
                          style={{
                            color:
                              Number(stats?.ip_volatility) > 80
                                ? '#f87171'
                                : Number(stats?.ip_volatility) > 50
                                  ? '#fb923c'
                                  : undefined,
                          }}
                        >
                          {stats?.ip_volatility !== undefined && stats?.ip_volatility !== null ? `${stats.ip_volatility}%` : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="inv-lifetime-band inv-lifetime-band--tourney">
                    <div className="inv-lifetime-band__label">Tournaments (warehouse)</div>
                    <div className="inv-lifetime-band__rows">
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">MTT played</span>
                        <span className="inv-lifetime-metric-value">{formatStatInt(kpiMttTournamentsPlayed)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">MTT won (net &gt; 0)</span>
                        <span className="inv-lifetime-metric-value">{formatStatInt(kpiMttTournamentsWon)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">MTT win %</span>
                        <span className="inv-lifetime-metric-value">
                          {kpiMttWinPct != null && Number.isFinite(Number(kpiMttWinPct)) ? `${Number(kpiMttWinPct).toFixed(2)}%` : '—'}
                        </span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">MTT total buy-in</span>
                        <span className="inv-lifetime-metric-value">
                          {kpiTotalMttBuyin != null ? formatCurrency(Number(kpiTotalMttBuyin)) : '—'}
                        </span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">MTT total win</span>
                        <span className="inv-lifetime-metric-value">
                          {kpiMttTotalWin != null ? formatCurrency(Number(kpiMttTotalWin)) : '—'}
                        </span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Twister played</span>
                        <span className="inv-lifetime-metric-value">{formatStatInt(kpiTwistersPlayed)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Twister won (net &gt; 0)</span>
                        <span className="inv-lifetime-metric-value">{formatStatInt(kpiTwisterTournamentsWon)}</span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Twister win %</span>
                        <span className="inv-lifetime-metric-value">
                          {kpiTwisterWinPct != null && Number.isFinite(Number(kpiTwisterWinPct)) ? `${Number(kpiTwisterWinPct).toFixed(2)}%` : '—'}
                        </span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Twister total buy-in</span>
                        <span className="inv-lifetime-metric-value">
                          {kpiTotalTwisterBuyin != null ? formatCurrency(Number(kpiTotalTwisterBuyin)) : '—'}
                        </span>
                      </div>
                      <div className="inv-lifetime-metric-row">
                        <span className="inv-lifetime-metric-label">Twister total win</span>
                        <span className="inv-lifetime-metric-value">
                          {kpiTwisterTotalWin != null ? formatCurrency(Number(kpiTwisterTotalWin)) : '—'}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="section-hint" style={{ marginTop: '12px' }}>No lifetime statistics available.</p>
              )}
            </div>
            </div>

            <div id="inv-hud" className="gv-panel-tight inv-anchor">
              <InvestigatorHUD stats={profile?.playstyle_stats} />
            </div>

            <div id="inv-network" className="gv-panel-tight inv-anchor">
              <NetworkAndSessions spikeLog={spikeLog} />
            </div>

            <div id="inv-twins" className="gv-panel-tight inv-anchor">
              <HardwareTwins twins={profile?.hardware_twins} />
            </div>

            <div id="inv-charts" className="player-page-chart-stack inv-anchor">
            <div className="global-view-card chart-card gv-panel-tight">
              <Typography variant="subtitle1" fontWeight="bold" gutterBottom style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                Stake & Profit Timeline
                {hasStakeJump && (
                  <span style={{ fontSize: '11px', fontWeight: 'bold', padding: '4px 10px', borderRadius: '6px', background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                    Stake Jump
                  </span>
                )}
              </Typography>
              {isGhostAccount ? (
                <div style={{ padding: '40px', textAlign: 'center', color: '#64748b', backgroundColor: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: '8px' }}>
                  <p style={{ fontSize: '14px', margin: 0, fontWeight: 'bold' }}>Chart Disabled</p>
                  <p style={{ fontSize: '12px', marginTop: '8px', color: '#94a3b8' }}>No real-money session data exists for this account.</p>
                </div>
              ) : Array.isArray(financialTimeline) && financialTimeline.length > 0 ? (
                <div className="investigation-financial-chart-wrap">
                  <FinancialChart data={financialTimeline} variant="dark" lifetimeTotalProfit={kpiTotalProfit} />
                </div>
              ) : (
                <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
                  <p style={{ fontSize: '14px', margin: 0 }}>Insufficient data to generate financial chart</p>
                  <p style={{ fontSize: '12px', marginTop: '8px', color: '#94a3b8' }}>No timeline data available for this player</p>
                </div>
              )}
            </div>
            
            <CollusionInsightCharts
              gameplayNetwork={gameplayNetwork}
              sessionHistory={sessionHistory}
              suspiciousSessions={caseData?.suspicious_sessions}
              chipDumpingFlag={chipDumpingFlag}
              isGhostAccount={isGhostAccount}
            />
            </div>

            <div id="inv-related" className="global-view-card related-players-card gv-panel-tight player-related-compact inv-anchor">
              <div className="related-players-head">
                <h5 className="player-panel-heading" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: 0 }}>
                  Related players
                  {isRelatedHighRisk && (
                    <span className="player-risk-pill">High risk</span>
                  )}
                </h5>
                <div className="related-players-filter">
                  <label htmlFor="relatedMatchFilter" className="related-players-filter-label">Match on</label>
                  <select
                    id="relatedMatchFilter"
                    className="select-control related-players-filter-select"
                    value={relatedMatchFilter}
                    onChange={(e) => setRelatedMatchFilter(e.target.value)}
                  >
                    <option value="both">Both (IP + device)</option>
                    <option value="all">All links</option>
                    <option value="ip">IP only</option>
                    <option value="serial">Device only</option>
                  </select>
                </div>
              </div>
              <p className="section-hint related-players-filter-hint">
                Default shows only accounts sharing <strong>both</strong> the same IP and device serial as the target. Expand with &quot;All links&quot; to include IP-only or device-only matches.
              </p>
              {relatedPlayers.length > 0 ? (
                <div className="gi-table-wrap player-related-table-wrap">
                  <table className="gi-players-table player-related-table">
                      <thead>
                        <tr>
                          <th>Nickname</th>
                          <th>Cardroom</th>
                          <th>Match</th>
                          <th>Shared connection</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRelatedPlayers.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="triage-table-empty">
                              No players match this filter.
                            </td>
                          </tr>
                        ) : (
                          filteredRelatedPlayers.map((rp, i) => {
                            const via = rp.match_via || 'IP';
                            const isBoth = via === 'Both';
                            const ip = rp.ip ?? rp.Ip ?? '';
                            const serial = rp.serial ?? rp.Serial ?? '';
                            const rpc = rp.player_code ?? rp.PlayerCode;
                            const rpHref = rpc != null && String(rpc).trim() ? playerProfileUrl(String(rpc).trim()) : null;
                            const nickDisplay = rp.nickname ?? rp.Nickname ?? '—';
                            return (
                              <tr key={`${rp.nickname ?? i}-${i}`}>
                                <td className="player-related-nick">
                                  {rpHref ? (
                                    <a className="admin-quick-link" href={rpHref} target="_blank" rel="noopener noreferrer">{nickDisplay}</a>
                                  ) : (
                                    nickDisplay
                                  )}
                                </td>
                                <td>{rp.cardroom ?? rp.Casino ?? '—'}</td>
                                <td>
                                  <span className={`player-match-pill match-${via.toLowerCase().replace(/\s+/g, '-')}`}>
                                    {via}
                                  </span>
                                </td>
                                <td className="player-related-connection">
                                  {isBoth ? (
                                    <div className="player-related-both-detail">
                                      <div><span className="player-related-conn-k">IP</span> <code className="player-related-conn-val">{ip || '—'}</code></div>
                                      <div><span className="player-related-conn-k">Serial</span> <code className="player-related-conn-val">{serial || '—'}</code></div>
                                    </div>
                                  ) : (
                                    <span className="section-hint player-related-conn-na">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                </div>
              ) : (
                <p className="section-hint" style={{ margin: 0 }}>No linked accounts (shared device / IP).</p>
              )}

              <div className="player-common-sng-overlap" style={{ marginTop: '12px' }}>
                <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                  Common SNG overlap (report)
                </Typography>
                <p className="section-hint" style={{ margin: '0 0 8px', fontSize: '12px' }}>
                  These partners share a high volume of tournaments played together (pairwise overlap). Rows with fewer than five common tournaments are hidden. Percentages show what share of each player&apos;s volume those shared games represent — not the live session-count table below.
                </p>
                {commonSngOverlapFiltered.length > 0 ? (
                  <>
                  <div className="gi-table-wrap">
                    <table className="gi-players-table">
                      <thead>
                        <tr>
                          <th>Partner</th>
                          <th>Common tourneys</th>
                          <th>Target % of volume</th>
                          <th>Their % of volume</th>
                          <th>Target tourneys (total)</th>
                          <th>Partner tourneys (total)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {commonSngOverlapFiltered.map((row, i) => {
                          const partnerHref =
                            row.partner_code != null && String(row.partner_code).trim() !== ''
                              ? playerProfileUrl(String(row.partner_code).trim())
                              : null;
                          return (
                          <tr key={`${row.partner_code || ''}-${row.partner_nickname || ''}-${i}`}>
                            <td className="inv-gameplay-nick">
                              {partnerHref ? (
                                <a className="admin-quick-link" href={partnerHref} target="_blank" rel="noopener noreferrer">
                                  {row.partner_nickname ?? '—'}
                                </a>
                              ) : (
                                row.partner_nickname ?? '—'
                              )}
                            </td>
                            <td>{row.common_tournaments ?? '—'}</td>
                            <td style={overlapPctStyle(row.pct_target)}>{formatOverlapPct(row.pct_target)}</td>
                            <td style={overlapPctStyle(row.pct_partner)}>{formatOverlapPct(row.pct_partner)}</td>
                            <td>{formatOptionalTourneyCount(row.target_tournaments_total)}</td>
                            <td>{formatOptionalTourneyCount(row.partner_tournaments_total)}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <CommonSngOverlapMiniChart rows={commonSngOverlapFiltered} />
                  </>
                ) : (
                  <p className="section-hint">No Common SNG report rows for this player with at least five common tournaments (or report table unavailable).</p>
                )}
              </div>

              <div className="player-gameplay-overlap" style={{ marginTop: '12px' }}>
                <Typography variant="subtitle2" fontWeight="bold" gutterBottom>
                  Live overlap (MTT / SNG / Twister + major cash sessions)
                </Typography>
                <p className="section-hint" style={{ margin: '0 0 8px', fontSize: '12px' }}>
                  Count-based overlap from warehouse tables (distinct tournament codes plus major-income session codes). For overlap as a share of each player&apos;s volume, use the report table above.
                </p>
                {Array.isArray(gameplayNetwork) && gameplayNetwork.length > 0 ? (
                  <div className="gi-table-wrap">
                    <table className="gi-players-table">
                      <thead>
                        <tr>
                          <th>Related Player</th>
                          <th>Shared Games</th>
                          <th>MTTs</th>
                          <th>Twisters</th>
                          <th>Their Winnings</th>
                          <th>Target&apos;s Winnings</th>
                          <th>Combined Syndicate Win</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gameplayNetwork.map((r, i) => {
                          const relatedPlayer = r?.related_player ?? r?.accomplice ?? '—';
                          const rpc = r?.related_player_code ?? r?.accomplice_player_code;
                          const rpHref = rpc != null && String(rpc).trim() ? playerProfileUrl(String(rpc).trim()) : null;
                          const sharedGames = Number(r?.shared_games ?? r?.shared_mtts ?? 0) || 0;
                          const sharedMtts = Number(r?.shared_mtts ?? r?.shared_games ?? 0) || 0;
                          const sharedTwisters = Number(r?.shared_twisters ?? 0) || 0;
                          const relatedWinnings = Number(r?.related_winnings ?? r?.total_accomplice_win ?? 0) || 0;
                          const targetWinnings = Number(r?.target_winnings ?? 0) || 0;
                          const combinedWinnings = Number(r?.combined_winnings ?? relatedWinnings + targetWinnings) || 0;
                          return (
                            <tr key={i}>
                              <td className="inv-gameplay-nick">
                                {rpHref ? (
                                  <a className="admin-quick-link" href={rpHref} target="_blank" rel="noopener noreferrer">{relatedPlayer}</a>
                                ) : (
                                  relatedPlayer
                                )}
                              </td>
                              <td>{sharedGames}</td>
                              <td>{sharedMtts}</td>
                              <td>{sharedTwisters}</td>
                              <td>{formatCurrency(relatedWinnings)}</td>
                              <td>{formatCurrency(targetWinnings)}</td>
                              <td className="inv-gameplay-kpi">{formatCurrency(combinedWinnings)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="section-hint">No significant gameplay overlap found (syndicate list requires 5+ shared tournaments).</p>
                )}
              </div>
            </div>

              <div id="inv-sessions" className="global-view-card recent-sessions-card gv-panel-tight inv-anchor">
                <Typography variant="subtitle1" className="player-panel-heading" style={{ marginBottom: '8px' }}>Recent performance</Typography>
                <div className="player-recent-sessions-stack">
                  <div className="gi-table-wrap player-sessions-table-wrap">
                    <Typography variant="subtitle2" className="inv-session-subhead" fontWeight="bold" gutterBottom>
                      Cash sessions
                    </Typography>
                    {!sessionHistory || sessionHistory.length === 0 ? (
                      <p className="section-hint">No cash session history.</p>
                    ) : !sessionHistory.some((row) => row && Number(row.hands ?? row['# of hands'] ?? 0) > 0) ? (
                      <p className="section-hint">No cash sessions with hands played (0-hand rows hidden).</p>
                    ) : (
                    <table className="gi-players-table player-sessions-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Time</th>
                          <th>Session code</th>
                          <th>Stake (BB)</th>
                          <th>Hands</th>
                          <th>Rake</th>
                          <th>Duration</th>
                          <th>Sat with</th>
                          <th>Left with</th>
                          <th>Profit</th>
                          <th>ROI %</th>
                        </tr>
                      </thead>
                      <tbody>
                          {sessionHistory
                            .filter((row) => row && typeof row === 'object' && Number(row.hands ?? row['# of hands'] ?? 0) > 0)
                            .map((row, i) => {
                            const { dateStr, timeStr } = splitDateTime(row.start_date);
                            const durationSecs = Number(row.duration_seconds ?? row['Duration (seconds)'] ?? 0) || 0;
                            const durationStr = durationSecs > 0
                              ? `${Math.floor(durationSecs / 3600)}h ${Math.floor((durationSecs % 3600) / 60)}m`
                              : '—';
                            const profitVal = Number(row.profit ?? 0);
                            const roiPct = row.roi_pct != null ? Number(row.roi_pct) : Number(row.roi ?? 0) * 100;
                            const finClass = sessionFinancialClass(profitVal, roiPct);
                            const buyIn = Number(row.buy_in || 0);
                            const cashOut = row.cash_out != null ? Number(row.cash_out) : buyIn + profitVal;
                            const rakeVal = Number(row.rake ?? 0);
                            const codeDisplay = row.session_code || row['Session code'] || row.poker_session_code || '—';
                            const cashSessHref =
                              codeDisplay != null && String(codeDisplay).trim() && String(codeDisplay) !== '—'
                                ? sessionCodeSearchUrl(String(codeDisplay).trim())
                                : null;

                            return (
                              <tr key={i || `cash-${i}`}>
                                <td>{dateStr}</td>
                                <td>{timeStr}</td>
                                <td className="player-session-code-cell" title={row.session_serial ? `Serial: ${row.session_serial}` : undefined}>
                                  {cashSessHref ? (
                                    <a className="admin-quick-link" href={cashSessHref} target="_blank" rel="noopener noreferrer">{String(codeDisplay)}</a>
                                  ) : (
                                    String(codeDisplay)
                                  )}
                                </td>
                                <td>{row.big_blind != null ? formatVal(row.big_blind) : '—'}</td>
                                <td>{row.hands != null ? formatVal(row.hands) : '—'}</td>
                                <td>{rakeVal.toFixed(2)}</td>
                                <td>{durationStr}</td>
                                <td>{buyIn.toFixed(2)}</td>
                                <td>{cashOut.toFixed(2)}</td>
                                <td className={`num ${finClass}`.trim()}>{profitVal.toFixed(2)}</td>
                                <td className={`num ${finClass}`.trim()}>{roiPct.toFixed(2)}%</td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                    )}
                  </div>

                  <div className="gi-table-wrap player-sessions-table-wrap">
                    <Typography variant="subtitle2" className="inv-session-subhead" fontWeight="bold" gutterBottom>
                      Tournament sessions
                    </Typography>
                    <table className="gi-players-table player-sessions-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Time</th>
                          <th>Session / tour code</th>
                          <th>Buy-in</th>
                          <th>Fees</th>
                          <th>Hands</th>
                          <th>Duration</th>
                          <th>Sat with</th>
                          <th>Left with</th>
                          <th>Profit</th>
                          <th>Pos.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!Array.isArray(mttSessions) || mttSessions.length === 0 ? (
                          <tr>
                            <td colSpan={11}>No tournament data.</td>
                          </tr>
                        ) : (
                          mttSessions.map((row, i) => {
                            if (!row || typeof row !== 'object') return null;
                            const { dateStr, timeStr } = splitDateTime(row.start_date);
                            const tId = row.tournament_id ?? row['Tournament code'];
                            const sessCode = row.session_code ?? row['Session code'];
                            const tCode = sessCode || tId || '—';
                            const tourHref =
                              tId != null && String(tId).trim() && String(tId) !== '—'
                                ? tournamentEditUrl(String(tId).trim())
                                : null;
                            const mttSessHref =
                              !tourHref && sessCode != null && String(sessCode).trim() && String(sessCode) !== '—'
                                ? sessionCodeSearchUrl(String(sessCode).trim())
                                : null;
                            const buyIn = Number(row.buy_in ?? 0) || 0;
                            const fees = Number(row.fee_total ?? 0) || 0;
                            const satDown = row.sat_down != null ? Number(row.sat_down) : buyIn + fees;
                            const prize = Number(row.prize_money ?? row.win_amount ?? 0) || 0;
                            const profitNet = row.profit != null ? Number(row.profit) : prize - satDown;
                            const durS = row.duration_seconds != null ? Number(row.duration_seconds) : 0;
                            const durStr = durS > 0 ? `${Math.floor(durS / 3600)}h ${Math.floor((durS % 3600) / 60)}m` : '—';
                            const hands = row.hands ?? row.field_size ?? row['# Hands'] ?? '—';
                            const pos = row.position ?? '—';
                            const profitClass =
                              profitNet > 0 ? 'session-fin-pos' : profitNet < 0 ? 'session-fin-neg' : '';

                            return (
                              <tr key={i || `mtt-${i}`}>
                                <td>{dateStr}</td>
                                <td>{timeStr}</td>
                                <td className="player-session-code-cell">
                                  {tourHref ? (
                                    <a className="admin-quick-link" href={tourHref} target="_blank" rel="noopener noreferrer">{String(tCode)}</a>
                                  ) : mttSessHref ? (
                                    <a className="admin-quick-link" href={mttSessHref} target="_blank" rel="noopener noreferrer">{String(tCode)}</a>
                                  ) : (
                                    String(tCode)
                                  )}
                                </td>
                                <td>{formatCurrency(buyIn, row?.Currency)}</td>
                                <td>{formatCurrency(fees, row?.Currency)}</td>
                                <td>{hands}</td>
                                <td>{durStr}</td>
                                <td>{satDown.toFixed(2)}</td>
                                <td>{prize.toFixed(2)}</td>
                                <td className={`num ${profitClass}`.trim()}>{profitNet.toFixed(2)}</td>
                                <td>{pos}</td>
                              </tr>
                            );
                          }).filter(Boolean)
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

            {/* Triggered Sessions table removed – merged into Recent Sessions via ID column */}

            {/* --- LIVE REPORT WIDESCREEN TABLE --- */}
            {isFetchingReport && (
              <div id="inv-live-report" className="global-view-card inv-anchor" style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                <h5>📡 Connecting to Playtech Admin API...</h5>
                <p>Generating live report. This may take a few seconds.</p>
              </div>
            )}

            {liveReportData && !isFetchingReport && (
              <div id="inv-live-report" className="global-view-card triggers-card inv-anchor" style={{ borderTop: '4px solid #3b82f6' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h5 style={{ margin: 0 }}>Live Report Results: EFOP (Last 14 Days)</h5>
                  <span className="inv-live-report-badge">{liveReportData.length} Rows Found</span>
                </div>

                {liveReportData.length === 0 ? (
                  <p className="section-hint">No data found for this player in the specified timeframe.</p>
                ) : (
                  <div className="gi-table-wrap triggers-table-wrap" style={{ overflowX: 'auto' }}>
                    <table className="gi-players-table triggers-table">
                      <thead>
                        <tr className="inv-live-report-head-row">
                          {liveReportData[0] && Object.keys(liveReportData[0]).map(key => (
                            <th key={key}>{key}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.isArray(liveReportData) && liveReportData.map((row, i) => (
                          <tr key={i} style={{ whiteSpace: 'nowrap' }}>
                            {row && Object.values(row).map((val, j) => (
                              <td key={j}>{val !== null && val !== undefined ? String(val) : '—'}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </main>
          <aside className="player-page-kpi-aside investigation-portal__kpi-rail" aria-label="Key metrics">
            <div className="player-kpi-aside-label">Key metrics</div>
            {kpiAsideCards}
          </aside>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
