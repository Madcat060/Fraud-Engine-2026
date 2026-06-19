/**
 * FinancialChart.jsx – Line chart of cumulative Cash game net win over time.
 * Uses react-chartjs-2; fill under line; red if overall trend negative, green if positive.
 */
import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  Title,
  Tooltip,
  Legend,
  Filler
);

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: { 
      display: true,
      position: 'top',
      labels: {
        usePointStyle: true,
        padding: 15,
        font: { size: 12 },
      },
    },
    title: {
      display: true,
      text: 'Combined Financial Timeline (Cash + MTT + Twisters)',
      font: { size: 16, weight: 'bold' },
      padding: { top: 10, bottom: 20 },
    },
    tooltip: {
      enabled: true,
      backgroundColor: 'rgba(0, 0, 0, 0.8)',
      padding: 12,
      titleFont: { size: 13, weight: 'bold' },
      bodyFont: { size: 12 },
      borderColor: 'rgba(255, 255, 255, 0.1)',
      borderWidth: 1,
      callbacks: {
        label: function(context) {
          const label = context.dataset.label || '';
          const value = context.parsed.y;
          // Format numbers for consistent currency display (no currency symbol)
          const numeric = Number(value);
          const formattedValue = Number.isFinite(numeric)
            ? numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : value;
          return `${label}: ${formattedValue}`;
        },
        title: function(context) {
          const date = context[0].label;
          // Format date for better readability
          if (date && date.includes('T')) {
            const d = new Date(date);
            return d.toLocaleDateString('en-US', { 
              year: 'numeric', 
              month: 'short', 
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            });
          }
          return date;
        },
      },
    },
  },
  scales: {
    x: {
      title: { display: true, text: 'Date', font: { size: 12, weight: 'bold' } },
      ticks: { maxTicksLimit: 8, font: { size: 10 } },
      grid: { color: 'rgba(0, 0, 0, 0.05)' },
    },
    y: {
      title: { display: true, text: 'Amount', font: { size: 12, weight: 'bold' } },
      ticks: { 
        callback: function(value) {
          // Format number cleanly without currency symbol (aggregate data)
          return typeof value === 'number' 
            ? value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })
            : value;
        },
        font: { size: 10 },
      },
      grid: { color: 'rgba(0, 0, 0, 0.05)' },
    },
  },
};

const chartTick = '#94a3b8';
const chartGrid = 'rgba(148, 163, 184, 0.12)';

const chartGridDark = 'rgba(148, 163, 184, 0.08)';

function buildChartOptions(variant) {
  if (variant !== 'dark') return chartOptions;
  return {
    ...chartOptions,
    animation: { duration: 400 },
    plugins: {
      ...chartOptions.plugins,
      legend: {
        ...chartOptions.plugins.legend,
        labels: {
          ...chartOptions.plugins.legend.labels,
          color: chartTick,
        },
      },
      title: {
        ...chartOptions.plugins.title,
        color: '#f1f5f9',
      },
    },
    scales: {
      x: {
        ...chartOptions.scales.x,
        ticks: { ...chartOptions.scales.x.ticks, color: chartTick },
        grid: { ...chartOptions.scales.x.grid, color: chartGridDark },
        title: { ...chartOptions.scales.x.title, color: chartTick },
      },
      y: {
        ...chartOptions.scales.y,
        ticks: { ...chartOptions.scales.y.ticks, color: chartTick },
        grid: { ...chartOptions.scales.y.grid, color: chartGridDark },
        title: { ...chartOptions.scales.y.title, color: chartTick },
      },
    },
  };
}

function toFiniteNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function FinancialChart({ data: timelineData, variant = 'light', lifetimeTotalProfit = null }) {
  const lifetimeTotal = toFiniteNumber(lifetimeTotalProfit);
  const { labels, profitValues, rakeValues, isNegative } = useMemo(() => {
    if (!timelineData || !Array.isArray(timelineData) || timelineData.length === 0) {
      return { labels: [], profitValues: [], rakeValues: [], isNegative: false };
    }
    // Filter out null/undefined entries and sort by date ascending so X-axis is chronological
    const sorted = [...timelineData].filter(d => d != null).sort((a, b) => {
      const da = String(a?.date ?? a?.Date ?? '').trim();
      const db = String(b?.date ?? b?.Date ?? '').trim();
      return da.localeCompare(db, undefined, { numeric: true });
    });
    
    if (sorted.length === 0) {
      return { labels: [], profitValues: [], rakeValues: [], isNegative: false };
    }
    
    const labels = sorted.map((d) => {
      const dateStr = String(d?.date ?? d?.Date ?? '').trim();
      // Format date for display (extract date part if ISO format)
      if (dateStr.includes('T')) {
        return dateStr.split('T')[0];
      }
      return dateStr;
    });
    
    // Use cumulative_profit from new endpoint, or calculate from Profit/net_win
    const profitValues = sorted.map((d) => {
      if (d?.cumulative_profit !== undefined && d.cumulative_profit != null) {
        return Number(d.cumulative_profit) || 0;
      }
      // Fallback to old format
      const v = d?.['Cash game net win'] ?? d?.Profit ?? d?.net_win ?? d?.cumulative_profit;
      return Number(v) || 0;
    });
    
    // Use cumulative_rake from new endpoint
    const rakeValues = sorted.map((d) => {
      if (d?.cumulative_rake !== undefined && d.cumulative_rake != null) {
        return Number(d.cumulative_rake) || 0;
      }
      return 0;
    });
    
    const lastVal = profitValues.length ? profitValues[profitValues.length - 1] : 0;
    const isNegative = lastVal < 0;
    return { labels, profitValues, rakeValues, isNegative };
  }, [timelineData]);

  const resolvedOptions = useMemo(() => buildChartOptions(variant), [variant]);

  const chartData = useMemo(() => {
    const profitColor = isNegative ? 'rgba(220, 38, 38, 0.9)' : 'rgba(22, 163, 74, 0.9)';
    const profitFillColor = isNegative ? 'rgba(220, 38, 38, 0.15)' : 'rgba(22, 163, 74, 0.15)';
    const rakeColor = 'rgba(59, 130, 246, 0.9)';
    const rakeFillColor = 'rgba(59, 130, 246, 0.1)';
    const lifetimeColor = variant === 'dark' ? 'rgba(250, 204, 21, 0.95)' : 'rgba(180, 83, 9, 0.95)';

    const profitFill =
      variant === 'dark'
        ? (context) => {
            const chart = context.chart;
            const { ctx, chartArea } = chart;
            if (!chartArea) return profitFillColor;
            const g = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
            if (isNegative) {
              g.addColorStop(0, 'rgba(220, 38, 38, 0.32)');
              g.addColorStop(1, 'rgba(220, 38, 38, 0.02)');
            } else {
              g.addColorStop(0, 'rgba(22, 163, 74, 0.32)');
              g.addColorStop(1, 'rgba(22, 163, 74, 0.02)');
            }
            return g;
          }
        : profitFillColor;

    const datasets = [
      {
        label: 'Cumulative profit (cash + MTT + twisters)',
        data: profitValues,
        borderColor: profitColor,
        backgroundColor: profitFill,
        fill: true,
        tension: 0.3,
        pointRadius: labels.length <= 50 ? 3 : 0,
        pointHoverRadius: 5,
        borderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        yAxisID: 'y',
      },
    ];

    // Add cumulative rake line if data is available
    if (rakeValues.some((v) => v > 0)) {
      datasets.push({
        label: 'Cumulative cash rake',
        data: rakeValues,
        borderColor: rakeColor,
        backgroundColor: rakeFillColor,
        fill: false,
        tension: 0.3,
        pointRadius: labels.length <= 50 ? 2 : 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        borderCapStyle: 'round',
        borderJoinStyle: 'round',
        borderDash: [5, 5],
        yAxisID: 'y',
      });
    }

    // Horizontal reference: full lifetime net (same as triage / 360° Financials) vs timeline cumulative
    if (lifetimeTotal != null && labels.length > 0) {
      const flat = Array(labels.length).fill(lifetimeTotal);
      datasets.push({
        label: 'Lifetime total net (triage / Financials)',
        data: flat,
        borderColor: lifetimeColor,
        backgroundColor: 'transparent',
        fill: false,
        tension: 0,
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 2,
        borderDash: [8, 5],
        yAxisID: 'y',
      });
    }

    return {
      labels,
      datasets,
    };
  }, [labels, profitValues, rakeValues, isNegative, variant, lifetimeTotal]);

  if (!labels.length || !profitValues.length) {
    return (
      <div className={`evidence-card financial-chart-card${variant === 'dark' ? ' financial-chart-card--dark' : ''}`}>
        <h5>Combined financial timeline (cash + MTT + twisters)</h5>
        <p className="section-hint">No chart data available.</p>
      </div>
    );
  }

  const showSparseHint = labels.length > 0 && labels.length <= 2;
  const lastCumulative = profitValues.length ? profitValues[profitValues.length - 1] : null;
  const deltaVsLifetime =
    lifetimeTotal != null && lastCumulative != null && Number.isFinite(lastCumulative)
      ? lifetimeTotal - lastCumulative
      : null;

  return (
    <div className={`evidence-card financial-chart-card${variant === 'dark' ? ' financial-chart-card--dark' : ''}`}>
      <h5>Combined financial timeline (cash + MTT + twisters)</h5>
      <p className={`section-hint${variant === 'dark' ? ' financial-chart-sparse-hint--dark' : ''}`} style={{ marginTop: 0, marginBottom: 8 }}>
        Daily cumulative P/L merges cash sessions with MTT and twister rows from the warehouse. Blue dashes: cumulative cash rake. Amber dashes: full lifetime net (same figure as triage and 360° Financials). Green area: cumulative P/L for days in this extract only—compare its end to the amber line when history is short.
      </p>
      <div className="financial-chart-container" style={{ minHeight: variant === 'dark' ? 300 : 220 }}>
        <Line data={chartData} options={resolvedOptions} />
      </div>
      {deltaVsLifetime != null && Math.abs(deltaVsLifetime) >= 0.01 && (
        <p className={`section-hint${variant === 'dark' ? ' financial-chart-sparse-hint--dark' : ''}`} style={{ marginTop: 8, marginBottom: 0 }}>
          Gap vs lifetime: chart cumulative end is{' '}
          <strong>{lastCumulative.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          {', '}
          lifetime total is <strong>{lifetimeTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          {' '}(Δ {deltaVsLifetime >= 0 ? '+' : ''}
          {deltaVsLifetime.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
        </p>
      )}
      {showSparseHint && (
        <p className={`section-hint financial-chart-sparse-hint${variant === 'dark' ? ' financial-chart-sparse-hint--dark' : ''}`}>
          Limited history — timeline will fill as more session days exist.
        </p>
      )}
    </div>
  );
}
