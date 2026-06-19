/**
 * FraudRuleConfigPage.jsx – Thin wrapper around RuleSettings (V2 accordion UI).
 */
import React from 'react';
import RuleSettings from './RuleSettings';

export default function FraudRuleConfigPage() {
  return (
    <div className="fraud-rule-config-page fraud-rule-config-page--dark">
      <h1 className="fraud-rule-config-page__title">
        Fraud rule configuration
      </h1>
      <p className="fraud-rule-config-page__lead">
        Tune parameters and exclusions per rule. Open a rule only when you need to edit it — weight and on/off stay in the row header.
      </p>
      <RuleSettings />
    </div>
  );
}
