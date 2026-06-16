/**
 * RuleSettings.jsx – Centralized Engine Configuration using Accordion UI.
 * Category dropdowns / grouping must use MASTER_CATEGORIES only (fixed engine list).
 */
import React, { useState, useEffect } from 'react';
import { FraudEngineConfigAccordion } from './EngineConfigAccordion';

const API = '';

/** Empty / invalid → null for persisted exclusions JSON (never send ""). */
function exclusionRoiToPayload(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  if (v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function exclusionRoiFromDb(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** First non-empty among alternate parameter keys (DB/engine often snake_case; accordion camelCase). */
function _pickParam(o, keys) {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(o, k)) {
      const v = o[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

/**
 * Map ``fraud_rule_configs.parameters`` onto accordion ``specific`` keys without mixing in
 * hand-built defaults. Surviving keys are whatever the API persisted.
 */
function normalizeRuleSpecificForUi(ruleId, params) {
  if (!params || typeof params !== 'object') return {};
  const p = { ...params };
  if (ruleId === 1) {
    delete p.max_age_days;
    if (p.min_cash_margin_pct == null) {
      p.min_cash_margin_pct = _pickParam(p, ['min_cash_margin_pct', 'burner_roi_threshold', 'burnerMinRoiPct']);
    }
    if (p.min_cash_total_bets == null) p.min_cash_total_bets = _pickParam(p, ['min_cash_total_bets', 'min_burner_profit']);
  }
  if (ruleId === 2) {
    if (p.major_max_age_days == null) {
      p.major_max_age_days = _pickParam(p, ['major_max_age_days', 'max_age_days']);
    }
    if (p.min_major_pct_win == null) p.min_major_pct_win = _pickParam(p, ['min_major_pct_win']);
    if (p.min_major_session_win == null) p.min_major_session_win = _pickParam(p, ['min_major_session_win']);
  }
  if (ruleId === 3 || ruleId === 4 || ruleId === 5) {
    if (p.min_common_tournaments == null) {
      p.min_common_tournaments = _pickParam(p, ['min_common_tournaments']);
    }
    if (p.min_overlap_pct == null) {
      p.min_overlap_pct = _pickParam(p, ['min_overlap_pct', 'min_pct_either']);
    }
  }
  return p;
}

/** Master categories for rules (must match Engine + DB + triage CASE_TABS, excluding "All"). */
export const MASTER_CATEGORIES = ['Chip Dumping', 'New Account High Win', 'Common Games', 'General'];

const INITIAL_SETTINGS = {
  caseTriggerScore: 100,
  globalRequirePaidActivity: true,
  globalPaidActivityEpsilon: 1e-6,
};

/**
 * Replaces {key} placeholders in a dynamic_description template with current values from params.
 * Uses regex to find all {key} tokens and substitutes params[key]; missing keys become empty string.
 * @param {string} template - e.g. "Flags daily efficiency higher than {payout_floor}% on at least {bet_floor} bets."
 * @param {Object} params - e.g. { payout_floor: 180, bet_floor: 50 }
 * @returns {string} Rendered description with placeholders replaced.
 */
export function renderDescription(template, params) {
  if (!template || typeof template !== 'string') return '';
  const safeParams = params && typeof params === 'object' ? params : {};
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const val = safeParams[key];
    return val === undefined || val === null ? '' : String(val);
  });
}

// Helper function to map legacy settings to accordion format
const mapLegacyToAccordion = (legacySettings) => {
  const firstDefined = (...vals) => {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  };

  // Prefer fraud_rule_configs ``rules[]`` when flat ``ruleN_active`` is missing (v3 blob often omits false).
  const activeFromConfigs = {};
  (legacySettings.rules || []).forEach((row) => {
    if (!row || row.rule_id == null) return;
    const id = Number(row.rule_id);
    const raw = row.is_active != null ? row.is_active : row.active;
    if (raw != null) {
      activeFromConfigs[id] =
        raw !== false && raw !== 'false' && String(raw).toLowerCase() !== 'false';
    }
  });
  const ruleIsActive = (num) => {
    const k = `rule${num}_active`;
    const flat = legacySettings[k];
    if (flat !== undefined && flat !== null) {
      return flat !== false && flat !== 'false' && String(flat).toLowerCase() !== 'false';
    }
    if (activeFromConfigs[num] !== undefined) return activeFromConfigs[num];
    return true;
  };

  const getExclusions = (ruleNum) => {
    const num = ruleNum.toString().replace('.', '_');
    const rowEx = (legacySettings.rules || []).find((x) => Number(x.rule_id) === Number(ruleNum));
    const dbEx = (rowEx && rowEx.exclusions && typeof rowEx.exclusions === 'object') ? rowEx.exclusions : {};
    const maxRakeFlag = dbEx.max_rake_to_flag;
    const hasWhaleBand =
      maxRakeFlag !== undefined && maxRakeFlag !== null && String(maxRakeFlag).trim() !== '';
    return {
      ignoreMicroSessionsMinHands: firstDefined(
        dbEx.min_hands,
        legacySettings[`r${num}_excl_min_Hands`],
        legacySettings[`rule${num}_min_hands`]
      ),
      global_roi_from: exclusionRoiFromDb(
        firstDefined(
          dbEx.global_roi_from,
          dbEx.roi_range && dbEx.roi_range.from,
          legacySettings[`r${num}_excl_min_Roi`]
        )
      ),
      global_roi_to: exclusionRoiFromDb(
        firstDefined(
          dbEx.global_roi_to,
          dbEx.roi_range && dbEx.roi_range.to,
          legacySettings[`r${num}_excl_max_Roi`]
        )
      ),
      globalWinRatePct: {
        from: exclusionRoiFromDb(
          firstDefined(
            dbEx.win_rate_range && dbEx.win_rate_range.from,
            legacySettings[`r${num}_excl_win_rate_from`]
          )
        ),
        to: exclusionRoiFromDb(
          firstDefined(
            dbEx.win_rate_range && dbEx.win_rate_range.to,
            legacySettings[`r${num}_excl_win_rate_to`]
          )
        ),
      },
      totalHands: {
        from: firstDefined(
          dbEx.total_hands_range && dbEx.total_hands_range.from,
          legacySettings[`r${num}_excl_total_hands_from`]
        ),
        to: firstDefined(
          dbEx.total_hands_range && dbEx.total_hands_range.to,
          legacySettings[`r${num}_excl_total_hands_to`]
        ),
      },
      netProfit: {
        from: firstDefined(
          dbEx.profit_range && dbEx.profit_range.from,
          legacySettings[`r${num}_excl_min_Profit`]
        ),
        to: firstDefined(
          dbEx.profit_range && dbEx.profit_range.to,
          legacySettings[`r${num}_excl_max_Profit`]
        ),
      },
      // Prefer persisted rake_range (from+to); legacy max_rake_to_flag used a fake 999999 "to" in the UI.
      lifetimeRake: (() => {
        const rr = dbEx.rake_range;
        if (rr && typeof rr === 'object') {
          return {
            from: firstDefined(rr.from, legacySettings[`r${num}_excl_min_Rake`]),
            to: firstDefined(rr.to, legacySettings[`r${num}_excl_max_Rake`]),
          };
        }
        return {
          from: firstDefined(
            hasWhaleBand ? maxRakeFlag : undefined,
            dbEx.rake_floor,
            legacySettings[`r${num}_excl_min_Rake`]
          ),
          to: firstDefined(
            hasWhaleBand ? 999999 : undefined,
            legacySettings[`r${num}_excl_max_Rake`]
          ),
        };
      })(),
    };
  };

  const paramFromRules = (rid, key) => {
    const row = (legacySettings.rules || []).find((x) => Number(x.rule_id) === Number(rid));
    const p = row && row.parameters;
    if (p && Object.prototype.hasOwnProperty.call(p, key) && p[key] !== '' && p[key] != null) return p[key];
    return undefined;
  };

  const numOr = (candidates, fallback) => {
    for (const v of candidates) {
      if (v !== undefined && v !== null && v !== '') return Number(v);
    }
    return fallback;
  };

  /** Default weights — must match fraud_rule_config_schema.FRAUD_RULES_META. */
  const DEFAULT_FRAUD_RULE_WEIGHTS = { 1: 35, 2: 35, 3: 35, 4: 35, 5: 35 };
  const dw = (ruleNum) =>
    DEFAULT_FRAUD_RULE_WEIGHTS[ruleNum] !== undefined ? DEFAULT_FRAUD_RULE_WEIGHTS[ruleNum] : 35;

  const rules = [];

  rules.push({
    id: 'rule1',
    name: 'Cash margin — new account',
    baseScore: numOr([legacySettings.rule1_score, legacySettings.ruleWeights?.rule1], dw(1)),
    active: ruleIsActive(1),
    riskLevel: 'Medium Risk',
    specific: {
      min_cash_margin_pct:
        paramFromRules(1, 'min_cash_margin_pct')
        ?? paramFromRules(1, 'burner_roi_threshold')
        ?? legacySettings.burnerMinRoiPct
        ?? '',
      min_cash_total_bets: paramFromRules(1, 'min_cash_total_bets') ?? '',
    },
    exclusions: getExclusions(1),
  });

  rules.push({
    id: 'rule2',
    name: 'Major income — % Win spike (new account)',
    baseScore: numOr([legacySettings.rule2_score, legacySettings.ruleWeights?.rule2], dw(2)),
    active: ruleIsActive(2),
    riskLevel: 'Medium Risk',
    specific: {
      major_max_age_days:
        paramFromRules(2, 'major_max_age_days') ?? paramFromRules(2, 'max_age_days') ?? '',
      min_major_pct_win: paramFromRules(2, 'min_major_pct_win') ?? '',
      min_major_session_win: paramFromRules(2, 'min_major_session_win') ?? '',
    },
    exclusions: getExclusions(2),
  });

  rules.push({
    id: 'rule3',
    name: 'Common games — Twister overlap',
    baseScore: numOr([legacySettings.rule3_score, legacySettings.ruleWeights?.rule3], dw(3)),
    active: ruleIsActive(3),
    riskLevel: 'Medium Risk',
    specific: {
      min_common_tournaments: paramFromRules(3, 'min_common_tournaments') ?? '',
      min_overlap_pct: paramFromRules(3, 'min_overlap_pct') ?? paramFromRules(3, 'min_pct_either') ?? '',
    },
    exclusions: getExclusions(3),
  });

  rules.push({
    id: 'rule4',
    name: 'Common games — MTT overlap',
    baseScore: numOr([legacySettings.rule4_score, legacySettings.ruleWeights?.rule4], dw(4)),
    active: ruleIsActive(4),
    riskLevel: 'Medium Risk',
    specific: {
      min_common_tournaments: paramFromRules(4, 'min_common_tournaments') ?? '',
      min_overlap_pct: paramFromRules(4, 'min_overlap_pct') ?? paramFromRules(4, 'min_pct_either') ?? '',
    },
    exclusions: getExclusions(4),
  });

  rules.push({
    id: 'rule5',
    name: 'Common games — SNG overlap',
    baseScore: numOr([legacySettings.rule5_score, legacySettings.ruleWeights?.rule5], dw(5)),
    active: ruleIsActive(5),
    riskLevel: 'Medium Risk',
    specific: {
      min_common_tournaments: paramFromRules(5, 'min_common_tournaments') ?? '',
      min_overlap_pct: paramFromRules(5, 'min_overlap_pct') ?? paramFromRules(5, 'min_pct_either') ?? '',
    },
    exclusions: getExclusions(5),
  });

  // Single source of truth: each row from ``legacySettings.rules`` (GET /api/collusion/rule-settings)
  // replaces hand-built defaults for that rule_id — parameters, exclusions via getExclusions, weight, name, template.
  const storedRowByRuleId = {};
  (legacySettings.rules || []).forEach((row) => {
    if (row == null || row.rule_id == null) return;
    const id = Number(row.rule_id);
    if (!Number.isNaN(id)) storedRowByRuleId[id] = row;
  });
  rules.forEach((rule) => {
    const num = parseInt(String(rule.id).replace('rule', ''), 10);
    if (Number.isNaN(num)) return;
    const row = storedRowByRuleId[num];
    if (!row) return;

    if (row.rule_name || row.name) rule.name = row.rule_name || row.name;
    const dt = row.description_template || row.dynamic_description;
    if (dt !== undefined && dt !== null && String(dt).trim() !== '') {
      rule.dynamicDescription = String(dt);
    }
    if (row.weight != null && row.weight !== '') {
      const w = Number(row.weight);
      if (!Number.isNaN(w)) rule.baseScore = w;
    }
    if (row.parameters && typeof row.parameters === 'object') {
      rule.specific = normalizeRuleSpecificForUi(num, row.parameters);
    }
    rule.exclusions = getExclusions(num);
  });

  rules.sort((a, b) => {
    const na = parseInt(String(a.id).replace('rule', ''), 10);
    const nb = parseInt(String(b.id).replace('rule', ''), 10);
    return (Number.isNaN(na) ? 0 : na) - (Number.isNaN(nb) ? 0 : nb);
  });

  return { rules };
};

/** Map accordion exclusion rows to engine ``fraud_rule_configs.exclusions`` (rake_floor, min_hands, ranges). */
function buildEngineExclusions(rule) {
  const ex = {};
  const im = rule.exclusions?.ignoreMicroSessionsMinHands;
  if (im !== '' && im !== undefined && im !== null) {
    const n = Number(im);
    if (!Number.isNaN(n)) ex.min_hands = n;
  }
  // Global buy-in ROI band — always emit these keys for API/engine merge (null = unset, never "").
  ex.global_roi_from = exclusionRoiToPayload(rule.exclusions?.global_roi_from);
  ex.global_roi_to = exclusionRoiToPayload(rule.exclusions?.global_roi_to);
  const np = rule.exclusions?.netProfit;
  if (np) {
    const profit_range = {};
    if (np.from !== '' && np.from !== undefined && np.from !== null) {
      const n = Number(np.from);
      if (!Number.isNaN(n)) profit_range.from = n;
    }
    if (np.to !== '' && np.to !== undefined && np.to !== null) {
      const n = Number(np.to);
      if (!Number.isNaN(n)) profit_range.to = n;
    }
    if (Object.keys(profit_range).length) ex.profit_range = profit_range;
  }
  const lr = rule.exclusions?.lifetimeRake;
  if (lr && lr.from !== '' && lr.from !== undefined && lr.from !== null) {
    const nf = Number(lr.from);
    const ntRaw = lr.to;
    const nt = ntRaw === '' || ntRaw === undefined || ntRaw === null ? null : Number(ntRaw);
    if (!Number.isNaN(nf)) {
      // Two-sided band: persist full {from,to} so reload matches the form (engine: rake_range).
      if (nt != null && !Number.isNaN(nt)) {
        ex.rake_range = { from: nf, to: nt };
      } else {
        ex.rake_floor = nf;
      }
    }
  }
  const gwr = rule.exclusions?.globalWinRatePct;
  if (gwr && typeof gwr === 'object') {
    const win_rate_range = {};
    if (gwr.from !== '' && gwr.from !== undefined && gwr.from !== null) {
      const n = Number(gwr.from);
      if (!Number.isNaN(n)) win_rate_range.from = n;
    }
    if (gwr.to !== '' && gwr.to !== undefined && gwr.to !== null) {
      const n = Number(gwr.to);
      if (!Number.isNaN(n)) win_rate_range.to = n;
    }
    if (Object.keys(win_rate_range).length) ex.win_rate_range = win_rate_range;
  }
  const th = rule.exclusions?.totalHands;
  if (th && typeof th === 'object') {
    const total_hands_range = {};
    if (th.from !== '' && th.from !== undefined && th.from !== null) {
      const n = Number(th.from);
      if (!Number.isNaN(n)) total_hands_range.from = n;
    }
    if (th.to !== '' && th.to !== undefined && th.to !== null) {
      const n = Number(th.to);
      if (!Number.isNaN(n)) total_hands_range.to = n;
    }
    if (Object.keys(total_hands_range).length) ex.total_hands_range = total_hands_range;
  }
  return ex;
}

// Helper function to map accordion format back to legacy format
const mapAccordionToLegacy = (accordionSettings, caseTriggerScoreValue = 100) => {
  const legacy = {
    caseTriggerScore: caseTriggerScoreValue,
    globalRequirePaidActivity: true,
    globalPaidActivityEpsilon: 1e-6,
    weights: {},
    ruleWeights: {},
  };

  accordionSettings.rules.forEach((rule) => {
    const ruleNum = rule.id.replace('rule', '');
    legacy[`rule${ruleNum}_active`] = rule.active;
    legacy[`rule${ruleNum}_score`] = rule.baseScore;

     // Persist rule weights for the dynamic engine (keyed by rule id, e.g. "rule1")
     legacy.ruleWeights[rule.id] = rule.baseScore;
    legacy[`${rule.id}_weight`] = rule.baseScore;

    Object.entries(rule.specific || {}).forEach(([key, value]) => {
      legacy[key] = value;
    });
    if (rule.id === 'rule1' && rule.specific) {
      if (rule.specific.min_cash_margin_pct != null && rule.specific.min_cash_margin_pct !== '') {
        legacy.min_cash_margin_pct = rule.specific.min_cash_margin_pct;
        legacy.burner_roi_threshold = rule.specific.min_cash_margin_pct;
      }
      if (rule.specific.min_cash_total_bets != null && rule.specific.min_cash_total_bets !== '') {
        legacy.min_cash_total_bets = rule.specific.min_cash_total_bets;
      }
    }

    // Map exclusions (legacy flat mirrors for v3 blob; canonical copy is rules[].exclusions)
    const ex = rule.exclusions || {};
    const imh = ex.ignoreMicroSessionsMinHands;
    if (imh !== undefined && imh !== null && imh !== '') {
      legacy[`r${ruleNum}_excl_min_Hands`] = imh;
      legacy[`rule${ruleNum}_min_hands`] = imh;
    }
    const groiFrom = exclusionRoiToPayload(ex.global_roi_from);
    const groiTo = exclusionRoiToPayload(ex.global_roi_to);
    if (groiFrom !== null) {
      legacy[`r${ruleNum}_excl_min_Roi`] = groiFrom;
    }
    if (groiTo !== null) {
      legacy[`r${ruleNum}_excl_max_Roi`] = groiTo;
    }
    const gwp = ex.globalWinRatePct;
    if (gwp && typeof gwp === 'object') {
      if (gwp.from !== undefined && gwp.from !== null && gwp.from !== '') {
        legacy[`r${ruleNum}_excl_win_rate_from`] = gwp.from;
      }
      if (gwp.to !== undefined && gwp.to !== null && gwp.to !== '') {
        legacy[`r${ruleNum}_excl_win_rate_to`] = gwp.to;
      }
    }
    const thR = ex.totalHands;
    if (thR && typeof thR === 'object') {
      if (thR.from !== undefined && thR.from !== null && thR.from !== '') {
        legacy[`r${ruleNum}_excl_total_hands_from`] = thR.from;
      }
      if (thR.to !== undefined && thR.to !== null && thR.to !== '') {
        legacy[`r${ruleNum}_excl_total_hands_to`] = thR.to;
      }
    }
    const np = ex.netProfit;
    if (np && typeof np === 'object') {
      if (np.from) legacy[`r${ruleNum}_excl_min_Profit`] = np.from;
      if (np.to) legacy[`r${ruleNum}_excl_max_Profit`] = np.to;
    }
    const lr = ex.lifetimeRake;
    if (lr && typeof lr === 'object') {
      if (lr.from) legacy[`r${ruleNum}_excl_min_Rake`] = lr.from;
      if (lr.to) legacy[`r${ruleNum}_excl_max_Rake`] = lr.to;
    }

  });

  // Persist per-rule parameters + active flags into ``fraud_rule_configs`` (PUT handler merges when non-empty).
  // Without this, only the v3 blob is updated and the engine merge overwrites custom values from stale table JSON.
  legacy.rules = accordionSettings.rules
    .map((rule) => {
      const ruleNum = parseInt(String(rule.id).replace('rule', ''), 10);
      if (Number.isNaN(ruleNum)) return null;
      const exclusions = buildEngineExclusions(rule);
      const w = Number(rule.baseScore);
      return {
        rule_id: ruleNum,
        is_active: !!rule.active,
        active: !!rule.active,
        // Preserve weight 0 (several rules use 0 in FRAUD_RULES_META); do not use || 50.
        weight: Number.isFinite(w) ? w : 50,
        parameters: { ...(rule.specific || {}) },
        exclusions,
      };
    })
    .filter(Boolean);

  return legacy;
};

export default function RuleSettings({ onSave, activeCategory }) {
  const [legacySettings, setLegacySettings] = useState(INITIAL_SETTINGS);
  const [accordionSettings, setAccordionSettings] = useState(() => mapLegacyToAccordion(INITIAL_SETTINGS));
  const [saved, setSaved] = useState(false);
  const [requirePaidActivity, setRequirePaidActivity] = useState(true);
  const [paidActivityEpsilon, setPaidActivityEpsilon] = useState(1e-6);
  const [caseTriggerScore, setCaseTriggerScore] = useState(100);

  useEffect(() => {
    fetch(API + '/api/collusion/rule-settings')
      .then((r) => r.json())
      .then((data) => {
        const merged = { ...INITIAL_SETTINGS, ...data, weights: { ...(data.weights || {}) } };
        setLegacySettings(merged);
        setAccordionSettings(mapLegacyToAccordion(merged));
        if (data.globalRequirePaidActivity === false) setRequirePaidActivity(false);
        else setRequirePaidActivity(true);
        const eps = data.globalPaidActivityEpsilon;
        if (eps !== undefined && eps !== null && !Number.isNaN(Number(eps))) {
          setPaidActivityEpsilon(Number(eps));
        }
        const ct = data.caseTriggerScore;
        if (ct !== undefined && ct !== null && !Number.isNaN(Number(ct))) {
          setCaseTriggerScore(Number(ct));
        }
      }).catch(() => {});
  }, []);

  const handleSave = async (newAccordionSettings) => {
    try {
      const legacyFormat = mapAccordionToLegacy(newAccordionSettings, caseTriggerScore);
      legacyFormat.globalRequirePaidActivity = requirePaidActivity;
      legacyFormat.globalPaidActivityEpsilon = paidActivityEpsilon;
      const res = await fetch(API + '/api/collusion/rule-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(legacyFormat),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || res.statusText);
      }
      const data = await res.json();
      const merged = {
        ...INITIAL_SETTINGS,
        ...data,
        weights: { ...(data.weights || {}) },
      };
      setLegacySettings(merged);
      setAccordionSettings(mapLegacyToAccordion(merged));
      const ctSaved = data.caseTriggerScore;
      if (ctSaved !== undefined && ctSaved !== null && !Number.isNaN(Number(ctSaved))) {
        setCaseTriggerScore(Number(ctSaved));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSave && onSave(merged);
    } catch (e) {
      console.error('Failed to save settings:', e);
      alert('Failed to save settings. Check console for details.');
    }
  };

  return (
    <div className="rule-settings card-panel" style={{ maxWidth: '100%' }}>
      <h3 className="triage-subtitle" style={{ marginBottom: 8, fontSize: '1.05rem' }}>
        Enterprise rule settings (fraud_rule_configs)
      </h3>
      <div className="card-panel fraud-rule-global-settings">
        <div className="fraud-rule-global-settings__title">Case quality (global)</div>
        <p className="fraud-rule-global-settings__hint">
          When enabled, the engine does not open or persist cases for players with no measurable cash rake and no MTT fees
          (after the scan loads stats). Per-rule &quot;Lifetime Rake ($)&quot; minimum maps to <code>rake_floor</code> (skip players below that rake).
        </p>
        <label className="fraud-rule-global-settings__check">
          <input
            type="checkbox"
            checked={requirePaidActivity}
            onChange={(e) => setRequirePaidActivity(e.target.checked)}
          />
          Require paid activity (rake + tournament fees &gt; epsilon)
        </label>
        <label className="fraud-rule-global-settings__epsilon">
          Epsilon (min currency units)
          <input
            type="number"
            step="any"
            min={0}
            value={paidActivityEpsilon}
            onChange={(e) => setPaidActivityEpsilon(Number(e.target.value))}
            className="fraud-rule-global-settings__input-num"
          />
        </label>
        <div className="fraud-rule-global-settings__score-block">
          <div className="fraud-rule-global-settings__title">Minimum case score (persist at or above)</div>
          <p className="fraud-rule-global-settings__hint">
            Maps to engine <code>caseTriggerScore</code>. After each scan, only players with final{' '}
            <strong>risk score</strong> ≥ this value are written to the investigation queue (subject to paid-activity
            rules). With a single configured rule, the score is that rule&apos;s weight when it fires (each rule counts
            once per scan even if it triggers multiple times).
          </p>
          <input
            type="number"
            min={0}
            max={50000}
            step={5}
            value={caseTriggerScore}
            onChange={(e) => setCaseTriggerScore(Number(e.target.value))}
            className="fraud-rule-global-settings__input-num fraud-rule-global-settings__input-num--wide"
          />
        </div>
      </div>
      {saved && (
        <div className="fraud-rule-saved-banner" role="status">
          Settings saved.
        </div>
      )}
      <FraudEngineConfigAccordion
        initialSettings={accordionSettings}
        onSave={handleSave}
      />
    </div>
  );
}
