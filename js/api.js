/* ============================================================
   Electoral API client
   Talks to the Cloudflare Worker proxy (see /worker), not directly
   to scrutix.co — the real API key lives only inside the Worker.
   The browser sends a shared password via `X-Portal-Password`.
   ============================================================ */

const ElectoralAPI = (() => {
  const MUNICIPALITY_CODE = '214'; // Rionegro, Antioquia
  const PWD_STORAGE = 'electoral_portal_password';

  // In-memory cache: keyed by URL+params hash
  const cache = new Map();

  /** Resolve the proxy base URL from window config. */
  function getProxyBase() {
    const base = (window.PORTAL_CONFIG && window.PORTAL_CONFIG.PROXY_URL) || '';
    return base.replace(/\/$/, '');
  }

  /** Whether the frontend is wired up to a real Worker. */
  function isConfigured() {
    const base = getProxyBase();
    return !!base && !/YOUR-/i.test(base);
  }

  /** Get the access password from localStorage. */
  function getPassword() {
    return localStorage.getItem(PWD_STORAGE) || '';
  }

  function setPassword(value) {
    localStorage.setItem(PWD_STORAGE, value);
  }

  function clearPassword() {
    localStorage.removeItem(PWD_STORAGE);
    cache.clear();
  }

  function hasPassword() {
    return !!getPassword();
  }

  /** Build URL with query parameters, skipping empty values. */
  function buildURL(path, params = {}) {
    const url = new URL(getProxyBase() + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Low-level fetch with auth, error normalization, and optional caching.
   * @param {string} path - API path beginning with `/`
   * @param {object} params - query params
   * @param {object} [opts] - { cache: boolean }
   */
  async function request(path, params = {}, opts = {}) {
    if (!isConfigured()) {
      throw new APIError(
        'El portal no tiene PROXY_URL configurada. Edita js/config.js con la URL del Cloudflare Worker.',
        { code: 'NO_PROXY' }
      );
    }

    const url = buildURL(path, params);
    const useCache = opts.cache !== false;

    if (useCache && cache.has(url)) {
      return cache.get(url);
    }

    const password = getPassword();
    if (!password) {
      throw new APIError('No hay contraseña configurada.', { code: 'NO_AUTH' });
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Portal-Password': password,
          'Accept': 'application/json',
        },
      });
    } catch (err) {
      throw new APIError('No se pudo conectar al servidor. Verifica tu conexión.', {
        code: 'NETWORK',
        cause: err,
      });
    }

    if (!resp.ok) {
      let detail = '';
      try {
        const body = await resp.json();
        detail = body?.message || body?.error || '';
      } catch (_) { /* not json */ }

      if (resp.status === 401) {
        throw new APIError(detail || 'Contraseña inválida.', {
          code: 'AUTH',
          status: 401,
        });
      }
      if (resp.status === 403) {
        throw new APIError(detail || 'Acceso denegado.', {
          code: 'AUTH',
          status: 403,
        });
      }
      if (resp.status === 429) {
        throw new APIError('Has superado el límite de consultas. Espera un momento.', {
          code: 'RATE_LIMIT',
          status: 429,
        });
      }
      if (resp.status === 502 || resp.status === 504) {
        throw new APIError(detail || 'La API electoral no está respondiendo.', {
          code: 'UPSTREAM',
          status: resp.status,
        });
      }
      throw new APIError(detail || `Error ${resp.status} en la consulta.`, {
        code: 'HTTP',
        status: resp.status,
      });
    }

    const data = await resp.json();
    if (useCache) cache.set(url, data);
    return data;
  }

  /** Validate the current password by hitting /elections. Throws on failure. */
  async function validateAuth() {
    return request('/elections', {}, { cache: false });
  }

  /** GET /elections — list of available elections. */
  function getElections() {
    return request('/elections');
  }

  /** GET /corporations?election_id=…&municipality_code=214 */
  function getCorporations(electionId) {
    return request('/corporations', {
      election_id: electionId,
      municipality_code: MUNICIPALITY_CODE,
    });
  }

  /** GET /benchmark — top candidates and parties for a corporation. */
  function getBenchmark(electionId, corporationCode) {
    return request('/benchmark', {
      election_id: electionId,
      municipality_code: MUNICIPALITY_CODE,
      corporation_code: corporationCode,
    });
  }

  /** GET /map — results by polling station, with candidate breakdown. */
  function getMap(electionId, corporationCode) {
    return request('/map', {
      election_id: electionId,
      municipality_code: MUNICIPALITY_CODE,
      corporation_code: corporationCode,
    });
  }

  /** GET /station — full detail for a single polling station. */
  function getStation(electionId, corporationCode, stationCode) {
    return request('/station', {
      election_id: electionId,
      municipality_code: MUNICIPALITY_CODE,
      corporation_code: corporationCode,
      polling_station_code: stationCode,
    });
  }

  /** GET /context-ai — pre-computed compact context for LLM consumption. */
  function getContextAI(electionId, corporationCode) {
    return request('/context-ai', {
      election_id: electionId,
      municipality_code: MUNICIPALITY_CODE,
      corporation_code: corporationCode,
    });
  }

  /** Custom error with structured info. */
  class APIError extends Error {
    constructor(message, info = {}) {
      super(message);
      this.name = 'APIError';
      this.code = info.code || 'UNKNOWN';
      this.status = info.status;
      this.cause = info.cause;
    }
  }

  return {
    MUNICIPALITY_CODE,
    APIError,
    isConfigured,
    getPassword, setPassword, clearPassword, hasPassword,
    // Backwards-compatible aliases used by older app code paths.
    hasKey: hasPassword,
    setKey: setPassword,
    getKey: getPassword,
    clearKey: clearPassword,
    validateKey: validateAuth,
    validateAuth,
    getElections,
    getCorporations,
    getBenchmark,
    getMap,
    getStation,
    getContextAI,
  };
})();
