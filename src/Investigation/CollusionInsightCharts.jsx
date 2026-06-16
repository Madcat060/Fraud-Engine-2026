/**
 * Collusion-focused charts: syndicate overlap (gameplay network) + per-session P&L pulse.
 * Uses Chart.js (same stack as FinancialChart) for reliable Vite builds.
 */
import React, { useMemo } from 'react';
import Typography from '@mui/material/Typography';
import { Bar } from 'react-chartjs-2';
import { playerProfileUrl } from './adminLinks';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  BarController,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, BarController, Title, Tooltip, Legend);

const axisColor = 'rgba(148, 163, 184, 0.85)';
const gridColor = 'rgba(148, 163, 184, 0.12)';

function formatMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildSyndicateOptions(rows) {
  return {
    indexAxis: 'y',
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: false },
      tooltip: {
        backgroundColor: 'rgba(15, 10, 30, 0.95)',
        borderColor: 'rgba(139, 92, 246, 0.4)',
        borderWidth: 1,
        titleColor: '#f8fafc',
        bodyColor: '#e2e8f0',
        padding: 12,
        callbacks: {
          label(ctx) {
            const i = ctx.dataIndex;
            const r = rows[i];
            if (!r) return [];
            return [`Combined: ${formatMoney(r.combined)}`, `Shared games: ${r.shared}`];
          },
        },
      },
    },
    scales: {
      x: {
        grid: { color: gridColor },
        ticks: { color: axisColor, font: { size: 11 } },
      },
      y: {
        grid: { display: false },
        ticks: { color: axisColor, font: { size: 11 } },
      },
    },
  };
}

const pulseOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: 'rgba(15, 10, 30, 0.95)',
      borderColor: 'rgba(139, 92, 246, 0.4)',
      borderWidth: 1,
      titleColor: '#f8fafc',
      bodyColor: '#e2e8f0',
      callbacks: {
        label(ctx) {
          return `Session P/L: ${formatMoney(ctx.parsed.y)}`;
        },
      },
    },
  },
  scales: {
    x: {
      grid: { display: false },
      ticks: { color: axisColor, font: { size: 10 }, maxRotation: 45 },
    },
    y: {
      grid: { color: gridColor },
      ticks: { color: axisColor, font: { size: 11 } },
    },
  },
};

export function SyndicateOverlapChart({ gameplayNetwork }) {
  const { chartData, options, linkRows } = useMemo(() => {
    if (!Array.isArray(gameplayNetwork) || !gameplayNetwork.length) {
      return { chartData: null, options: null, linkRows: [] };
    }
    const rows = [...gameplayNetwork]
      .map((r) => {
        const rawName = (r?.related_player ?? r?.accomplice ?? '—').toString();
        const code = (r?.related_player_code ?? r?.accomplice_player_code ?? '').toString().trim();
        const combined = Number(r?.combined_winnings ?? 0) || 0;
        const shared = Number(r?.shared_games ?? r?.shared_mtts ?? 0) || 0;
        const name = rawName.length > 24 ? `${rawName.slice(0, 22)}…` : rawName;
        const profileHref = code ? playerProfileUrl(code) : null;
        return { name, combined, shared, code, profileHref };
      })
      .sort((a, b) => Math.abs(b.combined) - Math.abs(a.combined))
      .slice(0, 12);

    const labels = rows.map((r) => r.name);
    const values = rows.map((r) => r.combined);
    const colors = rows.map((r) =>
      r.combined >= 0 ? 'rgba(52, 211, 153, 0.75)' : 'rgba(248, 113, 113, 0.82)'
    );

    return {
      chartData: {
        labels,
        datasets: [
          {
            label: 'Combined syndicate win',
            data: values,
            backgroundColor: colors,
            borderColor: rows.map((r) =>
              r.combined >= 0 ? 'rgba(34, 211, 238, 0.5)' : 'rgba(192, 132, 252, 0.55)'
            ),
            borderWidth: 1,
            borderRadius: 6,
            barThickness: 18,
          },
        ],
      },
      options: buildSyndicateOptions(rows),
      linkRows: rows,
    };
  }, [gameplayNetwork]);

  if (!chartData) {
    return (
      <div className="collusion-chart-empty">
        <p className="section-hint">No gameplay overlap data — chart appears when rules 16–17 find shared tables.</p>
      </div>
    );
  }

  return (
    <div className="collusion-syndicate-chart-block">
      <div className="collusion-chart-wrap collusion-chart-wrap--syndicate" style={{ width: '100%', height: 300 }}>
        <Bar data={chartData} options={options} />
      </div>
      {linkRows.length > 0 && (
        <div className="collusion-syndicate-quicklinks" style={{ marginTop: '10px', fontSize: '12px', lineHeight: 1.6 }}>
          <span className="section-hint" style={{ display: 'block', marginBottom: '6px' }}>
            Partner profiles (same order as bars)
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'center' }}>
            {linkRows.map((r, i) => {
              const label = r.code || r.name;
              return r.profileHref ? (
                <a
                  key={`${r.code || r.name}-${i}`}
                  className="admin-quick-link"
                  href={r.profileHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {label}
                </a>
              ) : (
                <span key={`${r.name}-${i}`} className="section-hint">
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionProfitPulseChart({ sessionHistory }) {
  const chartData = useMemo(() => {
    if (!Array.isArray(sessionHistory) || !sessionHistory.length) return null;
    const sorted = [...sessionHistory].sort((a, b) => {
      const da = (a?.start_date ?? a?.['Start date'] ?? '').toString();
      const db = (b?.start_date ?? b?.['Start date'] ?? '').toString();
      return da.localeCompare(db);
    });
    const slice = sorted.slice(-40);
    const labels = slice.map((s, i) => {
      const raw = (s?.start_date ?? s?.['Start date'] ?? '').toString();
      if (raw.includes('T')) {
        return raw.split('T')[0].slice(0, 10);
      }
      if (raw.length >= 10) {
        return raw.slice(0, 10);
      }
      return `#${i + 1}`;
    });
    const profits = slice.map((s) => {
      const p = Number(
        s?.profit ?? (s?.Win != null && s?.Buy != null ? Number(s.Win) - Number(s.Buy) : NaN)
      );
      return Number.isFinite(p) ? p : 0;
    });

    return {
      labels,
      datasets: [
        {
          label: 'Session P/L',
          data: profits,
          backgroundColor: profits.map((p) =>
            p >= 0 ? 'rgba(52, 211, 153, 0.75)' : 'rgba(248, 113, 113, 0.8)'
          ),
          borderColor: profits.map((p) =>
            p >= 0 ? 'rgba(34, 211, 238, 0.35)' : 'rgba(244, 63, 94, 0.4)'
          ),
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    };
  }, [sessionHistory]);

  if (!chartData) {
    return (
      <div className="collusion-chart-empty">
        <p className="section-hint">No session history for per-session P&amp;L chart.</p>
      </div>
    );
  }

  return (
    <div className="collusion-chart-wrap collusion-chart-wrap--pulse" style={{ width: '100%', height: 260 }}>
      <Bar data={chartData} options={pulseOptions} />
    </div>
  );
}

const suspiciousPulseOptions = {
  ...pulseOptions,
  plugins: {
    ...pulseOptions.plugins,
    tooltip: {
      ...pulseOptions.plugins.tooltip,
      callbacks: {
        label(ctx) {
          return `Profit: ${formatMoney(ctx.parsed.y)}`;
        },
      },
    },
  },
};

/** Case suspicious_sessions rows: per-session profit (same visual language as session P/L pulse). */
export function SuspiciousSessionsProfitChart({ suspiciousSessions }) {
  const chartData = useMemo(() => {
    if (!Array.isArray(suspiciousSessions) || !suspiciousSessions.length) return null;
    const sorted = [...suspiciousSessions].sort((a, b) => {
      const ta = Date.parse(String(a?.date ?? ''));
      const tb = Date.parse(String(b?.date ?? ''));
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      return String(a?.date ?? '').localeCompare(String(b?.date ?? ''));
    });
    const slice = sorted.slice(-40);
    const labels = slice.map((s, i) => {
      const raw = String(s?.date ?? '');
      if (raw.includes('T')) return raw.split('T')[0].slice(0, 10);
      if (raw.length >= 10) return raw.slice(0, 10);
      const sc = String(s?.session_code ?? '').trim();
      if (sc.length <= 14) return sc || `#${i + 1}`;
      return `${sc.slice(0, 12)}…`;
    });
    const profits = slice.map((s) => {
      const p = Number(s?.profit);
      return Number.isFinite(p) ? p : 0;
    });

    return {
      labels,
      datasets: [
        {
          label: 'Session profit',
          data: profits,
          backgroundColor: profits.map((p) =>
            p >= 0 ? 'rgba(52, 211, 153, 0.75)' : 'rgba(248, 113, 113, 0.8)'
          ),
          borderColor: profits.map((p) =>
            p >= 0 ? 'rgba(34, 211, 238, 0.35)' : 'rgba(244, 63, 94, 0.4)'
          ),
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    };
  }, [suspiciousSessions]);

  if (!chartData) {
    return (
      <div className="collusion-chart-empty">
        <p className="section-hint">No suspicious sessions to chart.</p>
      </div>
    );
  }

  return (
    <div className="collusion-chart-wrap collusion-chart-wrap--pulse" style={{ width: '100%', height: 240 }}>
      <Bar data={chartData} options={suspiciousPulseOptions} />
    </div>
  );
}

const miniBarOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: {
      ticks: { color: axisColor, maxRotation: 45, font: { size: 10 } },
      grid: { color: gridColor },
    },
    y: {
      ticks: { color: axisColor },
      grid: { color: gridColor },
      beginAtZero: true,
    },
  },
};

/** Bar chart below Common SNG overlap table (common tourneys per partner). */
export function CommonSngOverlapMiniChart({ rows }) {
  const chartData = useMemo(() => {
    if (!Array.isArray(rows) || !rows.length) return null;
    const labels = rows.map((r) => {
      const n = (r?.partner_nickname ?? '—').toString();
      return n.length > 14 ? `${n.slice(0, 12)}…` : n;
    });
    const vals = rows.map((r) => Number(r?.common_tournaments) || 0);
    return {
      labels,
      datasets: [
        {
          label: 'Common tourneys',
          data: vals,
          backgroundColor: 'rgba(45, 212, 191, 0.55)',
          borderColor: 'rgba(34, 211, 238, 0.4)',
          borderWidth: 1,
          borderRadius: 4,
        },
      ],
    };
  }, [rows]);

  if (!chartData) return null;

  return (
    <div className="collusion-chart-wrap" style={{ width: '100%', height: 220, marginTop: 12 }}>
      <Bar data={chartData} options={miniBarOptions} />
    </div>
  );
}

export default function CollusionInsightCharts({
  gameplayNetwork,
  sessionHistory,
  suspiciousSessions,
  chipDumpingFlag,
  isGhostAccount,
}) {
  if (isGhostAccount) {
    return (
      <div className="global-view-card gv-panel-tight collusion-insights-card">
        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
          Collusion insights
        </Typography>
        <p className="section-hint">Charts disabled — no real-money session data.</p>
      </div>
    );
  }

  return (
    <div className="global-view-card gv-panel-tight collusion-insights-card inv-collusion-insights">
      <div className="collusion-insights-head">
        <Typography variant="subtitle1" fontWeight="bold" className="collusion-insights-title">
          Collusion intelligence
        </Typography>
        <span className="collusion-insights-sub">
          Syndicate overlap · cash session P/L · suspicious sessions
        </span>
        {chipDumpingFlag && (
          <span className="collusion-insights-chipdump">Wallet-leak pattern flagged (cumulative loss heuristic)</span>
        )}
      </div>

      <div className="collusion-insights-section">
        <Typography variant="subtitle2" fontWeight="bold" gutterBottom className="collusion-insights-section-title">
          Syndicate strength (shared tables)
        </Typography>
        <p className="section-hint collusion-insights-hint">
          Horizontal bars: combined win with accomplices from live syndicate overlap (distinct tourneys / sessions).
        </p>
        <SyndicateOverlapChart gameplayNetwork={gameplayNetwork} />
      </div>

      <div className="collusion-insights-section collusion-insights-section--pulse">
        <Typography variant="subtitle2" fontWeight="bold" gutterBottom className="collusion-insights-section-title">
          Session P&amp;L pulse
        </Typography>
        <p className="section-hint collusion-insights-hint">
          Last cash sessions: each bar is one session — dumps and receiver runs stand out.
        </p>
        <SessionProfitPulseChart sessionHistory={sessionHistory} />
      </div>

      {Array.isArray(suspiciousSessions) && suspiciousSessions.length > 0 && (
        <div className="collusion-insights-section collusion-insights-section--suspicious">
          <Typography variant="subtitle2" fontWeight="bold" gutterBottom className="collusion-insights-section-title">
            Suspicious sessions (profit)
          </Typography>
          <p className="section-hint collusion-insights-hint">
            Bars match the suspicious-sessions forensics table: profit per flagged session (up to 40 most recent by date).
          </p>
          <SuspiciousSessionsProfitChart suspiciousSessions={suspiciousSessions} />
        </div>
      )}
    </div>
  );
}
