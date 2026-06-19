/**
 * PerformanceTrendChart.jsx
 * Cumulative Performance view: plots Cumulative Profit and Cumulative Rake over time.
 * Uses react-chartjs-2 (Line) on top of Chart.js.
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
      text: 'Combined Cumulative Performance (Cash + MTT)',
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
        label: function (context) {
          const label = context.dataset.label || '';
          const value = context.parsed.y;
          // Format numbers for consistent currency display (no currency symbol)
          const numeric = Number(value);
          const formattedValue = Number.isFinite(numeric)
            ? numeric.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })
            : value;
          return `${label}: ${formattedValue}`;
        },
        title: function (context) {
          const date = context[0].label;
          if (date && date.includes('T')) {
            const d = new Date(date);
            if (!isNaN(d.getTime())) {
              return d.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
            }
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
      title: { display: true, text: 'Cumulative Amount', font: { size: 12, weight: 'bold' } },
      ticks: {
        callback: function (value) {
          return typeof value === 'number'
            ? value.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              })
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

function buildChartOptions(variant) {
  if (variant !== 'dark') return chartOptions;
  return {
    ...chartOptions,
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
        grid: { ...chartOptions.scales.x.grid, color: chartGrid },
        title: { ...chartOptions.scales.x.title, color: chartTick },
      },
      y: {
        ...chartOptions.scales.y,
        ticks: { ...chartOptions.scales.y.ticks, color: chartTick },
        grid: { ...chartOptions.scales.y.grid, color: chartGrid },
        title: { ...chartOptions.scales.y.title, color: chartTick },
      },
    },
  };
}

export default function PerformanceTrendChart({ data: timelineData, variant = 'light' }) {
  const { labels, profitValues, rakeValues } = useMemo(() => {
    if (!timelineData || !Array.isArray(timelineData) || timelineData.length === 0) {
      return { labels: [], profitValues: [], rakeValues: [] };
    }

    const sorted = [...timelineData]
      .filter((d) => d != null)
      .sort((a, b) => {
        const da = String(a?.date ?? a?.Date ?? '').trim();
        const db = String(b?.date ?? b?.Date ?? '').trim();
        return da.localeCompare(db, undefined, { numeric: true });
      });

    if (sorted.length === 0) {
      return { labels: [], profitValues: [], rakeValues: [] };
    }

    const labels = sorted.map((d) => {
      const dateStr = String(d?.date ?? d?.Date ?? '').trim();
      if (dateStr.includes('T')) {
        return dateStr.split('T')[0];
      }
      return dateStr;
    });

    const profitValues = sorted.map((d) => {
      if (d?.cumulative_profit !== undefined && d.cumulative_profit != null) {
        return Number(d.cumulative_profit) || 0;
      }
      const v = d?.Profit ?? d?.net_win ?? d?.cumulative_profit;
      return Number(v) || 0;
    });

    const rakeValues = sorted.map((d) => {
      if (d?.cumulative_rake !== undefined && d.cumulative_rake != null) {
        return Number(d.cumulative_rake) || 0;
      }
      return 0;
    });

    return { labels, profitValues, rakeValues };
  }, [timelineData]);

  const resolvedOptions = useMemo(() => buildChartOptions(variant), [variant]);

  const chartData = useMemo(() => {
    const profitColor = 'rgba(34, 197, 94, 0.9)';
    const profitFillColor = 'rgba(34, 197, 94, 0.12)';
    const rakeColor = 'rgba(59, 130, 246, 0.9)';
    const rakeFillColor = 'rgba(59, 130, 246, 0.1)';

    const datasets = [
      {
        label: 'Cumulative Profit',
        data: profitValues,
        borderColor: profitColor,
        backgroundColor: profitFillColor,
        fill: true,
        tension: 0.3,
        pointRadius: labels.length <= 50 ? 3 : 0,
        pointHoverRadius: 5,
        borderWidth: 2,
        yAxisID: 'y',
      },
    ];

    if (rakeValues.some((v) => v > 0)) {
      datasets.push({
        label: 'Cumulative Rake',
        data: rakeValues,
        borderColor: rakeColor,
        backgroundColor: rakeFillColor,
        fill: false,
        tension: 0.3,
        pointRadius: labels.length <= 50 ? 2 : 0,
        pointHoverRadius: 4,
        borderWidth: 2,
        borderDash: [4, 4],
        yAxisID: 'y',
      });
    }

    return {
      labels,
      datasets,
    };
  }, [labels, profitValues, rakeValues]);

  if (!labels.length || !profitValues.length) {
    return (
      <div className={`global-view-card chart-card${variant === 'dark' ? ' financial-chart-card--dark' : ''}`}>
        <h5>Cumulative Performance — Cash (Wallet Leak / Rake)</h5>
        <p className="section-hint">No cumulative performance data available for this player.</p>
      </div>
    );
  }

  return (
    <div className={`global-view-card chart-card${variant === 'dark' ? ' financial-chart-card--dark' : ''}`}>
      <h5>Cumulative Performance — Cash (Wallet Leak / Rake)</h5>
      <div style={{ minHeight: 260 }}>
        <Line data={chartData} options={resolvedOptions} />
      </div>
    </div>
  );
}

