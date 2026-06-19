import React from 'react';

function isUnknownDeviceLabel(raw) {
  const t = String(raw ?? '')
    .trim()
    .toLowerCase();
  return !t || t === 'unknown' || t === 'unknown device' || t === 'n/a' || t === 'null' || t === 'none';
}

export default function HardwareTwins({ twins }) {
  const visibleTwins = Array.isArray(twins)
    ? twins.filter((twin) => !isUnknownDeviceLabel(twin?.DeviceName ?? twin?.['Device Name']))
    : [];

  if (!visibleTwins.length) {
    return (
      <div className="hardware-twins hardware-twins--empty">
        <p>No hardware or IP twins detected for this profile.</p>
      </div>
    );
  }

  return (
    <div className="hardware-twins">
      <h3 className="hardware-twins__title">Device & hardware network (identity twins)</h3>
      <div className="hardware-twins__body">
        <table className="hardware-twins-table">
          <thead>
            <tr>
              <th>Linked nickname</th>
              <th>Match type</th>
              <th>Device / OS</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {visibleTwins.map((twin, idx) => {
              const hasSerialMatch = twin?.Serial && twin.Serial !== '';
              const twinNick = twin?.twin_nick ?? twin?.Nickname ?? '—';
              const deviceLabel = twin?.DeviceName ?? twin?.['Device Name'] ?? '—';
              const lastSeen = twin?.last_seen ? new Date(twin.last_seen) : null;
              return (
                <tr key={idx} className={hasSerialMatch ? 'hardware-twins-table__row-serial' : ''}>
                  <td className="hardware-twins-table__nick">{twinNick}</td>
                  <td>
                    <span className={hasSerialMatch ? 'hardware-twins-badge hardware-twins-badge--serial' : 'hardware-twins-badge hardware-twins-badge--ip'}>
                      {hasSerialMatch ? 'Hardware match' : 'IP match'}
                    </span>
                  </td>
                  <td className="hardware-twins-table__muted">{deviceLabel}</td>
                  <td>{lastSeen ? lastSeen.toLocaleDateString() : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hardware-twins__footnote">
        Hardware matches use unique machine serials. IP matches may indicate shared households or VPN exit nodes.
      </p>
    </div>
  );
}
