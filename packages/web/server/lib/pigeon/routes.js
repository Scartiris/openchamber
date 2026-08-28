/**
 * Pigeon Sidecar 代理路由：/api/pigeon/* → http://127.0.0.1:3211/*
 * 记忆（mem0）+ 知识库（LightRAG）+ 画像/续接（pigeon v2 兼容层）的 UI 管理通道。
 * 挂载：feature-routes-runtime.js → registerPigeonRoutes(app)
 */
const SIDECAR_URL = process.env.PIGEON_SIDECAR_URL || 'http://127.0.0.1:3211';

export function registerPigeonRoutes(app) {
  const proxied = (req) => {
    const target = req.path.replace(/^\/api\/pigeon/, '') || '/health';
    const qs = Object.keys(req.query || {}).length
      ? `?${new URLSearchParams(req.query).toString()}`
      : '';
    return `${SIDECAR_URL}${target}${qs}`;
  };

  const proxy = async (req, res, method) => {
    try {
      const headers = { 'content-type': 'application/json' };
      const body = method === 'GET' ? undefined : JSON.stringify(req.body ?? {});
      const upstream = await fetch(proxied(req), { method, headers, body });
      const text = await upstream.text();
      res.status(upstream.status).type('json').send(text);
    } catch (error) {
      console.error('[pigeon-proxy] sidecar unreachable:', error?.message || error);
      res.status(502).json({ ok: false, error: 'sidecar unreachable', detail: String(error?.message || error).slice(0, 200) });
    }
  };

  app.get('/api/pigeon/*rest', (req, res) => void proxy(req, res, 'GET'));
  app.post('/api/pigeon/*rest', (req, res) => void proxy(req, res, 'POST'));
  app.delete('/api/pigeon/*rest', (req, res) => void proxy(req, res, 'DELETE'));
}
