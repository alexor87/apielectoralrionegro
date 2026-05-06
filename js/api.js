/* ============================================================
   Electoral API client (modo local)
   Lee los JSON estáticos en /data/ generados desde el CSV oficial
   de la Registraduría (ver _data/build.js). El portal ya no depende
   de scrutix.co — los datos viajan con el repo.
   ============================================================ */

const ElectoralAPI = (() => {
  const MUNICIPALITY_CODE = '214'; // Rionegro, Antioquia
  const DATA_BASE = 'data';

  // In-memory cache of fetched JSON, keyed by URL.
  const fileCache = new Map();

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

  async function fetchJson(relPath) {
    if (fileCache.has(relPath)) return fileCache.get(relPath);

    let resp;
    try {
      resp = await fetch(`${DATA_BASE}/${relPath}`, {
        headers: { 'Accept': 'application/json' },
      });
    } catch (err) {
      throw new APIError('No se pudo cargar el archivo de datos.', {
        code: 'NETWORK',
        cause: err,
      });
    }
    if (!resp.ok) {
      throw new APIError(`Datos no disponibles (${resp.status}).`, {
        code: 'HTTP',
        status: resp.status,
      });
    }
    const data = await resp.json();
    fileCache.set(relPath, data);
    return data;
  }

  function getResults(electionId, corporationCode) {
    return fetchJson(`results/${electionId}_${corporationCode}.json`);
  }

  // ----------------------------------------------------------------
  // Public surface — same shape as the previous scrutix-backed client
  // ----------------------------------------------------------------

  function getElections() {
    return fetchJson('elections.json');
  }

  function getCorporations(electionId) {
    return fetchJson(`corporations/${electionId}.json`);
  }

  async function getBenchmark(electionId, corporationCode) {
    const r = await getResults(electionId, corporationCode);
    return r.benchmark;
  }

  async function getMap(electionId, corporationCode) {
    const r = await getResults(electionId, corporationCode);
    return { polling_stations: r.polling_stations };
  }

  async function getStation(electionId, corporationCode, stationCode) {
    const r = await getResults(electionId, corporationCode);
    const detail = r.stations_detail?.[stationCode];
    if (!detail) {
      throw new APIError('Puesto no encontrado en los datos locales.', {
        code: 'NOT_FOUND',
        status: 404,
      });
    }
    return detail;
  }

  async function getContextAI(electionId, corporationCode) {
    // Build a compact context on demand from the cached results JSON.
    const r = await getResults(electionId, corporationCode);
    return {
      election_id: r.election_id,
      corporation_code: r.corporation_code,
      corporation_name: r.corporation_name,
      municipality_code: r.municipality_code,
      municipality_name: r.municipality_name,
      total_votes: r.benchmark.total_votes,
      polling_stations_count: r.benchmark.polling_stations_count,
      top_candidates: r.benchmark.candidates.slice(0, 10),
      top_parties: r.benchmark.parties.slice(0, 10),
      polling_stations: r.polling_stations.map(s => ({
        polling_station_code: s.polling_station_code,
        polling_station_name: s.polling_station_name,
        commune: s.commune,
        total_votes: s.total_votes,
        mesa_count: s.mesa_count,
        top_candidate_name: s.top_candidate_name,
        top_candidate_votes: s.top_candidate_votes,
        top_party_name: s.top_party_name,
      })),
    };
  }

  // ----------------------------------------------------------------
  // Legacy auth no-ops — datos ahora son públicos, no hay password
  // ----------------------------------------------------------------
  function isConfigured() { return true; }
  function hasPassword()  { return true; }
  function getPassword()  { return ''; }
  function setPassword(_) { /* no-op */ }
  function clearPassword() { fileCache.clear(); }
  async function validateAuth() { return getElections(); }

  return {
    MUNICIPALITY_CODE,
    APIError,
    isConfigured,
    getPassword, setPassword, clearPassword, hasPassword,
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
