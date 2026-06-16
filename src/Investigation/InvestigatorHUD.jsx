import React from 'react';

/** Typical “healthy” band per stat (inclusive). Outside → ramp toward red (fraud lens: extremes are suspicious). */
const HUD_BANDS = {
  VPIP: [14, 32],
  PFR: [12, 28],
  '3-Bet': [2, 10],
  '4-Bet': [0, 6],
  Limp: [0, 14],
  'Flop CBet': [52, 76],
  'Turn CBet': [28, 52],
  'River CBet': [18, 44],
  'AGG %': [28, 50],
  'Overbet R': [0, 8],
  WTSD: [22, 34],
  WSD: [44, 60],
  'F-vs-CBet': [34, 56],
  'C-vs-CBet': [12, 28],
  'R-vs-CBet': [8, 24],
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpRgb(c0, c1, t) {
  const r = Math.round(lerp(c0[0], c1[0], t));
  const g = Math.round(lerp(c0[1], c1[1], t));
  const b = Math.round(lerp(c0[2], c1[2], t));
  return `rgb(${r},${g},${b})`;
}

const GREEN = [74, 222, 128];
const AMBER = [234, 179, 8];
const RED = [248, 113, 113];

function colorForRiskT(t) {
  const x = Math.min(1, Math.max(0, t));
  if (x <= 0) return `rgb(${GREEN.join(',')})`;
  if (x >= 1) return `rgb(${RED.join(',')})`;
  if (x < 0.5) return lerpRgb(GREEN, AMBER, x * 2);
  return lerpRgb(AMBER, RED, (x - 0.5) * 2);
}

/** 0 = inside band (green), 1 = far outside (red). */
function hudRiskT(label, raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return 0;
  const band = HUD_BANDS[label];
  if (!band) return Math.min(1, Math.max(0, Math.abs(v - 35) / 50));
  const [lo, hi] = band;
  if (v >= lo && v <= hi) return 0;
  const span = Math.max(10, (hi - lo) * 0.45);
  const dist = v < lo ? lo - v : v - hi;
  return Math.min(1, dist / span);
}

export default function InvestigatorHUD({ stats }) {
  if (!stats || !stats.hands || stats.hands === 0) {
    return (
      <div className="investigator-hud investigator-hud--empty">
        <p className="investigator-hud__empty-title">No cash game fingerprint available</p>
        <p className="investigator-hud__empty-hint">This account may be a Tournament/SNG specialist.</p>
      </div>
    );
  }

  return (
    <div className="investigator-hud">
      <div className="investigator-hud__head">
        <h3 className="investigator-hud__title">Behavioral stats</h3>
        <span className="investigator-hud__badge">Primary_Cash_Games_Player_Stats · {stats.hands.toLocaleString()} hands</span>
      </div>

      <div className="investigator-hud__body investigator-hud__body--pillars-only">
        <div className="investigator-hud__pillars investigator-hud__pillars--full">
          <StatPillar
            title="Pre-flop"
            items={[
              { label: 'VPIP', val: stats.vpip },
              { label: 'PFR', val: stats.pfr },
              { label: '3-Bet', val: stats.three_bet },
              { label: '4-Bet', val: stats.four_bet },
              { label: 'Limp', val: stats.limp },
            ]}
          />
          <StatPillar
            title="Aggression"
            items={[
              { label: 'Flop CBet', val: stats.flop_cbet },
              { label: 'Turn CBet', val: stats.turn_cbet },
              { label: 'River CBet', val: stats.river_cbet },
              { label: 'AGG %', val: stats.post_flop_agg },
              { label: 'Overbet R', val: stats.overbet_river },
            ]}
          />
          <StatPillar
            title="Showdown"
            items={[
              { label: 'WTSD', val: stats.wtsd },
              { label: 'WSD', val: stats.wsd },
              { label: 'F-vs-CBet', val: stats.fold_vs_flop_cbet },
              { label: 'C-vs-CBet', val: stats.call_vs_flop_cbet },
              { label: 'R-vs-CBet', val: stats.raise_vs_flop_cbet },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

function StatPillar({ title, items }) {
  const formatPct = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    const num = Number(v);
    if (Number.isNaN(num)) return '—';
    return `${Math.round(num)}%`;
  };
  return (
    <div className="investigator-hud__pillar">
      <p className="investigator-hud__pillar-title">{title}</p>
      {items.map((i) => {
        const t = hudRiskT(i.label, i.val);
        const color = colorForRiskT(t);
        return (
          <div key={i.label} className="investigator-hud__pillar-row">
            <span className="investigator-hud__pillar-label">{i.label}</span>
            <span className="investigator-hud__pillar-val" style={{ color }}>
              {formatPct(i.val)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
