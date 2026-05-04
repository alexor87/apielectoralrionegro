/**
 * Electoral proxy · Cloudflare Worker
 *
 * Proxies the GitHub Pages frontend to scrutix.co's electoral API.
 * Keeps the scrutix API key as a secret so it never reaches the browser.
 * Gates access with a shared password sent via `X-Portal-Password`.
 *
 * Secrets (set with `wrangler secret put`):
 *   - SCRUTIX_API_KEY   The real `sk_electoral_...` token.
 *   - PORTAL_PASSWORD   Shared password the alcaldía's team will use.
 *
 * Vars (in wrangler.toml):
 *   - ALLOWED_ORIGINS   Comma-separated list of allowed CORS origins.
 *   - UPSTREAM_BASE     Optional override of the upstream API base URL.
 */

const DEFAULT_UPSTREAM = 'https://app.scrutix.co/api/electoral/v1';

// Only these endpoints can be proxied. Any other path returns 404.
const ALLOWED_PATHS = new Set([
  '/elections',
  '/corporations',
  '/benchmark',
  '/map',
  '/station',
  '/context-ai',
]);

export default {
  async fetch(request, env) {
    // CORS preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method !== 'GET') {
      return errorResponse(405, 'Método no permitido.', request, env);
    }

    const url = new URL(request.url);

    if (!ALLOWED_PATHS.has(url.pathname)) {
      return errorResponse(404, 'Endpoint no permitido.', request, env);
    }

    // Server must be configured before it can do anything useful.
    if (!env.SCRUTIX_API_KEY || !env.PORTAL_PASSWORD) {
      return errorResponse(
        500,
        'Worker mal configurado: faltan secretos SCRUTIX_API_KEY o PORTAL_PASSWORD.',
        request,
        env
      );
    }

    // Password gate. Constant-time comparison to avoid trivial timing leaks.
    const provided = request.headers.get('X-Portal-Password') || '';
    if (!timingSafeEqual(provided, env.PORTAL_PASSWORD)) {
      return errorResponse(401, 'Contraseña inválida.', request, env);
    }

    // Build the upstream URL preserving the query string.
    const base = (env.UPSTREAM_BASE || DEFAULT_UPSTREAM).replace(/\/$/, '');
    const upstreamUrl = `${base}${url.pathname}${url.search}`;

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${env.SCRUTIX_API_KEY}`,
          'Accept': 'application/json',
        },
        cf: { cacheEverything: false },
      });
    } catch (err) {
      return errorResponse(502, 'Error contactando la API electoral.', request, env);
    }

    // Pass the upstream response through, but rewrite headers so CORS works
    // and we don't leak any unexpected upstream headers.
    const respHeaders = new Headers();
    respHeaders.set('Content-Type', upstreamResp.headers.get('Content-Type') || 'application/json');
    const cacheCtl = upstreamResp.headers.get('Cache-Control');
    if (cacheCtl) respHeaders.set('Cache-Control', cacheCtl);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) {
      respHeaders.set(k, v);
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedRaw = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  let allowOrigin;
  if (allowedRaw.includes('*')) {
    allowOrigin = '*';
  } else if (allowedRaw.includes(origin)) {
    allowOrigin = origin;
  } else {
    // Default to the first allowed origin so misconfigured callers still get
    // a clear CORS error rather than a confusing one.
    allowOrigin = allowedRaw[0] || 'null';
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Portal-Password',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function errorResponse(status, message, request, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
    },
  });
}

/** Length-safe (not fully timing-safe) string compare; good enough for a low-stakes shared password. */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}
