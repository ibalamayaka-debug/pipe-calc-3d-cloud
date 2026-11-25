export interface Env {
  PIPE_CALC_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  COMPUTE_BASE_URL?: string;
  COMPUTE_AUTH_TOKEN?: string;
  ALLOWED_ORIGIN: string;
  MAX_RUNS_PER_IP_PER_HOUR: string;
  ASSETS?: Fetcher;
}

interface CalcParams {
  diameter_mm: number;
  length_m: number;
  flow_rate_lpm: number;
  density_kgm3: number;
  viscosity_pas: number;
  geometry: 'straight' | 'elbow';
  pump_eff: number;
}

const VALID_FILES = new Set(['wall.vtp', 'slice_long.vtp', 'slice_cross.vtp', 'streamlines.vtp', 'metrics.json']);

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResp(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(env) },
  });
}

function fmt4g(val: number): string {
  return Number(val.toPrecision(4)).toString();
}

function normalize(raw: Partial<CalcParams>): CalcParams {
  const diameter_mm = Number(Math.min(Math.max(Number(raw.diameter_mm ?? 80), 15), 400).toFixed(1));
  const length_m = Number(Math.min(Math.max(Number(raw.length_m ?? 4.0), 0.5), 50).toFixed(2));
  const flow_rate_lpm = Number(Math.min(Math.max(Number(raw.flow_rate_lpm ?? 450), 1), 30000).toFixed(1));
  const density_kgm3 = Number(Math.min(Math.max(Number(raw.density_kgm3 ?? 998.2), 0.5), 3000).toFixed(2));
  const viscosity_pas = Number(Math.min(Math.max(Number(raw.viscosity_pas ?? 0.001002), 1e-5), 2.0).toPrecision(4));
  const geometry = String(raw.geometry ?? 'straight').toLowerCase().trim() === 'elbow' ? 'elbow' : 'straight';
  const pump_eff = Number(Math.min(Math.max(Number(raw.pump_eff ?? 0.75), 0.4), 0.95).toFixed(2));
  return { diameter_mm, length_m, flow_rate_lpm, density_kgm3, viscosity_pas, geometry, pump_eff };
}

async function caseKeyOf(p: CalcParams): Promise<string> {
  const canonical =
    `pcalc3d|g=${p.geometry}|d=${p.diameter_mm.toFixed(1)}|l=${p.length_m.toFixed(2)}|` +
    `q=${p.flow_rate_lpm.toFixed(1)}|r=${p.density_kgm3.toFixed(2)}|m=${fmt4g(p.viscosity_pas)}|e=${p.pump_eff.toFixed(2)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function buildUrls(caseKey: string) {
  return {
    wall: `/api/results/${caseKey}/wall.vtp`,
    slice_long: `/api/results/${caseKey}/slice_long.vtp`,
    slice_cross: `/api/results/${caseKey}/slice_cross.vtp`,
    streamlines: `/api/results/${caseKey}/streamlines.vtp`,
    metrics: `/api/results/${caseKey}/metrics.json`,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) {
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not Found', { status: 404 });
    }

    if (path === '/api/health') {
      return jsonResp({ status: 'ok', service: 'pipe-calc-3d-cloud', compute_configured: Boolean(env.COMPUTE_BASE_URL) }, 200, env);
    }

    if (path === '/api/cases' && request.method === 'GET') {
      const raw = await env.PIPE_CALC_KV.get('index:cases');
      return jsonResp({ cases: raw ? JSON.parse(raw) : [] }, 200, env);
    }

    const resMatch = path.match(/^\/api\/results\/([a-f0-9]{16})\/([a-z0-9_.-]+)$/);
    if (resMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const [, caseKey, fname] = resMatch;
      if (!VALID_FILES.has(fname)) return jsonResp({ error: 'Invalid file' }, 400, env);
      const val = await env.PIPE_CALC_KV.get(`case:${caseKey}:${fname}`);
      if (!val) return jsonResp({ error: 'Not found in KV' }, 404, env);
      const ct = fname.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/xml; charset=utf-8';
      return new Response(request.method === 'HEAD' ? null : val, {
        status: 200,
        headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000, immutable', ...corsHeaders(env) },
      });
    }

    if (path === '/api/calculate' && request.method === 'POST') {
      let body: Partial<CalcParams> & { force?: boolean } = {};
      try {
        body = (await request.json()) as Partial<CalcParams> & { force?: boolean };
      } catch {
        return jsonResp({ error: 'Invalid JSON body' }, 400, env);
      }

      const params = normalize(body);
      const caseKey = await caseKeyOf(params);

      if (!body.force) {
        const cachedRaw = await env.PIPE_CALC_KV.get(`case:${caseKey}:metrics.json`);
        if (cachedRaw) {
          return jsonResp(
            {
              status: 'ok',
              cached: true,
              backend: 'cloudflare-kv-cache',
              case_key: caseKey,
              metrics: JSON.parse(cachedRaw),
              urls: buildUrls(caseKey),
            },
            200,
            env
          );
        }
      }

      if (!env.COMPUTE_BASE_URL) return jsonResp({ error: 'COMPUTE_BASE_URL missing' }, 503, env);

      const ip = request.headers.get('CF-Connecting-IP') || 'anon';
      const hourBucket = Math.floor(Date.now() / 3600000);
      const rlKey = `rl:pcalc3d:${ip}:${hourBucket}`;
      const limit = Math.max(1, parseInt(env.MAX_RUNS_PER_IP_PER_HOUR || '30', 10));
      const used = parseInt((await env.RATE_LIMIT_KV.get(rlKey)) || '0', 10);
      if (used >= limit) return jsonResp({ error: `Hourly cloud quota reached (${limit}/hr).` }, 429, env);

      const base = env.COMPUTE_BASE_URL.replace(/\/$/, '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (env.COMPUTE_AUTH_TOKEN) headers['Authorization'] = `Bearer ${env.COMPUTE_AUTH_TOKEN}`;

      const modalRes = await fetch(`${base}/calculate`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
      });
      if (!modalRes.ok) {
        const errText = await modalRes.text();
        return jsonResp({ error: `Cloud 3D OpenFOAM failed (${modalRes.status}): ${errText.slice(0, 600)}` }, 502, env);
      }

      const payload = (await modalRes.json()) as {
        metrics: { case_key?: string } & Record<string, unknown>;
        files_content: Record<string, string>;
      };

      const writes: Promise<void>[] = [
        env.PIPE_CALC_KV.put(`case:${caseKey}:metrics.json`, JSON.stringify(payload.metrics)),
      ];
      for (const [fname, content] of Object.entries(payload.files_content || {})) {
        if (VALID_FILES.has(fname) && content) {
          writes.push(env.PIPE_CALC_KV.put(`case:${caseKey}:${fname}`, content));
        }
      }
      await Promise.all(writes);

      const idxRaw = await env.PIPE_CALC_KV.get('index:cases');
      const idxList: Array<{ case_key: string }> = idxRaw ? JSON.parse(idxRaw) : [];
      const updated = [payload.metrics as { case_key: string }, ...idxList.filter((x) => x.case_key !== caseKey)].slice(0, 24);
      await env.PIPE_CALC_KV.put('index:cases', JSON.stringify(updated));
      await env.RATE_LIMIT_KV.put(rlKey, String(used + 1), { expirationTtl: 3900 });

      return jsonResp(
        {
          status: 'ok',
          cached: false,
          backend: 'modal-openfoam-8core-3d',
          case_key: caseKey,
          metrics: payload.metrics,
          urls: buildUrls(caseKey),
        },
        200,
        env
      );
    }

    return jsonResp({ error: 'Not found' }, 404, env);
  },
};
