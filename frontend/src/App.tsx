import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Calculator,
  Database,
  Droplets,
  Eye,
  Flame,
  Gauge,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Timer,
  Zap,
} from 'lucide-react';
import { Pipe3DViewer } from './components/Pipe3DViewer';
import { PipeCharts } from './components/PipeCharts';
import { detectInitialLang, TRANSLATIONS, type Lang } from './i18n';
import type { FieldId, GeometryId, PaletteId, PipeCalcMetrics, PipeCalcParams, PipeCalcResponse } from './types';

const DEFAULT_PARAMS: PipeCalcParams = {
  diameter_mm: 80,
  length_m: 4.0,
  flow_rate_lpm: 450,
  density_kgm3: 998.2,
  viscosity_pas: 0.001002,
  geometry: 'straight',
  pump_eff: 0.75,
};

function colebrookEstimate(p: PipeCalcParams) {
  const D = p.diameter_mm * 1e-3;
  const A = Math.PI * (0.5 * D) ** 2;
  const Q = p.flow_rate_lpm / 60000;
  const U = Q / Math.max(A, 1e-9);
  const Re = (p.density_kgm3 * U * D) / Math.max(p.viscosity_pas, 1e-7);
  let f = 64 / Math.max(Re, 1);
  if (Re >= 2300) {
    const relE = 0.000045 / D;
    let inv = -1.8 * Math.log10((relE / 3.7) ** 1.11 + 6.9 / Re);
    for (let i = 0; i < 5; i++) inv = -2 * Math.log10(relE / 3.7 + (2.51 * inv) / Re);
    f = 1 / (inv * inv);
  }
  const kMinor = p.geometry === 'elbow' ? 0.25 : 0;
  const dp = (f * (p.length_m / D) + kMinor) * 0.5 * p.density_kgm3 * U * U;
  const hydW = Q * dp;
  const shaftW = hydW / Math.max(p.pump_eff, 0.1);
  return { Re, U, f, dp, hydW, shaftW };
}

function makeCachedResp(m: PipeCalcMetrics): PipeCalcResponse {
  return {
    status: 'ok',
    cached: true,
    backend: 'cloudflare-kv-cache',
    case_key: m.case_key,
    metrics: m,
    urls: {
      wall: `/api/results/${m.case_key}/wall.vtp`,
      slice_long: `/api/results/${m.case_key}/slice_long.vtp`,
      slice_cross: `/api/results/${m.case_key}/slice_cross.vtp`,
      streamlines: `/api/results/${m.case_key}/streamlines.vtp`,
      metrics: `/api/results/${m.case_key}/metrics.json`,
    },
  };
}

export const App: React.FC = () => {
  const [lang, setLang] = useState<Lang>(detectInitialLang);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [params, setParams] = useState<PipeCalcParams>(DEFAULT_PARAMS);
  const [qUnit, setQUnit] = useState<'lpm' | 'm3h'>('lpm');

  const [field, setField] = useState<FieldId>('U_mag');
  const [palette, setPalette] = useState<PaletteId>('rainbow');
  const [showWall, setShowWall] = useState(true);
  const [wallOpacity, setWallOpacity] = useState(0.9);
  const [cutaway, setCutaway] = useState(false);
  const [showLong, setShowLong] = useState(true);
  const [showCross, setShowCross] = useState(true);
  const [showStreams, setShowStreams] = useState(true);
  const [showEdges, setShowEdges] = useState(false);
  const [playing, setPlaying] = useState(true);

  const [result, setResult] = useState<PipeCalcResponse | null>(null);
  const [cachedList, setCachedList] = useState<PipeCalcMetrics[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const t = TRANSLATIONS[lang];
  const est = useMemo(() => colebrookEstimate(params), [params]);

  useEffect(() => {
    document.title = t.pageTitle;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try { localStorage.setItem('pcalc3d_lang', lang); } catch {}
  }, [lang, t.pageTitle]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/cases');
        if (!res.ok) return;
        const d = (await res.json()) as { cases?: PipeCalcMetrics[] };
        const list = d.cases ?? [];
        setCachedList(list);
        if (list.length > 0) {
          setParams(list[0].params);
          setResult(makeCachedResp(list[0]));
        }
      } catch {}
    })();
  }, []);

  const handleCalculate = async (override?: PipeCalcParams) => {
    const target = override ?? params;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      const data = (await res.json()) as PipeCalcResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      setResult(data);
      setParams(data.metrics.params);
      const cr = await fetch('/api/cases');
      if (cr.ok) {
        const cd = (await cr.json()) as { cases?: PipeCalcMetrics[] };
        setCachedList(cd.cases ?? []);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const k = result?.metrics.kpis;
  const tm = result?.metrics.timing_sec;
  const qDisplay = qUnit === 'lpm' ? params.flow_rate_lpm : Number((params.flow_rate_lpm * 0.06).toFixed(2));

  return (
    <div className={`app-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-top">
            <div className="brand-badge">{t.badge}</div>
            <div className="lang-switch">
              <button type="button" className={lang === 'zh' ? 'active' : ''} onClick={() => setLang('zh')}>中文</button>
              <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
            </div>
          </div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>

        <section className="panel-section">
          <div className="section-title"><Calculator size={14} /> {t.sectionInput}</div>

          <div className="preset-row">
            <span className="sub-label">{t.presetsTitle}</span>
            <div className="preset-grid">
              {[
                { label: '💧 DN80 工业水冷', p: { diameter_mm: 80, length_m: 4.0, flow_rate_lpm: 450, density_kgm3: 998.2, viscosity_pas: 0.001002, geometry: 'straight' as GeometryId, pump_eff: 0.75 } },
                { label: '🛢️ DN100 重油层流', p: { diameter_mm: 100, length_m: 5.0, flow_rate_lpm: 140, density_kgm3: 870, viscosity_pas: 0.085, geometry: 'straight' as GeometryId, pump_eff: 0.70 } },
                { label: '🔄 DN65 90°弯管', p: { diameter_mm: 65, length_m: 3.0, flow_rate_lpm: 380, density_kgm3: 998.2, viscosity_pas: 0.001002, geometry: 'elbow' as GeometryId, pump_eff: 0.75 } },
                { label: '💨 DN50 压缩空气', p: { diameter_mm: 50, length_m: 3.0, flow_rate_lpm: 1600, density_kgm3: 1.225, viscosity_pas: 0.0000184, geometry: 'straight' as GeometryId, pump_eff: 0.72 } },
              ].map((item) => (
                <button key={item.label} type="button" className="chip-preset" onClick={() => setParams(item.p)}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <label className="select-row">
            <span>{t.geomLabel}</span>
            <select value={params.geometry} onChange={(e) => setParams({ ...params, geometry: e.target.value as GeometryId })}>
              <option value="straight">{t.geomStraight}</option>
              <option value="elbow">{t.geomElbow}</option>
            </select>
          </label>

          <label className="input-row">
            <div className="input-head"><span>{t.diameter}</span><input type="number" min={15} max={400} step={1} value={params.diameter_mm} onChange={(e) => setParams({ ...params, diameter_mm: Number(e.target.value) })} /></div>
            <input type="range" min={15} max={300} step={5} value={Math.min(params.diameter_mm, 300)} onChange={(e) => setParams({ ...params, diameter_mm: Number(e.target.value) })} />
          </label>

          <label className="input-row">
            <div className="input-head"><span>{t.length}</span><input type="number" min={0.5} max={50} step={0.5} value={params.length_m} onChange={(e) => setParams({ ...params, length_m: Number(e.target.value) })} /></div>
            <input type="range" min={0.5} max={25} step={0.5} value={Math.min(params.length_m, 25)} onChange={(e) => setParams({ ...params, length_m: Number(e.target.value) })} />
          </label>

          <label className="input-row">
            <div className="input-head">
              <span>{t.flowRate}</span>
              <div className="unit-combo">
                <input
                  type="number"
                  min={0.1}
                  max={qUnit === 'lpm' ? 30000 : 1800}
                  step={qUnit === 'lpm' ? 10 : 0.5}
                  value={qDisplay}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setParams({ ...params, flow_rate_lpm: qUnit === 'lpm' ? v : Number((v / 0.06).toFixed(1)) });
                  }}
                />
                <select value={qUnit} onChange={(e) => setQUnit(e.target.value as 'lpm' | 'm3h')}>
                  <option value="lpm">L/min</option>
                  <option value="m3h">m³/h</option>
                </select>
              </div>
            </div>
            <input type="range" min={10} max={2500} step={10} value={Math.min(params.flow_rate_lpm, 2500)} onChange={(e) => setParams({ ...params, flow_rate_lpm: Number(e.target.value) })} />
          </label>

          <div className="two-col">
            <label className="input-row">
              <span>{t.density}</span>
              <input type="number" min={0.5} max={3000} step={0.1} value={params.density_kgm3} onChange={(e) => setParams({ ...params, density_kgm3: Number(e.target.value) })} />
            </label>
            <label className="input-row">
              <span>{t.viscosity}</span>
              <input type="number" min={0.00001} max={2} step={0.0001} value={params.viscosity_pas} onChange={(e) => setParams({ ...params, viscosity_pas: Number(e.target.value) })} />
            </label>
          </div>

          <label className="input-row">
            <div className="input-head"><span>{t.pumpEff}</span><strong>{Math.round(params.pump_eff * 100)}%</strong></div>
            <input type="range" min={40} max={95} step={5} value={Math.round(params.pump_eff * 100)} onChange={(e) => setParams({ ...params, pump_eff: Number(e.target.value) / 100 })} />
          </label>

          <div className="instant-box">
            <div className="instant-head"><Zap size={13} /> {t.instantTitle}</div>
            <div className="instant-grid">
              <span>Re = <b>{Math.round(est.Re).toLocaleString()}</b></span>
              <span>U = <b>{est.U.toFixed(2)} m/s</b></span>
              <span>ΔP ≈ <b>{est.dp.toFixed(0)} Pa</b></span>
              <span>Pump ≈ <b>{est.shaftW.toFixed(1)} W</b></span>
            </div>
          </div>

          <button type="button" className="run-btn" disabled={loading} onClick={() => handleCalculate()}>
            <Play size={15} /> {loading ? t.runningBtn : t.runBtn}
          </button>
        </section>

        <section className="panel-section">
          <div className="section-title"><Eye size={14} /> {t.sectionVisual}</div>
          <label className="select-row">
            <span>{t.fieldLabel}</span>
            <select value={field} onChange={(e) => setField(e.target.value as FieldId)}>
              <option value="U_mag">{t.fields.U_mag}</option>
              <option value="p_pa">{t.fields.p_pa}</option>
              <option value="k_turb">{t.fields.k_turb}</option>
            </select>
          </label>
          <div className="palette-switch">
            <button type="button" className={palette === 'rainbow' ? 'active' : ''} onClick={() => setPalette('rainbow')}>{t.palRainbow}</button>
            <button type="button" className={palette === 'thermal' ? 'active' : ''} onClick={() => setPalette('thermal')}>{t.palThermal}</button>
          </div>
          <div className="toggle-list">
            <label className="checkbox-row"><input type="checkbox" checked={showWall} onChange={(e) => setShowWall(e.target.checked)} /><span>{t.showWall}</span></label>
            <label className="input-row">
              <div className="input-head"><span>{t.wallOpacity}</span><strong>{Math.round(wallOpacity * 100)}%</strong></div>
              <input type="range" min={0.2} max={1.0} step={0.05} value={wallOpacity} onChange={(e) => setWallOpacity(Number(e.target.value))} />
            </label>
            <label className="checkbox-row"><input type="checkbox" checked={showLong} onChange={(e) => setShowLong(e.target.checked)} /><span>{t.showLong}</span></label>
            <label className="checkbox-row"><input type="checkbox" checked={showCross} onChange={(e) => setShowCross(e.target.checked)} /><span>{t.showCross}</span></label>
            <label className="checkbox-row"><input type="checkbox" checked={showStreams} onChange={(e) => setShowStreams(e.target.checked)} /><span>{t.showStreams}</span></label>
            <label className="checkbox-row"><input type="checkbox" checked={showEdges} onChange={(e) => setShowEdges(e.target.checked)} /><span>{t.showEdges}</span></label>
          </div>
        </section>

        <div className="sidebar-footer"><Flame size={13} /><span>Modal 8-Core MPI OpenFOAM v2512 + Cloudflare KV</span></div>
      </aside>

      <main className="workspace">
        <header className="kpi-bar">
          <button type="button" className="collapse-btn" onClick={() => setSidebarOpen((v) => !v)} title={sidebarOpen ? t.hideSidebar : t.showSidebar}>
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label"><Gauge size={14} /> {t.kpiDp}</div>
              <div className="kpi-value gold">
                {k ? `${k.pressure_drop_pa} Pa (${k.head_loss_m} mH₂O)` : '--'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label"><Droplets size={14} /> {t.kpiRe}</div>
              <div className="kpi-value coral">
                {k ? `${k.reynolds.toLocaleString()} · ${k.mean_velocity_ms} m/s` : '--'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label"><Zap size={14} /> {t.kpiPump}</div>
              <div className="kpi-value sage">
                {k ? `${k.pump_power_w} W (Hyd ${k.hydraulic_power_w} W)` : '--'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label"><Activity size={14} /> {t.kpiFriction}</div>
              <div className="kpi-value">
                {k ? `f=${k.darcy_f_cfd} vs ${k.darcy_f_colebrook} · τ=${k.wall_shear_pa}Pa` : '--'}
              </div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">{result?.cached ? <Database size={14} /> : <Timer size={14} />} {t.kpiMesh}</div>
              <div className={`kpi-value ${result?.cached ? 'sage' : 'gold'}`}>
                {k && tm ? `${(k.n_cells / 1000).toFixed(0)}k 3D · ${tm.total}s` : '--'}
              </div>
            </div>
          </div>
        </header>

        {error && <div className="error-banner"><AlertCircle size={15} /><span>{error}</span></div>}

        <div className="viewer-wrapper">
          <Pipe3DViewer
            lang={lang} result={result} field={field} palette={palette}
            showWall={showWall} wallOpacity={wallOpacity} cutaway={cutaway}
            onToggleCutaway={() => setCutaway((v) => !v)}
            showLong={showLong} showCross={showCross}
            showStreams={showStreams} showEdges={showEdges} playing={playing}
            onTogglePlay={() => setPlaying((v) => !v)} loading={loading}
          />
        </div>

        {result?.metrics && (
          <div className="charts-dock">
            <PipeCharts lang={lang} metrics={result.metrics} />
          </div>
        )}

        {cachedList.length > 0 && (
          <footer className="presets-strip">
            <span className="strip-label"><Database size={13} /> {t.cachedStrip}</span>
            <div className="strip-items">
              {cachedList.map((c) => (
                <button
                  key={c.case_key}
                  type="button"
                  className={`case-chip ${c.case_key === result?.case_key ? 'active' : ''}`}
                  onClick={() => { setParams(c.params); setResult(makeCachedResp(c)); }}
                >
                  {c.params.geometry === 'elbow' ? '90°Bend' : 'Pipe'} · D{c.params.diameter_mm} · {c.params.flow_rate_lpm}L/m · ΔP={c.kpis.pressure_drop_pa}Pa · {c.kpis.pump_power_w}W
                </button>
              ))}
            </div>
          </footer>
        )}
      </main>
    </div>
  );
};
