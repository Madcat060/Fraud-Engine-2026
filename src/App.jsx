/**
 * App.jsx – Trust & Safety Triage: Cases table and Investigation Room (CaseWorkspace) modal.
 * Fraud rule configuration is available on a dedicated tab (Settings domain).
 */
import React, { useState } from 'react';
import TriageDashboard from './Workspace/TriageDashboard';
import CaseWorkspace from './Investigation/CaseWorkspace';
import ErrorBoundary from './UI/ErrorBoundary';
import FraudRuleConfigPage from './Settings/FraudRuleConfigPage';

function initialMainTab() {
  if (typeof window === 'undefined') return 'cases';
  const path = (window.location.pathname || '').replace(/\/+$/, '') || '/';
  return path === '/rules' ? 'fraud-rules' : 'cases';
}

export default function App() {
  const [caseWorkspaceOpen, setCaseWorkspaceOpen] = useState(null);
  const [mainTab, setMainTab] = useState(initialMainTab);

  const handleInvestigate = (caseId, playerCode) => {
    setCaseWorkspaceOpen({ caseId, playerCode });
  };

  const closeWorkspace = () => setCaseWorkspaceOpen(null);

  return (
    <div className="app-fraud-root fraud-ui-dark">
      <div className="app-main-tabs card-panel app-main-tabs-compact">
        <div className="app-main-tabs-inner">
          <button
            type="button"
            className={mainTab === 'cases' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setMainTab('cases')}
          >
            Case manager
          </button>
          <button
            type="button"
            className={mainTab === 'fraud-rules' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            onClick={() => setMainTab('fraud-rules')}
          >
            Fraud rule configuration
          </button>
        </div>
      </div>

      {mainTab === 'cases' && <TriageDashboard onInvestigate={handleInvestigate} />}
      {mainTab === 'fraud-rules' && <FraudRuleConfigPage />}

      {caseWorkspaceOpen && (
        <div
          className="modal-overlay case-workspace-overlay investigation-portal-overlay"
          style={{ display: 'flex', position: 'fixed', inset: 0, zIndex: 9999, alignItems: 'stretch', justifyContent: 'stretch', background: 'transparent' }}
          onClick={(e) => e.target === e.currentTarget && closeWorkspace()}
        >
          <div className="investigation-portal-overlay-inner" onClick={(e) => e.stopPropagation()} role="presentation">
            <ErrorBoundary onDismiss={closeWorkspace}>
              <CaseWorkspace
                caseId={caseWorkspaceOpen.caseId}
                playerCode={caseWorkspaceOpen.playerCode}
                onClose={closeWorkspace}
              />
            </ErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
}
