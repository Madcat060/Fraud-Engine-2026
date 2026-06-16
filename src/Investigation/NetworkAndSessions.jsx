import React from 'react';
import { sessionCodeSearchUrl } from './adminLinks';

function profitStyle(profit) {
  const p = Number(profit);
  if (!Number.isNaN(p) && p > 0) return { color: '#4ade80', fontWeight: '500' };
  if (!Number.isNaN(p) && p < 0) return { color: '#f87171' };
  return {};
}

function pctWinStyle(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return {};
  if (n > 200) return { color: '#fca5a5', fontWeight: 'bold', backgroundColor: 'rgba(185, 28, 28, 0.2)', padding: '2px 6px', borderRadius: '4px' };
  if (n >= 0) return { color: '#4ade80', fontWeight: '500' };
  return { color: '#f87171' };
}

function cell(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number' && !Number.isInteger(v)) return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return String(v);
}

/**
 * Major income grid: rows from Primary_Major_income_sessions only (exact warehouse column names).
 */
export default function NetworkAndSessions({ spikeLog }) {
  const spikeRows = Array.isArray(spikeLog) && spikeLog.length > 0 ? spikeLog : [];

  return (
    <div className="network-sessions-grid network-sessions-grid--major-only">
      <div className="network-sessions-card network-sessions-card--major-full">
        <h3 className="network-sessions-card__title network-sessions-card__title--red">
          Major income &amp; spike log
        </h3>
        <p className="section-hint" style={{ margin: '0 0 8px', fontSize: '11px' }}>
          Sourced exclusively from <strong>Primary_Major_income_sessions</strong>. % Win and % of won hands are taken from the warehouse columns (not recomputed from Win/Buy).
        </p>
        <div className="network-sessions-card__body" style={{ overflowX: 'auto' }}>
          {spikeRows.length === 0 ? (
            <div className="network-sessions-table__empty network-sessions-table__empty--block">No major income sessions found.</div>
          ) : (
            <table className="network-sessions-table network-sessions-table--major-wide">
              <thead>
                <tr>
                  <th>Session code</th>
                  <th>Start date</th>
                  <th>End date</th>
                  <th>Duration (s)</th>
                  <th>Big blind</th>
                  <th>Buy</th>
                  <th>Win</th>
                  <th>% Win</th>
                  <th>Rake</th>
                  <th>Bets</th>
                  <th>Wins</th>
                  <th># of hands</th>
                  <th># of won hands</th>
                  <th>% of won hands</th>
                  <th>Currency</th>
                </tr>
              </thead>
              <tbody>
                {spikeRows.map((row, idx) => {
                  const buyNum = Number(row.Buy ?? row.buy ?? 0);
                  const winNum = Number(row.Win ?? row.win ?? 0);
                  const profit = winNum - buyNum;
                  const pctWin = row['% Win'];
                  const pw = pctWin != null && Number.isFinite(Number(pctWin)) ? Number(pctWin) : null;
                  const winStyle = profitStyle(profit);
                  const pctStyle = pw != null ? pctWinStyle(pw) : {};
                  const dur = row['Duration (seconds)'];
                  const rawSc = row['Session code'] ?? row.session_code;
                  const scStr = rawSc != null && String(rawSc).trim() !== '' ? String(rawSc).trim() : '';
                  const spikeSessHref = scStr ? sessionCodeSearchUrl(scStr) : null;
                  return (
                    <tr key={idx} className={pw != null && pw > 200 ? 'network-sessions-table__row-warn' : ''}>
                      <td className="network-sessions-table__mono">
                        {spikeSessHref ? (
                          <a className="admin-quick-link" href={spikeSessHref} target="_blank" rel="noopener noreferrer">{scStr}</a>
                        ) : (
                          cell(row['Session code'] ?? row.session_code)
                        )}
                      </td>
                      <td>{cell(row['Start date'] ?? row.date)}</td>
                      <td>{cell(row['End date'])}</td>
                      <td>{cell(dur)}</td>
                      <td>{cell(row['Big blind'])}</td>
                      <td>${buyNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={winStyle}>${winNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={pctStyle}>{pw != null ? `${pw.toFixed(2)}%` : '—'}</td>
                      <td>{cell(row.Rake)}</td>
                      <td>{cell(row.Bets)}</td>
                      <td>{cell(row.Wins)}</td>
                      <td>{cell(row['# of hands'] ?? row.num_hands)}</td>
                      <td>{cell(row['# of won hands'])}</td>
                      <td>
                        {row['% of won hands'] != null && Number.isFinite(Number(row['% of won hands']))
                          ? `${Number(row['% of won hands']).toFixed(2)}%`
                          : '—'}
                      </td>
                      <td>{cell(row.Currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
