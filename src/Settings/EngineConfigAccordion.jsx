import React, { useState, useEffect } from "react";

/**
 * Tier for the rule's configured weight (points added to case score when this rule fires).
 * This is not a live "how dangerous is the player" score — that comes from the investigation case total.
 */
const computeWeightTier = (baseScore) => {
  const s = Number(baseScore);
  const v = Number.isFinite(s) ? s : 0;
  if (v >= 120) return "Heavy weight";
  if (v >= 60) return "Moderate weight";
  return "Light weight";
};

/** Weight band pills — tuned for dark rule cards (high contrast on slate header). */
const weightTierStyles = {
  "Heavy weight": { bg: "rgba(127, 29, 29, 0.55)", fg: "#fecaca", border: "1px solid rgba(248, 113, 113, 0.4)" },
  "Moderate weight": { bg: "rgba(120, 80, 20, 0.5)", fg: "#fde68a", border: "1px solid rgba(251, 191, 36, 0.35)" },
  "Light weight": { bg: "rgba(55, 48, 120, 0.55)", fg: "#c4b5fd", border: "1px solid rgba(167, 139, 250, 0.4)" },
};

const ruleDescriptions = {
  rule1:
    "Flags players when cash margin (Σ P/L ÷ Σ bets) × 100 from cash sessions is ≥ {{minCashMarginPct}}% and Σ bets ≥ {{minCashTotalBets}} (no signup-age filter).",
  rule2:
    'Detects new accounts when Primary_Major_income_sessions warehouse "% Win" > {{minMajorPctWin}}, Win ≥ {{minMajorSessionWin}}, signup within {{majorMaxAgeDays}} days (Primary_Account_information).',
  rule3:
    "Twister-only overlap on Primary_SNG_Twister_and_MTT: ≥{{minCommonTournaments}} shared distinct tournament codes and ≥{{minOverlapPct}}% overlap for both players.",
  rule4:
    "MTT-only overlap (same counting pipeline as Rule 3): ≥{{minCommonTournaments}} shared distinct codes and ≥{{minOverlapPct}}% for either player.",
  rule5:
    "SNG-only overlap (same counting pipeline as Rule 3): ≥{{minCommonTournaments}} shared distinct codes and ≥{{minOverlapPct}}% for either player.",
};

const renderDescription = (rule) => {
  const template = ruleDescriptions[rule.id];
  if (!template) return "";
  const specific = rule.specific || {};
  const valueOr = (val, fallback) =>
    val === undefined || val === null || val === "" ? fallback : val;
  if (rule.id === "rule1") {
    const minCashMarginPct = valueOr(specific.min_cash_margin_pct ?? specific.burner_roi_threshold, 50);
    const minCashTotalBets = valueOr(specific.min_cash_total_bets, 100);
    return template
      .replace("{{minCashMarginPct}}", String(minCashMarginPct))
      .replace("{{minCashTotalBets}}", String(minCashTotalBets));
  }
  if (rule.id === "rule2") {
    const majorMaxAgeDays = valueOr(specific.major_max_age_days ?? specific.max_age_days, 2);
    const minMajorPctWin = valueOr(specific.min_major_pct_win, 500);
    const minMajorSessionWin = valueOr(specific.min_major_session_win, 50);
    return template
      .replace("{{majorMaxAgeDays}}", String(majorMaxAgeDays))
      .replace("{{minMajorPctWin}}", String(minMajorPctWin))
      .replace("{{minMajorSessionWin}}", String(minMajorSessionWin));
  }
  if (rule.id === "rule3" || rule.id === "rule4" || rule.id === "rule5") {
    const minCommonTournaments = valueOr(specific.min_common_tournaments, 5);
    const minOverlapPct = valueOr(specific.min_overlap_pct ?? specific.min_pct_either, 30);
    return template
      .replace("{{minCommonTournaments}}", String(minCommonTournaments))
      .replace("{{minOverlapPct}}", String(minOverlapPct));
  }
  return "";
};

/** Substitute {tokens} using fraud_rule_configs.parameters (same as RuleSettings.renderDescription). */
function fillCurlyTemplate(template, params) {
  if (!template || typeof template !== "string") return "";
  const safe = params && typeof params === "object" ? params : {};
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = safe[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/** Strip legacy "Rule N —" / "Rule N:" prefixes so the card shows one canonical `Rule {id}: title`. */
const cleanRuleDisplayTitle = (name) => {
  if (name == null || typeof name !== "string") return "";
  let s = name.trim();
  s = s.replace(/^Rule\s+\d+\s*[—–-]\s*/i, "").trim();
  s = s.replace(/^Rule\s+\d+\s*:\s*/i, "").trim();
  return s || name.trim();
};

const _rangeHint = (label, r) => {
  if (!r || typeof r !== "object") return null;
  const f = r.from;
  const t = r.to;
  const hasF = f !== "" && f != null;
  const hasT = t !== "" && t != null;
  if (!hasF && !hasT) return null;
  return `${label} ${hasF ? f : "…"}–${hasT ? t : "…"}`;
};

/** Appends a plain-English line for filled exclusion fields (matches blue-box summary). */
const formatExclusionsHint = (exclusions) => {
  if (!exclusions || typeof exclusions !== "object") return "";
  const parts = [];
  const im = exclusions.ignoreMicroSessionsMinHands;
  if (im !== "" && im != null && String(im).trim() !== "") {
    parts.push(`ignore players under ${im} lifetime hands`);
  }
  const roi = _rangeHint("Cash margin %", {
    from: exclusions.global_roi_from,
    to: exclusions.global_roi_to,
  });
  if (roi) parts.push(roi);
  const wr = _rangeHint("Win rate %", exclusions.globalWinRatePct);
  if (wr) parts.push(wr);
  const th = _rangeHint("Total hands", exclusions.totalHands);
  if (th) parts.push(th);
  const np = _rangeHint("Net profit ($)", exclusions.netProfit);
  if (np) parts.push(np);
  const lr = _rangeHint("Lifetime rake ($)", exclusions.lifetimeRake);
  if (lr) parts.push(lr);
  if (!parts.length) return "";
  return `Noise filters: ${parts.join("; ")}.`;
};

const val = (x, fb) => (x === undefined || x === null || x === "" ? fb : x);

function buildHowItRunsSteps(rule) {
  const s = rule.specific || {};
  const id = rule.id;
  if (id === "rule1") {
    const minMargin = val(s.min_cash_margin_pct ?? s.burner_roi_threshold, 50);
    const minBets = val(s.min_cash_total_bets, 100);
    return [
      <>Aggregate <strong>Primary_Cash_table_session_summary</strong> per player: Σ P/L and Σ Total bets.</>,
      <>
        Cash margin % = (Σ Total profit/loss ÷ Σ Total bets) × 100. Flag when Σ bets ≥ <strong>{minBets}</strong> and
        margin ≥ <strong>{minMargin}</strong>% (no account-age filter).
      </>,
    ];
  }
  if (id === "rule2") {
    const maxAge = val(s.major_max_age_days ?? s.max_age_days, 2);
    const minPct = val(s.min_major_pct_win, 500);
    const minWin = val(s.min_major_session_win, 50);
    return [
      <>
        Read <strong>Primary_Major_income_sessions</strong> and join{" "}
        <strong>Primary_Account_information</strong> on player code for signup age.
      </>,
      <>
        Flag when warehouse <strong>&quot;% Win&quot;</strong> &gt; <strong>{minPct}</strong>,{" "}
        <strong>Win</strong> ≥ <strong>{minWin}</strong>, and signup is within <strong>{maxAge}</strong>{" "}
        days.
      </>,
    ];
  }
  if (id === "rule3") {
    const minC = val(s.min_common_tournaments, 5);
    const minO = val(s.min_overlap_pct ?? s.min_pct_either, 30);
    return [
      <>
        Data: <strong>Primary_SNG_Twister_and_MTT</strong> — only rows where{" "}
        <strong>Tournament type</strong> = Twister (after trim).
      </>,
      <>
        Lifetime <strong>distinct tournament codes</strong> per player; count shared codes with each other player (pair).
      </>,
      <>
        Flag when shared count ≥ <strong>{minC}</strong> and <strong>both</strong> players’ overlap % (shared ÷ that
        player’s distinct tournaments in Twister × 100) ≥ <strong>{minO}</strong>%.
      </>,
      <>
        <strong>What a case means:</strong> Twister volume is concentrated with the same partner versus these floors
        (investigator triage).
      </>,
    ];
  }
  if (id === "rule4") {
    const minC = val(s.min_common_tournaments, 5);
    const minO = val(s.min_overlap_pct ?? s.min_pct_either, 30);
    return [
      <>Same pipeline as Rule 3, but filter <strong>Tournament type = MTT</strong> only.</>,
      <>
        Thresholds: ≥ <strong>{minC}</strong> shared distinct MTT tournament codes and ≥ <strong>{minO}</strong>% overlap
        for either player.
      </>,
      <>
        <strong>What a case means:</strong> MTT volume is concentrated with the same partner vs configured floors.
      </>,
    ];
  }
  if (id === "rule5") {
    const minC = val(s.min_common_tournaments, 5);
    const minO = val(s.min_overlap_pct ?? s.min_pct_either, 30);
    return [
      <>Same pipeline as Rule 3, but filter <strong>Tournament type = SNG</strong> only.</>,
      <>
        Thresholds: ≥ <strong>{minC}</strong> shared distinct SNG tournament codes and ≥ <strong>{minO}</strong>% overlap
        for either player.
      </>,
      <>
        <strong>What a case means:</strong> SNG volume is concentrated with the same partner vs configured floors.
      </>,
    ];
  }
  return [<>See parameters and exclusions below.</>];
}

function HowThisRuleRuns({ rule }) {
  const steps = buildHowItRunsSteps(rule);
  const noise = formatExclusionsHint(rule.exclusions);
  const dynRaw = (rule.dynamicDescription || "").trim();
  const dynFilled = dynRaw ? fillCurlyTemplate(rule.dynamicDescription, rule.specific || {}) : "";
  return (
    <div className="fraud-rule-how-it-runs">
      <div className="fraud-rule-how-it-runs__title">How this rule runs</div>
      {dynFilled ? (
        <p
          className="fraud-rule-how-it-runs__dynamic"
          style={{ fontSize: "11px", color: "#475569", margin: "0 0 10px 0", lineHeight: 1.45 }}
        >
          {dynFilled}
        </p>
      ) : null}
      <ol className="fraud-rule-how-it-runs__list">
        {steps.map((node, i) => (
          <li key={i}>{node}</li>
        ))}
      </ol>
      {noise ? <p className="fraud-rule-how-it-runs__noise">{noise}</p> : null}
    </div>
  );
}

export const FraudEngineConfigAccordion = ({
  initialSettings,
  onSave,
}) => {
  const [settings, setSettings] = useState({
    ...initialSettings,
    rules: (initialSettings.rules || []).map((r) => ({
      ...r,
      riskLevel: computeWeightTier(r.baseScore),
    })),
  });

  const [openRuleIds, setOpenRuleIds] = useState(() => new Set());

  useEffect(() => {
    setSettings({
      ...initialSettings,
      rules: (initialSettings.rules || []).map((r) => ({
        ...r,
        riskLevel: computeWeightTier(r.baseScore),
      })),
    });
  }, [initialSettings]);

  const toggleOpen = (ruleId) => {
    setOpenRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  const updateRule = (ruleId, partial) => {
    setSettings((prev) => ({
      ...prev,
      rules: prev.rules.map((r) =>
        r.id === ruleId
          ? {
              ...r,
              ...partial,
              riskLevel:
                partial.baseScore !== undefined
                  ? computeWeightTier(partial.baseScore)
                  : r.riskLevel,
            }
          : r
      ),
    }));
  };

  const updateRuleSpecific = (ruleId, key, value) => {
    setSettings((prev) => ({
      ...prev,
      rules: prev.rules.map((r) =>
        r.id === ruleId
          ? { ...r, specific: { ...r.specific, [key]: value } }
          : r
      ),
    }));
  };

  const updateExclusions = (ruleId, updater) => {
    setSettings((prev) => ({
      ...prev,
      rules: prev.rules.map((r) =>
        r.id === ruleId ? { ...r, exclusions: updater(r.exclusions || {}) } : r
      ),
    }));
  };

  const handleSave = () => {
    onSave(settings);
  };

  return (
    <div className="fraud-engine-accordion-root" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {settings.rules.map((rule) => {
        const isOpen = openRuleIds.has(rule.id);
        const ruleNumber = rule.id.replace("rule", "");
        const title = cleanRuleDisplayTitle(rule.name);
        const displayName = `Rule ${ruleNumber}: ${title || "Untitled"}`;
        return (
          <div
            key={rule.id}
            className="fraud-rule-accordion-card"
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: '5px',
              boxShadow: '0 1px 0 rgba(0,0,0,0.04)',
              backgroundColor: '#ffffff',
              overflow: 'hidden',
            }}
          >
            {/* Header: do not nest inputs inside <button> (invalid HTML; breaks checkbox / saves in some browsers). */}
            <div
              className="fraud-rule-accordion-header"
              style={{
                display: 'flex',
                alignItems: 'stretch',
                width: '100%',
                backgroundColor: isOpen ? '#f8fafc' : '#ffffff',
              }}
            >
              <button
                type="button"
                onClick={() => toggleOpen(rule.id)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  padding: '8px 10px',
                  backgroundColor: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
                  <span style={{ fontWeight: '600', color: '#1f2937' }}>
                    {displayName}
                  </span>
                  <span
                    style={{ fontSize: '11px', color: '#6b7280' }}
                    title="Points this rule adds to a player’s case score when it triggers (summed with other rules). Player-level risk is the total case score after a scan."
                  >
                    | Weight: {rule.baseScore ?? rule.weight ?? 50}
                  </span>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: '600',
                      padding: '2px 8px',
                      borderRadius: '9999px',
                      backgroundColor: weightTierStyles[rule.riskLevel]?.bg ?? 'rgba(51, 65, 85, 0.5)',
                      color: weightTierStyles[rule.riskLevel]?.fg ?? '#e2e8f0',
                      border: weightTierStyles[rule.riskLevel]?.border ?? '1px solid rgba(148, 163, 184, 0.35)',
                    }}
                    title="Band for this rule’s configured weight only — not a live player threat rating."
                  >
                    {rule.riskLevel}
                  </span>
                </div>
                <span style={{ color: '#9ca3af', fontSize: '12px', flexShrink: 0 }}>
                  {isOpen ? "▾" : "▸"}
                </span>
              </button>
              <div
                role="group"
                aria-label="Rule weight and active toggle"
                className="fraud-rule-accordion-header-tools"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 10px',
                  borderLeft: '1px solid #e2e8f0',
                  flexShrink: 0,
                  backgroundColor: isOpen ? '#f8fafc' : '#ffffff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span style={{ fontSize: '10px', color: '#64748b', whiteSpace: 'nowrap' }}>Weight</span>
                  <input
                    type="number"
                    style={{
                      width: '56px',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      padding: '3px 6px',
                      fontSize: '11px',
                      textAlign: 'right',
                      boxSizing: 'border-box',
                    }}
                    value={rule.baseScore}
                    onChange={(e) =>
                      updateRule(rule.id, {
                        baseScore: Number(e.target.value) || 0,
                      })
                    }
                  />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#4b5563', cursor: 'pointer' }}>
                  <span>{rule.active ? "Active" : "Inactive"}</span>
                  <input
                    type="checkbox"
                    checked={!!rule.active}
                    onChange={(e) =>
                      updateRule(rule.id, { active: e.target.checked })
                    }
                    style={{ width: '16px', height: '16px' }}
                  />
                </label>
              </div>
            </div>

            {/* Accordion Body */}
            {isOpen && (
              <div
                className="fraud-rule-accordion-body"
                style={{
                  borderTop: '1px solid #e2e8f0',
                  padding: '10px 12px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <HowThisRuleRuns rule={rule} />

                {/* Parameters — rule-specific thresholds (saved to fraud_rule_configs.parameters) */}
                <div
                  className="fraud-rule-accordion-params"
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    backgroundColor: '#ffffff',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ padding: '8px 12px 10px' }}>
                    <h4
                      className="fraud-rule-accordion-section-title"
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        color: '#0f172a',
                        margin: '0 0 8px 0',
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      Parameters
                    </h4>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                        gap: '10px',
                        fontSize: '11px',
                      }}
                    >
                    {rule.id === 'rule1' && (
                      <>
                        <div>
                          <label style={{ display: 'block', color: '#4b5563', marginBottom: '4px' }}>
                            Min cash margin %
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 8px' }}
                            value={rule.specific.min_cash_margin_pct ?? rule.specific.burner_roi_threshold ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "min_cash_margin_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', color: '#4b5563', marginBottom: '4px' }}>
                            Min Σ Total bets ($)
                          </label>
                          <input
                            type="number"
                            step="1"
                            min="0"
                            style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: '4px', padding: '4px 8px' }}
                            value={rule.specific.min_cash_total_bets ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "min_cash_total_bets",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      </>
                    )}
                    {(rule.id === "rule3" || rule.id === "rule4" || rule.id === "rule5") && (
                      <>
                        <div>
                          <label style={{ display: "block", color: "#4b5563", marginBottom: "4px" }}>
                            Min shared distinct tournaments (count)
                          </label>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px 8px" }}
                            value={rule.specific.min_common_tournaments ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "min_common_tournaments",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                        <div>
                          <label style={{ display: "block", color: "#4b5563", marginBottom: "4px" }}>
                            {rule.id === "rule3"
                              ? "Min overlap % (both players)"
                              : "Min overlap % (either player)"}
                          </label>
                          <input
                            type="number"
                            step={0.1}
                            min={0}
                            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px 8px" }}
                            title={
                              rule.id === "rule3"
                                ? "Rule 3: both players must have at least this % of their distinct Twister tournaments shared with the partner."
                                : "Percent of that player’s distinct tournaments in this format (MTT / SNG) that are shared with the partner; either player meeting the floor is enough."
                            }
                            value={rule.specific.min_overlap_pct ?? rule.specific.min_pct_either ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "min_overlap_pct",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      </>
                    )}
                    {rule.id === "rule2" && (
                      <>
                        <div>
                          <label style={{ display: "block", color: "#4b5563", marginBottom: "4px" }}>
                            Max account age (days)
                          </label>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px 8px" }}
                            value={rule.specific.major_max_age_days ?? rule.specific.max_age_days ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "major_max_age_days",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                        <div>
                          <label style={{ display: "block", color: "#4b5563", marginBottom: "4px" }}>
                            Min % Win (warehouse column)
                          </label>
                          <input
                            type="number"
                            step={0.1}
                            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px 8px" }}
                            value={rule.specific.min_major_pct_win ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "min_major_pct_win",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                        <div>
                          <label style={{ display: "block", color: "#4b5563", marginBottom: "4px" }}>
                            Min session Win
                          </label>
                          <input
                            type="number"
                            step={1}
                            min={0}
                            style={{ width: "100%", border: "1px solid #d1d5db", borderRadius: "4px", padding: "4px 8px" }}
                            value={rule.specific.min_major_session_win ?? ""}
                            onChange={(e) =>
                              updateRuleSpecific(
                                rule.id,
                                "min_major_session_win",
                                e.target.value === "" ? "" : Number(e.target.value)
                              )
                            }
                          />
                        </div>
                      </>
                    )}
                  </div>
                    </div>
                  </div>

                {/* Advanced exclusions — noise filters (saved to fraud_rule_configs.exclusions) */}
                <div
                  className="fraud-rule-accordion-exclusions"
                  style={{
                    borderRadius: '6px',
                    border: '1px solid #e2e8f0',
                    overflow: 'hidden',
                    minWidth: 0,
                    backgroundColor: '#f8fafc',
                  }}
                >
                  <div
                    className="fraud-rule-accordion-exclusions-head"
                    style={{
                      padding: '8px 12px',
                      backgroundColor: '#f1f5f9',
                      borderBottom: '1px solid #e2e8f0',
                    }}
                  >
                    <h4
                      className="fraud-rule-accordion-section-title"
                      style={{
                        fontSize: '11px',
                        fontWeight: 700,
                        color: '#334155',
                        margin: 0,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      Advanced exclusions
                    </h4>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: '10px 12px',
                      minWidth: 0,
                    }}
                  >

                  <div style={{ fontSize: '11px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '8px' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: '2px', color: '#64748b', minWidth: '140px', flex: '0 1 160px' }}>
                      <span>Min hands (ignore micro-sample)</span>
                      <input
                        type="number"
                        style={{
                          width: '100%',
                          maxWidth: '120px',
                          border: '1px solid #cbd5e1',
                          borderRadius: '4px',
                          padding: '4px 8px',
                          boxSizing: 'border-box',
                        }}
                        value={rule.exclusions.ignoreMicroSessionsMinHands ?? ''}
                        onChange={(e) =>
                          updateExclusions(rule.id, (prev) => ({
                            ...prev,
                            ignoreMicroSessionsMinHands: e.target.value === '' ? '' : Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>

                  {/* From/To ranges — minmax(0,1fr) prevents flex overflow clipping (e.g. Net Profit “To”) */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))',
                      gap: '8px 10px',
                      fontSize: '11px',
                      minWidth: 0,
                    }}
                  >
                    <RangeRow
                      label="Cash margin % (excl.)"
                      labelTitle="Optional noise band on ROI-like metric used for exclusions (stored as global_roi_from / global_roi_to). Empty = no bound."
                      fromKey="global_roi_from"
                      toKey="global_roi_to"
                      value={rule.exclusions}
                      onChange={(patch) =>
                        updateExclusions(rule.id, (prev) => ({
                          ...(prev || {}),
                          ...patch,
                        }))
                      }
                    />
                    <RangeRow
                      label="Global Win Rate %"
                      value={rule.exclusions.globalWinRatePct}
                      onChange={(next) =>
                        updateExclusions(rule.id, (prev) => ({
                          ...prev,
                          globalWinRatePct: next,
                        }))
                      }
                    />
                    <RangeRow
                      label="Total Hands"
                      value={rule.exclusions.totalHands}
                      onChange={(next) =>
                        updateExclusions(rule.id, (prev) => ({
                          ...prev,
                          totalHands: next,
                        }))
                      }
                    />
                    <RangeRow
                      label="Net Profit ($)"
                      value={rule.exclusions.netProfit}
                      onChange={(next) =>
                        updateExclusions(rule.id, (prev) => ({
                          ...prev,
                          netProfit: next,
                        }))
                      }
                    />
                    <RangeRow
                      label="Lifetime Rake ($)"
                      value={rule.exclusions.lifetimeRake}
                      onChange={(next) =>
                        updateExclusions(rule.id, (prev) => ({
                          ...prev,
                          lifetimeRake: next,
                        }))
                      }
                    />
                  </div>
                </div>
              </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Global Save Button */}
      <div className="fraud-rule-accordion-footer">
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>
          Save Engine Configuration
        </button>
      </div>
    </div>
  );
};

const RangeRow = ({ label, labelTitle, value, onChange, fromKey = 'from', toKey = 'to' }) => {
  const flatGlobalRoiKeys = fromKey === 'global_roi_from' && toKey === 'global_roi_to';

  const handleChange = (key) => (e) => {
    const raw = e.target.value;
    let stored;
    if (raw === '') {
      stored = null;
    } else {
      const n = Number(raw);
      stored = Number.isNaN(n) ? null : n;
    }
    if (flatGlobalRoiKeys) {
      onChange({ [key]: stored });
      return;
    }
    const base = value && typeof value === 'object' ? { ...value } : {};
    onChange({ ...base, [key]: stored });
  };

  const v = value || {};
  const fromVal = v[fromKey];
  const toVal = v[toKey];

  return (
    <div className="fraud-rule-range-row" style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <div
        className="fraud-rule-range-row__title"
        style={{ color: '#64748b', fontSize: '10px', fontWeight: 600 }}
        title={labelTitle || undefined}
      >
        {label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '6px', minWidth: 0 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span style={{ fontSize: '9px', color: '#94a3b8' }}>From</span>
          <input
            type="number"
            style={{
              width: '100%',
              minWidth: 0,
              boxSizing: 'border-box',
              border: '1px solid #cbd5e1',
              borderRadius: '4px',
              padding: '4px 6px',
              fontSize: '11px',
            }}
            value={fromVal === null || fromVal === undefined ? '' : fromVal}
            onChange={handleChange(fromKey)}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
          <span style={{ fontSize: '9px', color: '#94a3b8' }}>To</span>
          <input
            type="number"
            style={{
              width: '100%',
              minWidth: 0,
              boxSizing: 'border-box',
              border: '1px solid #cbd5e1',
              borderRadius: '4px',
              padding: '4px 6px',
              fontSize: '11px',
            }}
            value={toVal === null || toVal === undefined ? '' : toVal}
            onChange={handleChange(toKey)}
          />
        </label>
      </div>
    </div>
  );
};
