import React from 'react';
import { TRANSLATIONS, type Lang } from '../i18n';
import type { PipeCalcMetrics } from '../types';

function buildPath(xs: number[], ys: number[], xMin: number, xMax: number, yMin: number, yMax: number, w: number, h: number, pad: number): string {
  const sx = (x: number) => pad + ((x - xMin) / Math.max(xMax - xMin, 1e-9)) * (w - 2 * pad);
  const sy = (y: number) => h - pad - ((y - yMin) / Math.max(yMax - yMin, 1e-9)) * (h - 2 * pad);
  return xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' ');
}

export const PipeCharts: React.FC<{ lang: Lang; metrics: PipeCalcMetrics }> = ({ lang, metrics }) => {
  const t = TRANSLATIONS[lang];
  const ax = metrics.charts?.axial_pressure;
  const rd = metrics.charts?.radial_profile;
  if (!ax || !rd) return null;

  const w = 440;
  const h = 148;
  const pad = 26;

  const xd = ax.s_over_d;
  const ppa = ax.p_pa;
  const pMin = Math.min(...ppa);
  const pMax = Math.max(...ppa, pMin + 1);
  const pAx = buildPath(xd, ppa, Math.min(...xd), Math.max(...xd), pMin, pMax, w, h, pad);

  const rr = rd.r_over_r;
  const pCfd = buildPath(rr, rd.u_norm_cfd, -1, 1, 0, 1.06, w, h, pad);
  const p7 = buildPath(rr, rd.u_power7, -1, 1, 0, 1.06, w, h, pad);
  const pLam = buildPath(rr, rd.u_poiseuille, -1, 1, 0, 1.06, w, h, pad);

  return (
    <div className="charts-grid">
      <div className="chart-card">
        <div className="chart-head">
          <strong>{t.chartAxTitle}</strong>
          <span>{t.chartAxSub}</span>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg">
          <path d={pAx} fill="none" stroke="#f97316" strokeWidth="2.4" />
          <text x={pad} y={pad + 8} fontSize="9.5" fill="#fbbf24">{pMax.toFixed(0)} Pa</text>
          <text x={w - pad} y={h - pad - 4} fontSize="9.5" fill="#fbbf24" textAnchor="end">{pMin.toFixed(0)} Pa</text>
          <text x={pad} y={h - 7} fontSize="9.5" fill="#cbb8a5">x/D = {xd[0]?.toFixed(1)}</text>
          <text x={w - pad} y={h - 7} fontSize="9.5" fill="#cbb8a5" textAnchor="end">x/D = {xd[xd.length - 1]?.toFixed(1)}</text>
        </svg>
      </div>
      <div className="chart-card">
        <div className="chart-head">
          <strong>{t.chartRadTitle}</strong>
          <span>{t.chartRadSub}</span>
        </div>
        <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg">
          <path d={pLam} fill="none" stroke="rgba(251,113,133,0.75)" strokeWidth="1.5" strokeDasharray="2 3" />
          <path d={p7} fill="none" stroke="#fbbf24" strokeWidth="1.8" strokeDasharray="5 3" />
          <path d={pCfd} fill="none" stroke="#22d3ee" strokeWidth="2.4" />
          <text x={pad} y={h - 7} fontSize="9.5" fill="#cbb8a5">r/R = -1</text>
          <text x={w * 0.5} y={h - 7} fontSize="9.5" fill="#cbb8a5" textAnchor="middle">Center (0)</text>
          <text x={w - pad} y={h - 7} fontSize="9.5" fill="#cbb8a5" textAnchor="end">+1</text>
        </svg>
      </div>
    </div>
  );
};
