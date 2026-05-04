/* ============================================================
   Electoral API client · scrutix.co
   Base URL: https://app.scrutix.co/api/electoral/v1
   Auth:     Authorization: Bearer sk_electoral_<key>
   ============================================================ */

const ElectoralAPI = (() => {
  const BASE = 'https://app.scrutix.co/api/electoral/v1';
  const MUNICIPALITY_CODE = '214'; // Rionegro, Antioquia
  const KEY_STORAGE = 'electoral_api_key';

  // In-memory cache: keyed by URL+params hash
  const cache = new Map();

  /** Get API key from sessionStorage. */
  function getKey() {
    return sessionStorage.getItem(KEY_STORAGE) || '';
  }

  /** Persist API key for the current tab session. */
  function setKey(key) {
    sessionStorage.setItem(KEY_STORAGE, key);
  }

  /** Clear API key and reset caches. */
  function clearKey() {
    sessionStorage.removeItem(KEY_STORAGE);
    cache.clear();
  }

  function hasKey() {
    return !!getKey();
  }

  /** Build URL with query parameters, skipping empty values. */
  function buildURL(path, params = {}) {
    const url = new URL(BASE + path);
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
    const url = buildURL(path, params);
    const useCache = opts.cache !== false;

    if (useCache && cache.has(url)) {
      return cache.get(url);
    }

    const key = getKey();
    if (!key) {
      throw new APIError('No hay API key configurada.', { code: 'NO_KEY' });
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Accept': 'application/json',
        },
      });
    } catch (err) {
      throw new APIError('No se pudo conectar a la API electoral. Verifica tu conexión.', {
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

      if (resp.status === 401 || resp.status === 403) {
        throw new APIError(detail || 'API key inválida o sin permisos.', {
          code: 'AUTH',
          status: resp.status,
        });
      }
      if (resp.status === 429) {
        throw new APIError('Has superado el límite de consultas. Espera un momento.', {
          code: 'RATE_LIMIT',
          status: 429,
        });
      }
      throw new APIError(detail || `Error ${resp.status} de la API.`, {
        code: 'HTTP',
        status: resp.status,
      });
    }

    const data = await resp.json();
    if (useCache) cache.set(url, data);
    return data;
  }

  /** Validate the current key by hitting /elections. Throws on failure. */
  async function validateKey() {
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

  /** GET /benchmark — top candidates and parties for a corporation in a municipality. */
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
    getKey, setKey, clearKey, hasKey,
    validateKey,
    getElections,
    getCorporations,
    getBenchmark,
    getMap,
    getStation,
    getContextAI,
  };
})();
