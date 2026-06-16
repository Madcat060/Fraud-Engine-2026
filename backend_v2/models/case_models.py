"""
Case management / fraud investigation models for backend_v2.

These mirror the structures previously defined in ``db_postgres.py`` /
``app.py`` but are now owned by the new modular backend so they can be
evolved independently of the legacy prototype.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSON

from backend_v2.database import Base


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class CaseManagementBase(Base):
    """Base class for all case‑management models."""

    __abstract__ = True


class InvestigationCase(CaseManagementBase):
    __tablename__ = "investigation_cases"

    id = Column(Integer, primary_key=True, autoincrement=True)
    player_code = Column(String(255), unique=True, index=True, nullable=False)
    player_nickname = Column(String(512), index=True, nullable=False)
    risk_score = Column(Float, nullable=False)
    triggered_scenarios = Column(Text, nullable=False)
    status = Column(String(64), nullable=False, default="Open")
    assigned_agent = Column(String(256), nullable=True)
    decision_summary = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=_utc_now,
        onupdate=_utc_now,
        nullable=False,
    )

    # Enterprise columns
    # Use DECIMAL(12, 2) for net_profit to prevent truncation of large winnings (70,000+)
    net_profit = Column(Numeric(12, 2), default=0.0)
    roi = Column(Float, default=0.0)
    win_rate = Column(Float, default=0.0)
    win_rate_cash = Column(Float, default=0.0)
    win_rate_mtt = Column(Float, default=0.0)
    global_win_ratio = Column(Float, default=0.0)
    total_hands = Column(Integer, default=0)
    total_tournaments = Column(Integer, default=0)
    lifetime_rake = Column(Float, default=0.0)
    lifetime_total_fees = Column(Float, default=0.0)
    vpip = Column(Float, default=0.0)
    pfr = Column(Float, default=0.0)
    three_bet = Column(Float, default=0.0)
    top_partners = Column(String, nullable=True)
    network_data = Column(JSON, default=dict)
    suspicious_sessions = Column(JSON, default=list, nullable=True)
    category = Column(String(64), nullable=True, index=True)  # Financial Integrity, Identity Fraud, etc.
    tag = Column(String(64), nullable=True, index=True)  # RAKE_ABUSE, MULTI_ACCOUNT, etc.

    def to_dict(self) -> dict:
        """Serialize for API responses; includes category and tag for triage tabs.

        The React triage dashboard expects some ``network_data`` keys to be available
        as top‑level fields (e.g. ``mtt_win_pct``, ``cash_win_pct``, ``total_mtts``,
        ``total_sessions``). To avoid frontend breakage, we expose both the raw
        ``network_data`` JSON and a flattened view.
        """
        nd = self.network_data or {}

        # Advanced win‑rate summary (Fraud Engine V2)
        mtt_win_pct = float(nd.get("mtt_win_pct") or 0.0)
        cash_win_pct = float(nd.get("cash_win_pct") or 0.0)
        total_mtts = int(nd.get("total_mtts") or 0)
        total_sessions = int(nd.get("total_sessions") or 0)

        # Lifetime stats summary used by the investigation / case table
        total_hands_played = int(nd.get("total_hands_played") or 0)
        total_profit_loss = float(nd.get("total_profit_loss") or 0.0)
        total_rake_fees = float(nd.get("total_rake_fees") or 0.0)
        cash_ratio = float(nd.get("cash_ratio") or 0.0)
        mtt_ratio = float(nd.get("mtt_ratio") or 0.0)
        account_lifetime_fee = float(nd.get("account_lifetime_fee") or 0.0)
        twister_win_pct = float(nd.get("twister_win_pct") or 0.0)
        total_twister_buyin = float(nd.get("total_twister_buyin") or 0.0)
        total_mtt_buyin = float(nd.get("total_mtt_buyin") or 0.0)
        base = {
            "id": self.id,
            "case_ref": f"#{self.id}" if self.id is not None else None,
            "player_code": self.player_code,
            "player_nickname": self.player_nickname,
            "risk_score": float(self.risk_score),
            "triggered_scenarios": self.triggered_scenarios or "",
            "status": self.status or "Open",
            "assigned_agent": self.assigned_agent,
            "decision_summary": self.decision_summary,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
            "net_profit": float(self.net_profit or 0.0),
            "roi": float(self.roi or 0.0),
            "win_rate": float(self.win_rate or 0.0),
            "win_rate_cash": float(self.win_rate_cash or 0.0),
            "win_rate_mtt": float(self.win_rate_mtt or 0.0),
            "global_win_ratio": float(self.global_win_ratio or 0.0),
            "total_hands": int(self.total_hands or 0),
            "total_tournaments": int(self.total_tournaments or 0),
            "lifetime_rake": float(self.lifetime_rake or 0.0),
            "lifetime_total_fees": float(self.lifetime_total_fees or 0.0),
            "vpip": float(self.vpip or 0.0),
            "pfr": float(self.pfr or 0.0),
            "three_bet": float(self.three_bet or 0.0),
            "top_partners": self.top_partners or "",
            "network_data": nd,
            "suspicious_sessions": self.suspicious_sessions or [],
            "category": self.category or "General",
            "tag": self.tag,
        }

        # Flattened fields for triage / investigation tables
        base.update(
            {
                "mtt_win_pct": mtt_win_pct,
                "cash_win_pct": cash_win_pct,
                "total_mtts": total_mtts,
                "total_sessions": total_sessions,
                "total_hands_played": total_hands_played,
                "total_profit_loss": total_profit_loss,
                "total_rake_fees": total_rake_fees,
                "cash_ratio": cash_ratio,
                "mtt_ratio": mtt_ratio,
                "account_lifetime_fee": account_lifetime_fee,
                "twister_win_pct": twister_win_pct,
                "total_twister_buyin": total_twister_buyin,
                "total_mtt_buyin": total_mtt_buyin,
                "twisters_played": int(nd.get("twisters_played") or 0),
            }
        )

        return base


class CaseNote(CaseManagementBase):
    __tablename__ = "case_notes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    case_id = Column(
        Integer,
        ForeignKey("investigation_cases.id", ondelete="CASCADE"),
        nullable=False,
    )
    agent_name = Column(String(256), nullable=True)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=_utc_now, nullable=False)


class FraudRuleConfig(CaseManagementBase):
    """
    Fraud rule configuration: one row per rule (1–25).
    Engine reads parameters, exclusions, and is_active from here; when is_active=False the rule is skipped.
    risk_level: Low | Medium | High | Critical. weight: 0.0–1.0 for scoring.
    parameters: JSONB for rule-specific math. exclusions: JSONB for advanced exclusions (ROI, hands, etc.).
    """
    __tablename__ = "fraud_rule_configs"

    rule_id = Column(Integer, primary_key=True)
    rule_name = Column(String(255), nullable=False)
    category = Column(String(128), nullable=False)
    risk_level = Column(String(32), nullable=True)   # Low, Medium, High, Critical
    weight = Column(Float, default=0.5, nullable=True)  # 0.0 to 1.0
    parameters = Column(JSON, default=dict, nullable=False)
    exclusions = Column(JSON, default=dict, nullable=True)  # ROI %, Win Rate %, Total Hands, Net Profit, Lifetime Rake, Min Hands floor
    dynamic_description = Column(Text, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)


__all__ = ["CaseManagementBase", "InvestigationCase", "CaseNote", "FraudRuleConfig"]

