/* ============================================================
   Portal Electoral · Rionegro
   Main application: state, views, events.
   ============================================================ */

'use strict';

// ----------------------------------------------------------------
// State
// ----------------------------------------------------------------
const state = {
  elections: [],
  corporations: [],
  electionId: null,
  corporationCode: null,
  benchmark: null,
  mapData: null,
  view: 'summary',
  partyFilter: '',
  stationSearch: '',
  mapMode: 'votes',           // 'votes' | 'winner' (only used when no candidate selected)
  mapCandidate: '',           // candidate name, or '' for "ganador por puesto"
  loading: false,
};

// Leaflet handles (lazy-initialized on first map render)
const mapState = {
  map: null,
  heatLayer: null,
  markersLayer: null,
};

// Per-station candidate-vote enrichment (lazy-loaded on first map view).
// `byCandidate` is a Map<candidateName, Map<stationCode, votes>>.
const mapEnrich = {
  forKey: null,    // electionId|corporationCode this data belongs to
  loading: false,
  done: false,
  byCandidate: new Map(),
};

// ----------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmt = ChartHelpers.formatNumber;
const fmtPct = ChartHelpers.formatPct;

/** Best-effort field accessor across possible API field-name variants. */
function pick(obj, ...keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

/** Coerce an API response to an array — handles `[...]`, `{data: [...]}`, etc. */
function toArray(payload, ...nestedKeys) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const k of nestedKeys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function showToast(msg, kind = '') {
  const host = $('#toast-host');
  const t = document.createElement('div');
  t.className = `toast ${kind ? 'toast--' + kind : ''}`;
  t.textContent = msg;
  host.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ----------------------------------------------------------------
// Setup screen
// ----------------------------------------------------------------
async function handleSetupSubmit(ev) {
  ev.preventDefault();
  const input = $('#api-key-input');
  const password = input.value.trim();
  if (!password) return;

  const btn = $('#connect-btn');
  const errBox = $('#setup-error');
  errBox.hidden = true;

  if (!ElectoralAPI.isConfigured()) {
    errBox.textContent = 'El portal no tiene PROXY_URL configurada. Edita js/config.js con la URL del Cloudflare Worker.';
    errBox.hidden = false;
    return;
  }

  btn.disabled = true;
  $('.btn__label', btn).hidden = true;
  $('.btn__spinner', btn).hidden = false;

  ElectoralAPI.setPassword(password);

  try {
    await ElectoralAPI.validateAuth();
    showApp();
    bootstrap();
  } catch (err) {
    ElectoralAPI.clearPassword();
    errBox.textContent = err.message || 'No se pudo validar la contraseña.';
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
    $('.btn__label', btn).hidden = false;
    $('.btn__spinner', btn).hidden = true;
  }
}

function showSetup() {
  $('#setup-screen').hidden = false;
  $('#app').hidden = true;
  $('#api-key-input').focus();
}

function showApp() {
  $('#setup-screen').hidden = true;
  $('#app').hidden = false;
}

// ----------------------------------------------------------------
// Bootstrap: load elections, then default corporation
// ----------------------------------------------------------------
async function bootstrap() {
  setLoading(true);
  try {
    const electionsResp = await ElectoralAPI.getElections();
    state.elections = normalizeElections(electionsResp);

    if (state.elections.length === 0) {
      showError('La API no retornó elecciones disponibles.');
      return;
    }

    populateElectionSelect();
    // Default: most recent
    state.electionId = state.elections[0].id;
    $('#election-select').value = state.electionId;

    await loadCorporations();
  } catch (err) {
    if (err.code === 'AUTH') {
      ElectoralAPI.clearKey();
      showSetup();
      $('#setup-error').textContent = err.message;
      $('#setup-error').hidden = false;
      return;
    }
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

function normalizeElections(payload) {
  const arr = toArray(payload, 'elections');
  return arr.map(e => ({
    id: pick(e, 'id', 'election_id', 'uuid'),
    name: pick(e, 'name', 'title', 'label') || `Elección`,
    year: pick(e, 'year', 'election_year'),
    date: pick(e, 'date', 'election_date'),
  })).filter(e => e.id);
}

function populateElectionSelect() {
  const sel = $('#election-select');
  sel.innerHTML = '';
  for (const e of state.elections) {
    const opt = document.createElement('option');
    opt.value = e.id;
    const yearLabel = e.year ? ` · ${e.year}` : (e.date ? ` · ${e.date.slice(0,4)}` : '');
    opt.textContent = `${e.name}${yearLabel}`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

async function loadCorporations() {
  try {
    const resp = await ElectoralAPI.getCorporations(state.electionId);
    state.corporations = normalizeCorporations(resp);
    populateCorporationSelect();

    if (state.corporations.length === 0) {
      showError('No hay cargos disponibles para esta elección en Rionegro.');
      return;
    }

    // Default: prefer Alcaldía (003 in the Registraduría coding for territoriales),
    // else any name match, else first.
    const def =
      state.corporations.find(c => /alcald/i.test(c.name)) ||
      state.corporations.find(c => String(c.code) === '003') ||
      state.corporations[0];
    state.corporationCode = def.code;
    $('#corporation-select').value = def.code;

    await loadElectionData();
  } catch (err) {
    showError(err.message);
  }
}

// Friendly Spanish labels for known corporation codes (Registraduría · territoriales).
const CORPORATION_LABELS = {
  '001': 'Gobernación',
  '002': 'Asamblea Departamental',
  '003': 'Alcaldía',
  '004': 'Concejo Municipal',
  '005': 'JAL',
};

function normalizeCorporations(payload) {
  const arr = toArray(payload, 'corporations');
  return arr.map(c => {
    const code = String(pick(c, 'corporation_code', 'code', 'id') ?? '');
    const rawName = pick(c, 'corporation', 'name', 'title', 'label') || '';
    return {
      code,
      name: CORPORATION_LABELS[code] || titleCase(rawName) || 'Cargo',
      totalVotes: Number(pick(c, 'total_votes')) || 0,
    };
  }).filter(c => c.code);
}

/** Convert ALL CAPS text to Title Case, leaving acronyms ≤ 3 chars upper. */
function titleCase(s) {
  if (!s) return '';
  return s.toLowerCase().split(/\s+/).map(w => {
    if (w.length <= 3) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');
}

function populateCorporationSelect() {
  const sel = $('#corporation-select');
  sel.innerHTML = '';
  for (const c of state.corporations) {
    const opt = document.createElement('option');
    opt.value = c.code;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

// ----------------------------------------------------------------
// Load benchmark + map in parallel
// ----------------------------------------------------------------
async function loadElectionData() {
  setLoading(true);
  hideError();
  try {
    const [bench, map] = await Promise.all([
      ElectoralAPI.getBenchmark(state.electionId, state.corporationCode),
      ElectoralAPI.getMap(state.electionId, state.corporationCode),
    ]);
    state.benchmark = normalizeBenchmark(bench);
    state.mapData = normalizeMap(map);

    // Reset map state for the new election/cargo
    mapEnrich.forKey = null;
    mapEnrich.loading = false;
    mapEnrich.done = false;
    mapEnrich.byCandidate = new Map();
    state.mapCandidate = '';
    if (mapState._fitted) mapState._fitted = false;

    $('#ai-global-btn').disabled = false;
    renderAll();

    // If /benchmark looks capped (>= 27 real candidates), kick off a background
    // enrichment that unions per-station candidate data to surface candidates
    // beyond the API top-30 cap. This helps for Concejo / Asamblea / JAL where
    // the real candidate count is higher than the cap.
    if (state.benchmark.candidates.length >= 27 && state.mapData?.stations?.length > 0) {
      enrichCandidatesFromStations(state.electionId, state.corporationCode);
    }
  } catch (err) {
    if (err.code === 'AUTH') {
      ElectoralAPI.clearKey();
      showSetup();
      return;
    }
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

/**
 * Background enrichment: when /benchmark hits its top-30 cap, fetch all
 * /station endpoints in parallel and union the candidates seen across the
 * 11 stations. Each /station returns its own top candidates (~10 per puesto).
 * For real candidates (party_code != "00000"), we sum their votes across all
 * stations where they appear and merge into the global candidate list.
 *
 * Caveats this leaves visible to the user:
 *   - For supplemental candidates (not in /benchmark), the vote total is a
 *     LOWER BOUND — only counts stations where they made the local top 10.
 *   - We mark these candidates with `_partial: true` so the UI can flag them.
 */
async function enrichCandidatesFromStations(electionId, corporationCode) {
  const stations = state.mapData?.stations || [];
  if (stations.length === 0) return;

  // Show a hint while loading
  state.benchmark._enriching = true;
  if (state.view === 'candidates') renderCandidates();

  try {
    const results = await Promise.all(
      stations.map(s =>
        ElectoralAPI.getStation(electionId, corporationCode, s.code)
          .catch(() => null)
      )
    );

    // Guard: user could have switched cargo during the wait.
    if (state.electionId !== electionId || state.corporationCode !== corporationCode) {
      return;
    }

    // Build a lookup of known candidates by normalized (name|party) key.
    const norm = (s) => String(s || '').trim().toUpperCase();
    const keyOf = (name, party) => `${norm(name)}|${norm(party)}`;

    const known = new Map();
    for (const c of state.benchmark.candidates) {
      known.set(keyOf(c.name, c.party), c);
    }

    // Tally votes for unknown candidates across all stations.
    const supplemental = new Map();
    for (const r of results) {
      if (!r) continue;
      const cands = toArray(r, 'top_candidates', 'candidates');
      for (const c of cands) {
        const name  = pick(c, 'candidate_name', 'name');
        const party = pick(c, 'party_name', 'party');
        if (!name) continue;

        // Skip pseudo-candidates (blanco/nulos/no marcados)
        if (isInvalidVotePseudo({
          name,
          party_code: pick(c, 'party_code'),
        })) continue;

        const key = keyOf(name, party);
        if (known.has(key)) continue; // benchmark already has accurate total

        const votes = Number(pick(c, 'votes', 'total_votes')) || 0;
        const existing = supplemental.get(key);
        if (existing) {
          existing.votes += votes;
        } else {
          supplemental.set(key, {
            name,
            party,
            partyCode: pick(c, 'party_code'),
            votes,
            pct: null,
            _partial: true,
          });
        }
      }
    }

    if (supplemental.size === 0) {
      state.benchmark._enriching = false;
      if (state.view === 'candidates') renderCandidates();
      return;
    }

    // Merge: existing benchmark candidates + supplemental ones. Recompute pct
    // for supplemental against total_votes from /benchmark.
    const totalVotes = state.benchmark.totalVotes;
    const merged = state.benchmark.candidates.slice();
    for (const c of supplemental.values()) {
      c.pct = totalVotes ? (c.votes / totalVotes) * 100 : 0;
      merged.push(c);
    }
    merged.sort((a, b) => b.votes - a.votes);

    state.benchmark.candidates = merged;
    state.benchmark.totalCandidates = merged.length;
    state.benchmark._enriched = true;
    state.benchmark._enriching = false;

    if (state.view === 'candidates') renderCandidates();
    if (state.view === 'summary') renderSummary();
  } catch (err) {
    state.benchmark._enriching = false;
    if (state.view === 'candidates') renderCandidates();
  }
}

// Pseudo-candidates returned by the Registraduría that aren't real candidates:
// blank votes, null votes, unmarked ballots. They live under party_code "00000"
// (party_name "CANDIDATOS TOTALES"). We separate them so they don't pollute rankings.
const INVALID_VOTE_NAMES = new Set(['VOTOS EN BLANCO', 'VOTOS NULOS', 'VOTOS NO MARCADOS']);

function isInvalidVotePseudo(item) {
  const code = String(item.partyCode ?? item.party_code ?? '');
  if (code === '00000') return true;
  const name = String(item.name || item.candidate_name || '').toUpperCase().trim();
  if (INVALID_VOTE_NAMES.has(name)) return true;
  return false;
}

function normalizeBenchmark(payload) {
  if (!payload) return null;
  const root = payload.data || payload;

  const candidatesRaw = toArray(root, 'top_candidates', 'candidates');
  const partiesRaw    = toArray(root, 'by_party', 'top_parties', 'parties');

  const allCandidates = candidatesRaw.map(c => ({
    code:      pick(c, 'candidate_code'),
    name:      pick(c, 'candidate_name', 'name', 'full_name') || '—',
    party:     pick(c, 'party_name', 'party', 'political_party') || '—',
    partyCode: pick(c, 'party_code'),
    list:      pick(c, 'list_number', 'list', 'ballot_number'),
    votes:     Number(pick(c, 'votes', 'total_votes', 'vote_count')) || 0,
    pct:       Number(pick(c, 'pct', 'percentage', 'vote_pct')) || null,
  }));

  const allParties = partiesRaw.map(p => ({
    name:      pick(p, 'party_name', 'name') || '—',
    partyCode: pick(p, 'party_code'),
    votes:     Number(pick(p, 'votes', 'total_votes')) || 0,
    pct:       Number(pick(p, 'pct', 'percentage', 'vote_pct')) || null,
    candidatesCount: Number(pick(p, 'candidates')) || null,
  }));

  // Split real entries from invalid-vote pseudo-entries.
  const candidates = allCandidates.filter(c => !isInvalidVotePseudo(c));
  const parties    = allParties.filter(p => !isInvalidVotePseudo(p));

  // Totals: prefer explicit, else derive from full list (incl. invalid votes).
  const totalVotes = Number(pick(root, 'total_votes', 'valid_votes', 'total_valid_votes'))
    || allCandidates.reduce((s, c) => s + c.votes, 0);

  // Tally invalid-vote pseudo-entries for a separate "blank/null/unmarked" metric.
  const invalidByName = {};
  for (const c of allCandidates) {
    if (!isInvalidVotePseudo(c)) continue;
    invalidByName[c.name.toUpperCase().trim()] = c.votes;
  }
  const blankVotes    = invalidByName['VOTOS EN BLANCO']    || 0;
  const nullVotes     = invalidByName['VOTOS NULOS']        || 0;
  const unmarkedVotes = invalidByName['VOTOS NO MARCADOS']  || 0;

  // Compute % if missing (relative to total valid votes).
  for (const c of candidates) {
    if (c.pct == null) c.pct = totalVotes ? (c.votes / totalVotes) * 100 : 0;
  }
  for (const p of parties) {
    if (p.pct == null) p.pct = totalVotes ? (p.votes / totalVotes) * 100 : 0;
  }

  return {
    candidates,
    parties,
    totalVotes,
    totalCandidates: candidates.length,
    totalParties:    parties.length,
    totalStations:   Number(pick(root, 'polling_stations_count', 'stations_count')) || null,
    invalidVotes: { blank: blankVotes, null: nullVotes, unmarked: unmarkedVotes },
  };
}

function normalizeMap(payload) {
  if (!payload) return null;
  const root = payload.data || payload;
  const stationsRaw = toArray(root, 'polling_stations', 'stations', 'puestos');

  const stations = stationsRaw.map(s => {
    const totalVotes = Number(pick(s, 'total_votes', 'valid_votes', 'votes')) || 0;
    const topVotes   = Number(pick(s, 'top_candidate_votes', 'top_votes')) || 0;
    const topName    = pick(s, 'top_candidate_name', 'top_candidate') || '—';
    const topParty   = pick(s, 'top_party_name', 'top_party') || '—';
    const topPct     = totalVotes ? (topVotes / totalVotes) * 100 : 0;

    return {
      code:       String(pick(s, 'polling_station_code', 'station_code', 'code', 'id') ?? ''),
      name:       pick(s, 'polling_station_name', 'station_name', 'name') || 'Puesto',
      zone:       pick(s, 'commune', 'zone', 'comuna', 'district') || '',
      zoneCode:   pick(s, 'commune_code', 'zone_code') || '',
      address:    pick(s, 'address', 'location') || '',
      totalVotes,
      mesaCount:  Number(pick(s, 'mesa_count', 'tables_count')) || 0,
      lat:        pick(s, 'lat'),
      lng:        pick(s, 'lng'),
      topCandidate: { name: topName, party: topParty, votes: topVotes, pct: topPct },
      // Kept for compatibility with code that expects an array; only the winner is known here.
      candidates: topName !== '—'
        ? [{ name: topName, party: topParty, votes: topVotes, pct: topPct }]
        : [],
    };
  }).filter(s => s.code);

  // Sort by total votes descending
  stations.sort((a, b) => b.totalVotes - a.totalVotes);

  return { stations };
}

// ----------------------------------------------------------------
// Loading / Error states
// ----------------------------------------------------------------
function setLoading(loading) {
  state.loading = loading;
  $('#content-loading').hidden = !loading;
  if (loading) {
    $$('.view').forEach(v => v.hidden = true);
  }
}

function showError(msg) {
  const box = $('#content-error');
  box.textContent = msg;
  box.hidden = false;
  $$('.view').forEach(v => v.hidden = true);
}

function hideError() {
  $('#content-error').hidden = true;
}

// ----------------------------------------------------------------
// Render: route to active view
// ----------------------------------------------------------------
function renderAll() {
  if (!state.benchmark) return;

  const elec = state.elections.find(e => e.id === state.electionId);
  const corp = state.corporations.find(c => c.code === state.corporationCode);
  const ctxText = `${elec?.name || ''}${elec?.year ? ' · ' + elec.year : ''} · ${corp?.name || ''}`;
  $('#summary-context').textContent = ctxText;

  // Show current view, hide others
  $$('.view').forEach(v => v.hidden = true);
  hideError();

  switch (state.view) {
    case 'summary':    renderSummary(); $('#view-summary').hidden = false; break;
    case 'candidates': renderCandidates(); $('#view-candidates').hidden = false; break;
    case 'parties':    renderParties(); $('#view-parties').hidden = false; break;
    case 'stations':   renderStations(); $('#view-stations').hidden = false; break;
    case 'map':        $('#view-map').hidden = false; renderMap(); break;
  }
}

// ----------------------------------------------------------------
// View 1 · Summary
// ----------------------------------------------------------------
function renderSummary() {
  const b = state.benchmark;
  if (!b) return;

  const stationsCount = b.totalStations ?? state.mapData?.stations?.length ?? 0;

  $('#m-total-votes').textContent = fmt(b.totalVotes);
  $('#m-candidates').textContent = fmt(b.totalCandidates);
  $('#m-parties').textContent = fmt(b.totalParties);
  $('#m-stations').textContent = fmt(stationsCount);

  // Hint on the votes card: surface blank/null votes (politically meaningful).
  const inv = b.invalidVotes || {};
  const parts = [];
  if (inv.blank)    parts.push(`${fmt(inv.blank)} en blanco`);
  if (inv.null)     parts.push(`${fmt(inv.null)} nulos`);
  if (inv.unmarked) parts.push(`${fmt(inv.unmarked)} no marcados`);
  $('#m-total-votes-hint').textContent = parts.length ? parts.join(' · ') : '';

  const winner = b.candidates[0];
  if (winner) {
    $('#winner-card').hidden = false;
    $('#winner-name').textContent = winner.name;
    const list = winner.list ? ` · Lista ${winner.list}` : '';
    $('#winner-party').textContent = `${winner.party}${list}`;
    $('#winner-votes').textContent = fmt(winner.votes);
    $('#winner-pct').textContent = fmtPct(winner.pct);
  } else {
    $('#winner-card').hidden = true;
  }

  // Top 5 candidates
  const top5c = b.candidates.slice(0, 5);
  const maxC = Math.max(...top5c.map(c => c.votes), 1);
  $('#top-candidates').innerHTML = top5c.map((c, i) => barRow({
    color: ChartHelpers.color(i),
    name: c.name,
    sub: c.party + (c.list ? ` · L${c.list}` : ''),
    value: c.votes,
    pct: c.pct,
    width: ChartHelpers.pctOfMax(c.votes, maxC),
  })).join('') || emptyState('No hay datos de candidatos.');

  // Top 5 parties
  const top5p = b.parties.slice(0, 5);
  const maxP = Math.max(...top5p.map(p => p.votes), 1);
  $('#top-parties').innerHTML = top5p.map((p, i) => barRow({
    color: ChartHelpers.color(i),
    name: p.name,
    sub: '',
    value: p.votes,
    pct: p.pct,
    width: ChartHelpers.pctOfMax(p.votes, maxP),
  })).join('') || emptyState('No hay datos de partidos.');
}

function barRow({ color, name, sub, value, pct, width }) {
  return `
    <div class="bar-row">
      <span class="bar-row__color" style="background:${color}"></span>
      <div class="bar-row__main">
        <div class="bar-row__top">
          <span class="bar-row__name">${escapeHtml(name)}</span>
          ${sub ? `<span class="bar-row__party">${escapeHtml(sub)}</span>` : ''}
        </div>
        <div class="bar-row__bar">
          <div class="bar-row__fill" style="width:${width}%; background:${color}"></div>
        </div>
      </div>
      <div class="bar-row__nums">
        <span class="bar-row__votes">${fmt(value)}</span>
        <span class="bar-row__pct">${fmtPct(pct)}</span>
      </div>
    </div>`;
}

// ----------------------------------------------------------------
// View 2 · Candidates
// ----------------------------------------------------------------
function renderCandidates() {
  const b = state.benchmark;
  if (!b) return;

  // Populate party filter (unique parties)
  const partySet = new Set(b.candidates.map(c => c.party).filter(Boolean));
  const sel = $('#party-filter');
  const currentVal = state.partyFilter;
  sel.innerHTML = '<option value="">Todos los partidos</option>' +
    Array.from(partySet).sort().map(p =>
      `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`
    ).join('');
  sel.value = currentVal;

  let list = b.candidates;
  if (state.partyFilter) {
    list = list.filter(c => c.party === state.partyFilter);
  }

  // Subtitle: candidate count + enrichment status, so the user always knows
  // how many candidates the API exposed and whether more data is loading.
  const total = b.candidates.length;
  const partial = b.candidates.filter(c => c._partial).length;
  let sub;
  if (b._enriching) {
    sub = `Cargando candidatos adicionales desde los puestos…`;
  } else if (b._enriched && partial > 0) {
    sub = `${fmt(total)} candidatos · ${fmt(partial)} suplementados desde puestos (votación parcial).`;
  } else if (total >= 27 && !b._enriched) {
    sub = `${fmt(total)} candidatos · puede haber más fuera del top 30 de la API.`;
  } else {
    sub = `${fmt(total)} candidatos${state.partyFilter ? ` · ${fmt(list.length)} en "${state.partyFilter}"` : ''}.`;
  }
  const subEl = $('#candidates-sub');
  if (subEl) subEl.textContent = sub;

  const maxV = Math.max(...list.map(c => c.votes), 1);

  $('#candidate-list').innerHTML = list.map((c, i) => {
    const isPartial = c._partial;
    return `
      <div class="candidate-row${isPartial ? ' candidate-row--partial' : ''}">
        <span class="candidate-row__rank">${i + 1}</span>
        <div class="candidate-row__name">
          <span class="candidate-row__color" style="background:${ChartHelpers.color(i)}"></span>
          <div class="candidate-row__text">
            <span class="candidate-row__person">
              ${escapeHtml(c.name)}
              ${isPartial ? '<span class="candidate-row__flag" title="Datos parciales: este candidato no estaba en el top 30 de la API. Su total se construyó sumando puestos donde apareció.">parcial</span>' : ''}
            </span>
            <span class="candidate-row__party">${escapeHtml(c.party)}${c.list ? ' · Lista ' + escapeHtml(String(c.list)) : ''}</span>
          </div>
        </div>
        <div class="candidate-row__bar">
          <div class="candidate-row__fill" style="width:${ChartHelpers.pctOfMax(c.votes, maxV)}%; background:${ChartHelpers.color(i)}"></div>
        </div>
        <div class="candidate-row__nums">
          <span class="candidate-row__votes">${fmt(c.votes)}${isPartial ? '+' : ''}</span>
          <span class="candidate-row__pct">${fmtPct(c.pct)}</span>
        </div>
      </div>`;
  }).join('') || emptyState('No hay candidatos para mostrar.');
}

// ----------------------------------------------------------------
// View 3 · Parties
// ----------------------------------------------------------------
function renderParties() {
  const b = state.benchmark;
  if (!b) return;

  const list = b.parties;
  const maxV = Math.max(...list.map(p => p.votes), 1);

  $('#party-grid').innerHTML = list.map((p, i) => {
    const color = ChartHelpers.color(i);
    return `
      <div class="party-card">
        <div class="party-card__head">
          <h3 class="party-card__name">${escapeHtml(p.name)}</h3>
          <span class="party-card__rank">#${i + 1}</span>
        </div>
        <div class="party-card__bar">
          <div class="party-card__fill" style="width:${ChartHelpers.pctOfMax(p.votes, maxV)}%; background:${color}"></div>
        </div>
        <div class="party-card__stats">
          <span class="party-card__votes">${fmt(p.votes)}</span>
          <span class="party-card__pct">${fmtPct(p.pct)}</span>
        </div>
      </div>
    `;
  }).join('') || emptyState('No hay partidos para mostrar.');
}

// ----------------------------------------------------------------
// View 4 · Stations grid
// ----------------------------------------------------------------
function renderStations() {
  const m = state.mapData;
  if (!m) return;

  const search = state.stationSearch.toLowerCase().trim();
  let stations = m.stations;
  if (search) {
    stations = stations.filter(s =>
      s.name.toLowerCase().includes(search) ||
      (s.zone && s.zone.toLowerCase().includes(search))
    );
  }

  $('#station-grid').innerHTML = stations.map(s => {
    const w = s.topCandidate;
    return `
      <button class="station-card" data-station="${escapeHtml(s.code)}" type="button">
        <div class="station-card__head">
          <h3 class="station-card__name">${escapeHtml(s.name)}</h3>
          ${s.zone ? `<span class="station-card__zone">${escapeHtml(s.zone)}</span>` : ''}
        </div>
        <div class="station-card__mini">
          <div class="station-mini-bar">
            <span class="station-mini-bar__name">${escapeHtml(w.name)}</span>
            <span class="station-mini-bar__pct">${fmtPct(w.pct)}</span>
            <div class="station-mini-bar__bar">
              <div class="station-mini-bar__fill" style="width:${Math.min(100, w.pct)}%; background:${ChartHelpers.color(0)}"></div>
            </div>
          </div>
          <div class="station-card__party">${escapeHtml(w.party)}</div>
        </div>
        <div class="station-card__foot">
          <span class="station-card__total-label">${fmt(s.mesaCount)} mesas</span>
          <span class="station-card__total">${fmt(s.totalVotes)}</span>
        </div>
      </button>
    `;
  }).join('') || emptyState('No hay puestos que coincidan con la búsqueda.');

  // Wire click events
  $$('.station-card').forEach(btn => {
    btn.addEventListener('click', () => openStationDetail(btn.dataset.station));
  });
}

// ----------------------------------------------------------------
// View 5 · Map (Leaflet heatmap)
// ----------------------------------------------------------------
// Default view = Rionegro municipal seat. Used as fallback if no station has coords.
const MAP_DEFAULT_CENTER = [6.155, -75.374];
const MAP_DEFAULT_ZOOM   = 13;

// Single-color gradient used when filtering by a specific candidate
// (intensity = relative votes for that candidate at each station).
const HEAT_GRADIENT_INTENSITY = {
  0.0: '#1e3a8a',
  0.3: '#0891b2',
  0.55: '#65a30d',
  0.75: '#f59e0b',
  1.0: '#dc2626',
};

function getMappableStations() {
  const list = state.mapData?.stations || [];
  return list.filter(s => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)));
}

/**
 * Build a stable color palette: top candidates from the global ranking get
 * curated colors; everyone else is gray. Returns Map<candidateName, hexColor>.
 */
function buildCandidatePalette() {
  const palette = new Map();
  const top = (state.benchmark?.candidates || []).slice(0, 8);
  top.forEach((c, i) => palette.set(c.name, ChartHelpers.color(i)));
  return palette;
}

const PALETTE_OTHER = '#a3a3a3';

/**
 * Lazy-load /station detail for every mappable puesto, in parallel chunks.
 * Builds `mapEnrich.byCandidate` so the candidate filter can render heatmaps
 * weighted by per-candidate votes. Idempotent for the current election+cargo.
 */
async function ensureMapEnriched() {
  const key = `${state.electionId}|${state.corporationCode}`;

  // Reset if election/cargo changed
  if (mapEnrich.forKey && mapEnrich.forKey !== key) {
    mapEnrich.forKey = null;
    mapEnrich.loading = false;
    mapEnrich.done = false;
    mapEnrich.byCandidate = new Map();
  }
  if (mapEnrich.done || mapEnrich.loading) return;

  const stations = getMappableStations();
  if (stations.length === 0) return;

  mapEnrich.forKey = key;
  mapEnrich.loading = true;
  mapEnrich.byCandidate = new Map();

  showMapProgress(0, stations.length);

  const CHUNK = 6;
  let done = 0;
  for (let i = 0; i < stations.length; i += CHUNK) {
    // Bail if user changed election/cargo while we were fetching.
    if (mapEnrich.forKey !== `${state.electionId}|${state.corporationCode}`) {
      mapEnrich.loading = false;
      hideMapProgress();
      return;
    }
    const chunk = stations.slice(i, i + CHUNK);
    const results = await Promise.all(chunk.map(s =>
      ElectoralAPI.getStation(state.electionId, state.corporationCode, s.code)
        .then(r => ({ station: s, detail: r }))
        .catch(() => ({ station: s, detail: null }))
    ));
    for (const { station, detail } of results) {
      if (!detail) continue;
      const root = detail.data || detail;
      const cands = toArray(root, 'top_candidates', 'candidates');
      for (const c of cands) {
        const name = pick(c, 'candidate_name', 'name');
        if (!name) continue;
        if (isInvalidVotePseudo({ name, party_code: pick(c, 'party_code') })) continue;
        const votes = Number(pick(c, 'votes', 'total_votes')) || 0;
        let perStation = mapEnrich.byCandidate.get(name);
        if (!perStation) {
          perStation = new Map();
          mapEnrich.byCandidate.set(name, perStation);
        }
        perStation.set(station.code, votes);
      }
    }
    done += chunk.length;
    showMapProgress(done, stations.length);
  }

  mapEnrich.loading = false;
  mapEnrich.done = true;
  hideMapProgress();

  // If the user is on the map view, repaint to reflect the new filter options
  // and the (possibly) candidate-specific heatmap they already selected.
  if (state.view === 'map') renderMap();
}

function showMapProgress(done, total) {
  const box = $('#map-progress');
  if (!box) return;
  box.hidden = false;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('#map-progress-fill').style.width = `${pct}%`;
  $('#map-progress-text').textContent = `Cargando detalle por puesto · ${done} / ${total}`;
}

function hideMapProgress() {
  const box = $('#map-progress');
  if (box) box.hidden = true;
}

function populateMapCandidateFilter() {
  const sel = $('#map-candidate-filter');
  if (!sel) return;

  const candidates = (state.benchmark?.candidates || []).slice(0, 30);
  const current = state.mapCandidate;

  sel.innerHTML = '<option value="">Ganador por puesto</option>' +
    candidates.map(c => {
      const label = `${c.name}${c.party && c.party !== '—' ? ' · ' + c.party : ''}`;
      return `<option value="${escapeHtml(c.name)}">${escapeHtml(label)}</option>`;
    }).join('');

  // Restore selection if still valid
  if (current && candidates.some(c => c.name === current)) {
    sel.value = current;
  } else {
    sel.value = '';
    state.mapCandidate = '';
  }
}

function renderMap() {
  // Leaflet may not be loaded yet (deferred CDN). Retry shortly.
  if (typeof L === 'undefined' || typeof L.heatLayer !== 'function') {
    setTimeout(renderMap, 80);
    return;
  }

  const container = $('#leaflet-map');
  if (!container) return;

  // Init once
  if (!mapState.map) {
    mapState.map = L.map(container, {
      center: MAP_DEFAULT_CENTER,
      zoom: MAP_DEFAULT_ZOOM,
      scrollWheelZoom: true,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapState.map);
    mapState.markersLayer = L.layerGroup().addTo(mapState.map);

    // Delegated click for "Ver detalle" buttons inside Leaflet popups
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-open-station]');
      if (!btn) return;
      mapState.map.closePopup();
      openStationDetail(btn.dataset.openStation);
    });
  } else {
    setTimeout(() => mapState.map.invalidateSize(), 50);
  }

  populateMapCandidateFilter();
  // Mode toggle is irrelevant when filtering by a specific candidate.
  const modeSeg = $('#map-mode-seg');
  if (modeSeg) modeSeg.style.display = state.mapCandidate ? 'none' : '';

  // Kick off enrichment in the background on first map render (or on
  // first candidate-filter selection — see the change handler).
  if (!mapEnrich.done && !mapEnrich.loading) {
    ensureMapEnriched();
  }

  const stations = getMappableStations();
  const palette = buildCandidatePalette();
  const hint = $('#map-legend-hint');

  // Wipe previous heat + markers
  if (mapState.heatLayer) {
    mapState.map.removeLayer(mapState.heatLayer);
    mapState.heatLayer = null;
  }
  mapState.markersLayer.clearLayers();

  if (stations.length === 0) {
    hint.textContent = 'Esta elección no incluye coordenadas geográficas para los puestos.';
    updateLegend({ kind: 'empty' });
    return;
  }

  // Decide what we're plotting:
  //   - candidate selected → heatmap weighted by votes for that candidate,
  //                          markers tinted by intensity for that candidate
  //   - else               → heatmap by votos/% ganador (mode toggle),
  //                          markers colored by winner palette
  const candidateName = state.mapCandidate;
  let valueOf, headerLabel;

  if (candidateName) {
    const perStation = mapEnrich.byCandidate.get(candidateName);
    valueOf = (s) => (perStation?.get(s.code)) || 0;
    headerLabel = `Votos de ${candidateName}`;
  } else if (state.mapMode === 'winner') {
    valueOf = (s) => Number(s.topCandidate?.pct) || 0;
    headerLabel = 'Intensidad · % del ganador';
  } else {
    valueOf = (s) => Number(s.totalVotes) || 0;
    headerLabel = 'Intensidad · votos totales';
  }

  const values = stations.map(valueOf);
  const maxV = Math.max(...values, 1);

  // Build heat data: [lat, lng, intensity 0..1].
  // For the candidate-specific view, no floor — stations where the candidate
  // got 0 votes should be invisible in the heat layer.
  const heatPoints = stations.map(s => {
    const v = valueOf(s);
    const w = candidateName
      ? (v > 0 ? v / maxV : 0)
      : Math.max(0.05, v / maxV);
    return [Number(s.lat), Number(s.lng), w];
  }).filter(p => p[2] > 0);

  if (heatPoints.length > 0) {
    mapState.heatLayer = L.heatLayer(heatPoints, {
      radius: 28,
      blur: 22,
      minOpacity: 0.35,
      maxZoom: 17,
      gradient: HEAT_GRADIENT_INTENSITY,
    }).addTo(mapState.map);
  }

  // Markers — colored differently depending on view
  for (const s of stations) {
    let fillColor;
    let radius = 6;
    let strokeColor = '#0a0a0a';

    if (candidateName) {
      // Single-candidate view: tint by intensity
      const v = valueOf(s);
      if (v <= 0) {
        fillColor = '#e5e5e3';
        strokeColor = '#a3a3a3';
        radius = 4;
      } else {
        fillColor = colorForRamp(v / maxV);
        radius = 5 + Math.round((v / maxV) * 5);  // 5..10
      }
    } else {
      // Winner-per-puesto view: color by the candidate who won there
      const winnerName = s.topCandidate?.name;
      fillColor = palette.get(winnerName) || PALETTE_OTHER;
      radius = Math.max(5, Math.min(11, 4 + Math.round(Math.sqrt(s.totalVotes) / 18)));
    }

    const m = L.circleMarker([Number(s.lat), Number(s.lng)], {
      radius,
      color: strokeColor,
      weight: 1,
      fillColor,
      fillOpacity: 0.92,
    });

    const w = s.topCandidate || {};
    const candidateRow = candidateName
      ? `<div class="map-popup__winner" style="margin-top:4px">
           <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${valueOf(s) > 0 ? colorForRamp(valueOf(s) / maxV) : '#e5e5e3'};margin-right:6px;vertical-align:middle"></span>
           ${escapeHtml(candidateName)}: <strong>${fmt(valueOf(s))}</strong> votos
         </div>`
      : (w.name && w.name !== '—' ? `
        <div class="map-popup__winner">
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${palette.get(w.name) || PALETTE_OTHER};margin-right:6px;vertical-align:middle"></span>
          Ganador: <strong>${escapeHtml(w.name)}</strong> · ${fmtPct(w.pct)}
        </div>` : '');

    m.bindPopup(`
      <div class="map-popup">
        <div class="map-popup__name">${escapeHtml(s.name)}</div>
        ${s.zone ? `<div class="map-popup__zone">${escapeHtml(s.zone)}</div>` : ''}
        <div class="map-popup__stat">
          <strong>${fmt(s.totalVotes)}</strong> votos · ${fmt(s.mesaCount)} mesas
        </div>
        ${candidateRow}
        <button type="button" class="map-popup__btn" data-open-station="${escapeHtml(s.code)}">
          Ver detalle
        </button>
      </div>
    `);
    m.addTo(mapState.markersLayer);
  }

  // Fit bounds to puestos (with padding) — only on first render to avoid
  // jumping the user's view every time they toggle a filter.
  if (!mapState._fitted) {
    const bounds = L.latLngBounds(stations.map(s => [Number(s.lat), Number(s.lng)]));
    if (bounds.isValid()) {
      mapState.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
    mapState._fitted = true;
  }

  // Legend & hint
  if (candidateName) {
    const total = values.reduce((a, b) => a + b, 0);
    const stationsWith = values.filter(v => v > 0).length;
    updateLegend({
      kind: 'gradient',
      title: headerLabel,
      hint: `${fmt(total)} votos en ${fmt(stationsWith)} de ${fmt(stations.length)} puestos`,
      progress: !mapEnrich.done ? '· cargando datos…' : '',
    });
  } else {
    const top = (state.benchmark?.candidates || []).slice(0, 8);
    updateLegend({
      kind: 'swatches',
      title: 'Color · candidato ganador',
      hint: `${fmt(stations.length)} puesto${stations.length === 1 ? '' : 's'} con ubicación`,
      swatches: top.map((c, i) => ({ color: ChartHelpers.color(i), label: c.name })),
      otherLabel: state.benchmark?.candidates?.length > top.length ? 'Otros' : null,
    });
  }
}

/** Map a 0..1 ratio onto the same ramp as the heat gradient (used for marker fills). */
function colorForRamp(t) {
  const stops = Object.entries(HEAT_GRADIENT_INTENSITY)
    .map(([k, v]) => [Number(k), v])
    .sort((a, b) => a[0] - b[0]);
  t = Math.max(0, Math.min(1, t));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i], [b, cb] = stops[i + 1];
    if (t <= b) {
      const r = (t - a) / Math.max(1e-9, b - a);
      return mixHex(ca, cb, r);
    }
  }
  return stops[stops.length - 1][1];
}

function mixHex(a, b, t) {
  const pa = parseHex(a), pb = parseHex(b);
  const m = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${m(pa[0], pb[0])}, ${m(pa[1], pb[1])}, ${m(pa[2], pb[2])})`;
}
function parseHex(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function updateLegend(spec) {
  const title = $('#map-legend-title');
  const bar = $('#map-legend-bar');
  const scale = $('#map-legend-scale');
  const swatches = $('#map-legend-swatches');
  const hint = $('#map-legend-hint');

  if (!title) return;
  title.textContent = spec.title || '—';

  if (spec.kind === 'gradient') {
    bar.hidden = false;
    scale.hidden = false;
    swatches.hidden = true;
    hint.textContent = `${spec.hint || ''} ${spec.progress || ''}`.trim();
  } else if (spec.kind === 'swatches') {
    bar.hidden = true;
    scale.hidden = true;
    swatches.hidden = false;
    swatches.innerHTML = (spec.swatches || []).map(s => `
      <div class="map-legend__sw">
        <span class="map-legend__sw-dot" style="background:${s.color}"></span>
        <span class="map-legend__sw-name" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</span>
      </div>
    `).join('') + (spec.otherLabel ? `
      <div class="map-legend__sw">
        <span class="map-legend__sw-dot" style="background:${PALETTE_OTHER}"></span>
        <span class="map-legend__sw-name">${escapeHtml(spec.otherLabel)}</span>
      </div>` : '');
    hint.textContent = spec.hint || '';
  } else {
    bar.hidden = true;
    scale.hidden = true;
    swatches.hidden = true;
    hint.textContent = spec.hint || '';
  }
}

// ----------------------------------------------------------------
// Station detail modal
// ----------------------------------------------------------------
let currentStation = null;

async function openStationDetail(stationCode) {
  const station = state.mapData?.stations?.find(s => s.code === stationCode);
  if (!station) return;
  currentStation = station;

  const modal = $('#station-modal');
  modal.hidden = false;

  $('#station-modal-title').textContent = station.name;
  $('#station-modal-zone').textContent = station.zone || 'Sin zona';
  $('#station-modal-zone').hidden = !station.zone;
  $('#station-modal-address').textContent = station.address || '';
  $('#station-modal-address').hidden = !station.address;

  $('#station-modal-body').innerHTML = `
    <div class="loading"><div class="loading__bar"></div>
    <span class="loading__text">Cargando detalle del puesto...</span></div>`;

  try {
    const detail = await ElectoralAPI.getStation(
      state.electionId, state.corporationCode, station.code
    );
    renderStationDetail(detail, station);
  } catch (err) {
    // Fallback: render with map-level data
    if (err.code === 'AUTH') {
      ElectoralAPI.clearKey();
      closeStationModal();
      showSetup();
      return;
    }
    showToast(`No se cargó detalle adicional: ${err.message}`, 'error');
    renderStationDetailFallback(station);
  }
}

function renderStationDetail(detail, station) {
  const root = detail?.data || detail || {};

  // /station returns top_candidates with the same shape as /benchmark.
  const candidatesRaw = toArray(root, 'top_candidates', 'candidates', 'results');
  const candidatesAll = (candidatesRaw.length > 0
    ? candidatesRaw.map(c => ({
        code:      pick(c, 'candidate_code'),
        name:      pick(c, 'candidate_name', 'name', 'full_name') || '—',
        party:     pick(c, 'party_name', 'party') || '—',
        partyCode: pick(c, 'party_code'),
        votes:     Number(pick(c, 'votes', 'total_votes')) || 0,
        pct:       Number(pick(c, 'pct', 'percentage')) || null,
      }))
    : station.candidates);

  const candidates = candidatesAll
    .filter(c => !isInvalidVotePseudo(c))
    .sort((a, b) => b.votes - a.votes);

  const totalVotes = Number(pick(root, 'total_votes', 'valid_votes')) || station.totalVotes;

  // Per-mesa data: only winner + total per mesa (no candidate-level breakdown).
  const byMesaRaw = toArray(root, 'by_mesa', 'tables', 'mesas');
  const totalMesas = byMesaRaw.length || station.mesaCount;

  candidates.forEach(c => {
    if (c.pct == null) c.pct = totalVotes ? (c.votes / totalVotes) * 100 : 0;
  });

  const maxV = Math.max(...candidates.map(c => c.votes), 1);

  // Invalid-vote tally (blanco/nulos/no marcados) for this station.
  const invalid = candidatesAll.filter(c => isInvalidVotePseudo(c));
  const invalidTotal = invalid.reduce((s, c) => s + c.votes, 0);

  const invalidRow = invalidTotal > 0 ? `
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Blanco / Nulos</span>
        <span class="station-detail__metric-value">${fmt(invalidTotal)}</span>
      </div>` : '';

  // Mesas table.
  // - If mesas come with per-candidate breakdown (`candidates` array), render
  //   a pivot: Mesa × top5 + Otros + Blanco/Nulos + Total, with the per-row
  //   winner highlighted.
  // - Else fall back to the basic Mesa · Ganador · Total table.
  let mesasHtml = '';
  if (byMesaRaw.length > 0) {
    const hasMesaCandidates = Array.isArray(byMesaRaw[0]?.candidates);

    if (hasMesaCandidates) {
      const topN = candidates.slice(0, 5);

      const rows = byMesaRaw.map(m => {
        const num   = pick(m, 'mesa', 'number', 'table_number', 'id') ?? '—';
        const total = Number(pick(m, 'total_votes', 'valid_votes', 'votes')) || 0;
        const cands = toArray(m, 'candidates');

        // Lookup mesa-votes for a target candidate by code (preferred) or name.
        const lookup = (target) => {
          let found = null;
          if (target.code) {
            found = cands.find(c => pick(c, 'candidate_code') === target.code);
          }
          if (!found) {
            const tname = (target.name || '').toLowerCase();
            found = cands.find(c => (pick(c, 'candidate_name') || '').toLowerCase() === tname);
          }
          return Number(pick(found, 'votes', 'total_votes')) || 0;
        };

        // Build top-N votes for this mesa
        const topVotes = topN.map(t => lookup(t));
        const winnerIdx = topVotes.reduce((best, v, i) => v > topVotes[best] ? i : best, 0);

        // "Otros" = real candidates not in top N. "Blanco/Nulos" = pseudos.
        let otros = 0, invalid = 0;
        for (const c of cands) {
          const obj = {
            name: pick(c, 'candidate_name'),
            party_code: pick(c, 'party_code'),
          };
          const v = Number(pick(c, 'votes', 'total_votes')) || 0;
          if (isInvalidVotePseudo(obj)) {
            invalid += v;
          } else {
            const cd = pick(c, 'candidate_code');
            const isTop = topN.some(t => t.code && t.code === cd);
            if (!isTop) otros += v;
          }
        }

        const cells = topVotes.map((v, i) =>
          `<td class="${i === winnerIdx && v > 0 ? 'mesa-winner' : ''}">${fmt(v)}</td>`
        ).join('');

        return `<tr>
          <td class="mesa-row__num">Mesa ${escapeHtml(String(num))}</td>
          ${cells}
          <td class="mesa-row__sub">${otros > 0 ? fmt(otros) : '—'}</td>
          <td class="mesa-row__sub">${invalid > 0 ? fmt(invalid) : '—'}</td>
          <td class="mesa-row__total">${fmt(total)}</td>
        </tr>`;
      }).join('');

      mesasHtml = `
        <h4 class="station-detail__h3">Resultados por mesa · ${fmt(byMesaRaw.length)} mesas</h4>
        <p class="muted" style="margin:-6px 0 10px">La celda ganadora de cada mesa aparece destacada.</p>
        <div class="mesa-table-wrap">
          <table class="tables-table mesa-table">
            <thead>
              <tr>
                <th class="mesa-row__num">Mesa</th>
                ${topN.map(c => `<th title="${escapeHtml(c.name)} · ${escapeHtml(c.party)}">${escapeHtml(shortName(c.name))}</th>`).join('')}
                <th class="mesa-row__sub" title="Suma de candidatos fuera del top 5">Otros</th>
                <th class="mesa-row__sub" title="Votos en blanco, nulos y no marcados">Blanco/Nulos</th>
                <th class="mesa-row__total">Total</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    } else {
      // Fallback: only winner-per-mesa available
      mesasHtml = `
        <h4 class="station-detail__h3">Resultados por mesa · ${fmt(byMesaRaw.length)} mesas</h4>
        <table class="tables-table">
          <thead>
            <tr>
              <th>Mesa</th>
              <th>Ganador</th>
              <th>Total votos</th>
            </tr>
          </thead>
          <tbody>
            ${byMesaRaw.map(t => {
              const num   = pick(t, 'mesa', 'number', 'table_number', 'id') ?? '—';
              const total = Number(pick(t, 'total_votes', 'valid_votes', 'votes')) || 0;
              const top   = pick(t, 'top_candidate', 'winner', 'name') || '—';
              return `<tr>
                <td>Mesa ${escapeHtml(String(num))}</td>
                <td style="text-align:left">${escapeHtml(top)}</td>
                <td>${fmt(total)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }
  }

  $('#station-modal-body').innerHTML = `
    <div class="station-detail__metrics">
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Votos válidos</span>
        <span class="station-detail__metric-value">${fmt(totalVotes)}</span>
      </div>
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Mesas</span>
        <span class="station-detail__metric-value">${fmt(totalMesas)}</span>
      </div>
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Candidatos</span>
        <span class="station-detail__metric-value">${fmt(candidates.length)}</span>
      </div>
      ${invalidRow}
    </div>

    <h4 class="station-detail__h3">Resultados por candidato</h4>
    <div class="bar-list">
      ${candidates.map((c, i) => barRow({
        color: ChartHelpers.color(i),
        name: c.name,
        sub: c.party,
        value: c.votes,
        pct: c.pct,
        width: ChartHelpers.pctOfMax(c.votes, maxV),
      })).join('')}
    </div>

    ${mesasHtml}
  `;
}

function renderStationDetailFallback(station) {
  const candidates = station.candidates;
  const maxV = Math.max(...candidates.map(c => c.votes), 1);

  $('#station-modal-body').innerHTML = `
    <div class="station-detail__metrics">
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Votos válidos</span>
        <span class="station-detail__metric-value">${fmt(station.totalVotes)}</span>
      </div>
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Candidatos</span>
        <span class="station-detail__metric-value">${fmt(candidates.length)}</span>
      </div>
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Zona</span>
        <span class="station-detail__metric-value" style="font-size:14px">${escapeHtml(station.zone || '—')}</span>
      </div>
    </div>

    <h4 class="station-detail__h3">Resultados por candidato</h4>
    <div class="bar-list">
      ${candidates.map((c, i) => barRow({
        color: ChartHelpers.color(i),
        name: c.name,
        sub: c.party,
        value: c.votes,
        pct: c.pct,
        width: ChartHelpers.pctOfMax(c.votes, maxV),
      })).join('')}
    </div>
  `;
}

function closeStationModal() {
  $('#station-modal').hidden = true;
  currentStation = null;
}

// ----------------------------------------------------------------
// AI Modal (chat)
// ----------------------------------------------------------------
const aiState = {
  scope: null,        // { kind: 'global'|'station', ... }
  context: null,      // raw context from /context-ai
  messages: [],       // [{ role, content }]
  loading: false,
};

async function openAIGlobal() {
  aiState.scope = {
    kind: 'global',
    electionLabel: getCurrentElectionLabel(),
    corporationLabel: getCurrentCorporationLabel(),
  };
  aiState.messages = [];
  $('#ai-modal-title').textContent = 'Análisis estratégico · Rionegro';
  $('#ai-modal-sub').textContent = `${aiState.scope.electionLabel} · ${aiState.scope.corporationLabel}`;
  await openAIModal();
}

async function openAIStation() {
  if (!currentStation) return;
  aiState.scope = {
    kind: 'station',
    electionLabel: getCurrentElectionLabel(),
    corporationLabel: getCurrentCorporationLabel(),
    stationCode: currentStation.code,
    stationName: currentStation.name,
  };
  aiState.messages = [];
  $('#ai-modal-title').textContent = `Análisis del puesto · ${currentStation.name}`;
  $('#ai-modal-sub').textContent = `${aiState.scope.electionLabel} · ${aiState.scope.corporationLabel}`;
  await openAIModal();
}

async function openAIModal() {
  const modal = $('#ai-modal');
  modal.hidden = false;

  // Show config screen if no key, else go straight to analysis
  if (!AIProvider.hasKey()) {
    showAIConfig();
  } else {
    await runInitialAnalysis();
  }
}

function showAIConfig() {
  $('#ai-config').hidden = false;
  $('#ai-chat').hidden = true;
  $('#ai-context-details').hidden = true;
  $('#ai-key-input').value = '';
  $('#ai-key-input').focus();
}

async function runInitialAnalysis() {
  $('#ai-config').hidden = true;
  $('#ai-chat').hidden = false;
  $('#ai-context-details').hidden = false;
  renderMessages();

  // Fetch context from API
  try {
    pushMessage('assistant', '_Cargando contexto electoral..._', { loading: true });
    const ctx = await ElectoralAPI.getContextAI(state.electionId, state.corporationCode);
    aiState.context = ctx;
    $('#ai-context-pre').textContent = typeof ctx === 'string' ? ctx : JSON.stringify(ctx, null, 2);
    popLoading();
  } catch (err) {
    popLoading();
    pushMessage('error', `No se pudo cargar el contexto: ${err.message}`);
    return;
  }

  // Send initial prompt
  const prompt = AIProvider.buildInitialPrompt(aiState.scope, aiState.context);
  await sendUserMessage(prompt, { hidePromptInUI: true });
}

async function sendUserMessage(content, opts = {}) {
  // Store the user turn in messages. Hidden messages (e.g. the bulky
  // initial prompt with full context) are preserved for model history
  // but skipped during UI render.
  pushMessage('user', content, { hidden: !!opts.hidePromptInUI });
  pushMessage('assistant', '_Generando análisis..._', { loading: true });

  // Build conversation history for the model from non-transient,
  // non-error messages (hidden messages are still sent to the model).
  const history = aiState.messages
    .filter(m => !m.transient && m.role !== 'error')
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }));

  try {
    const reply = await AIProvider.complete(history);
    popLoading();
    pushMessage('assistant', reply);
  } catch (err) {
    popLoading();
    pushMessage('error', err.message || 'Error generando respuesta.');
  }
}

function pushMessage(role, content, opts = {}) {
  aiState.messages.push({
    role,
    content,
    transient: !!opts.loading,
    hidden: !!opts.hidden,
  });
  renderMessages();
}

function popLoading() {
  // Remove last transient message (loading placeholder)
  for (let i = aiState.messages.length - 1; i >= 0; i--) {
    if (aiState.messages[i].transient) {
      aiState.messages.splice(i, 1);
      break;
    }
  }
  renderMessages();
}

function renderMessages() {
  const host = $('#ai-messages');
  host.innerHTML = aiState.messages
    .filter(m => !m.hidden)
    .map(m => {
      const cls = m.role === 'user' ? 'ai-msg--user'
                : m.role === 'error' ? 'ai-msg--error'
                : 'ai-msg--assistant';
      const label = m.role === 'user' ? 'Tú'
                  : m.role === 'error' ? 'Error'
                  : 'IA';
      return `
        <div class="ai-msg ${cls}">
          <div class="ai-msg__role">${label}</div>
          <div class="ai-msg__content">${formatMarkdown(m.content)}</div>
        </div>`;
    }).join('');
  host.scrollTop = host.scrollHeight;
}

/** Minimal markdown to safe HTML: bold, italics, headings, bullets, line breaks. */
function formatMarkdown(text) {
  let html = escapeHtml(text);
  // Headings (#, ##, ###)
  html = html.replace(/^### (.+)$/gm, '<h4 style="margin:10px 0 4px;font-size:13px">$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3 style="margin:12px 0 4px;font-size:14px">$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2 style="margin:14px 0 6px;font-size:15px">$1</h2>');
  // Bold + italics
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');
  // Bullets
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(\n|$))+/g, m => `<ul style="margin:6px 0;padding-left:18px">${m.replace(/\n/g,'')}</ul>`);
  // Code
  html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-family:var(--font-mono);font-size:0.9em">$1</code>');
  return html;
}

function getCurrentElectionLabel() {
  const e = state.elections.find(x => x.id === state.electionId);
  if (!e) return '';
  return `${e.name}${e.year ? ' ' + e.year : ''}`;
}

function getCurrentCorporationLabel() {
  const c = state.corporations.find(x => x.code === state.corporationCode);
  return c?.name || '';
}

function closeAIModal() {
  $('#ai-modal').hidden = true;
}

// ----------------------------------------------------------------
// Settings modal
// ----------------------------------------------------------------
function openSettings() {
  $('#settings-modal').hidden = false;
  refreshSettingsStatus();
}

function closeSettings() {
  $('#settings-modal').hidden = true;
}

function refreshSettingsStatus() {
  const provider = AIProvider.getProvider();
  const has = AIProvider.hasKey();
  $('#ai-status-text').textContent = has
    ? `Configurada · proveedor: ${provider}`
    : 'No configurada.';
}

// ----------------------------------------------------------------
// Helpers: HTML safety, names
// ----------------------------------------------------------------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Compact name for tight table headers: prefer the last two surnames. */
function shortName(name) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 2) return titleCase(name);
  return titleCase(parts.slice(-2).join(' '));
}

function emptyState(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

// ----------------------------------------------------------------
// Event wiring
// ----------------------------------------------------------------
function wireEvents() {
  // Setup
  $('#setup-form').addEventListener('submit', handleSetupSubmit);

  // Filters
  $('#election-select').addEventListener('change', async (e) => {
    state.electionId = e.target.value;
    await loadCorporations();
  });
  $('#corporation-select').addEventListener('change', async (e) => {
    state.corporationCode = e.target.value;
    await loadElectionData();
  });

  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const v = tab.dataset.view;
      state.view = v;
      $$('.tab').forEach(t => {
        const active = t.dataset.view === v;
        t.classList.toggle('tab--active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      renderAll();
    });
  });

  // Filter widgets
  $('#party-filter').addEventListener('change', (e) => {
    state.partyFilter = e.target.value;
    renderCandidates();
  });
  $('#station-search').addEventListener('input', (e) => {
    state.stationSearch = e.target.value;
    renderStations();
  });

  // Map mode toggle (votos / % ganador)
  $$('[data-map-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mapMode;
      if (mode === state.mapMode) return;
      state.mapMode = mode;
      $$('[data-map-mode]').forEach(b => {
        b.classList.toggle('seg__btn--active', b.dataset.mapMode === mode);
      });
      renderMap();
    });
  });

  // Candidate filter (map view) — selecting a candidate switches the heatmap
  // to per-candidate votes, lazy-loading station details if not yet cached.
  $('#map-candidate-filter').addEventListener('change', async (e) => {
    state.mapCandidate = e.target.value || '';
    renderMap();
    if (state.mapCandidate && !mapEnrich.done && !mapEnrich.loading) {
      await ensureMapEnriched();   // renderMap will re-run when this finishes
    }
  });

  // AI buttons
  $('#ai-global-btn').addEventListener('click', openAIGlobal);
  $('#station-ai-btn').addEventListener('click', () => {
    closeStationModal();
    openAIStation();
  });

  // AI config
  $('#ai-config-save').addEventListener('click', () => {
    const provider = document.querySelector('input[name="ai-provider"]:checked').value;
    const key = $('#ai-key-input').value.trim();
    if (!key) {
      showToast('Ingresa una API key.', 'error');
      return;
    }
    AIProvider.setProvider(provider);
    AIProvider.setKey(provider, key);
    runInitialAnalysis();
  });
  $('#ai-config-skip').addEventListener('click', async () => {
    $('#ai-config').hidden = true;
    $('#ai-chat').hidden = false;
    $('#ai-context-details').hidden = false;
    try {
      const ctx = await ElectoralAPI.getContextAI(state.electionId, state.corporationCode);
      aiState.context = ctx;
      $('#ai-context-pre').textContent = typeof ctx === 'string' ? ctx : JSON.stringify(ctx, null, 2);
      pushMessage('assistant', 'Contexto cargado. Configura un proveedor de IA para generar análisis automáticos, o copia el contexto desde el bloque inferior.');
    } catch (err) {
      pushMessage('error', `No se pudo cargar el contexto: ${err.message}`);
    }
  });

  // AI send
  $('#ai-send-btn').addEventListener('click', () => {
    const ta = $('#ai-prompt');
    const v = ta.value.trim();
    if (!v) return;
    if (!AIProvider.hasKey()) {
      showToast('Configura una API key de IA primero.', 'error');
      showAIConfig();
      return;
    }
    ta.value = '';
    sendUserMessage(v);
  });
  $('#ai-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $('#ai-send-btn').click();
    }
  });

  // Settings
  $('#settings-btn').addEventListener('click', openSettings);
  $('#logout-btn').addEventListener('click', () => {
    ElectoralAPI.clearKey();
    closeSettings();
    showSetup();
  });
  $('#ai-clear-btn').addEventListener('click', () => {
    AIProvider.clearKeys();
    refreshSettingsStatus();
    showToast('Configuración de IA borrada.', 'success');
  });

  // Modal close
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      const modal = closer.closest('.modal');
      if (modal) modal.hidden = true;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.modal').forEach(m => m.hidden = true);
    }
  });
}

// ----------------------------------------------------------------
// Boot
// ----------------------------------------------------------------
function init() {
  wireEvents();
  if (ElectoralAPI.hasKey()) {
    showApp();
    bootstrap();
  } else {
    showSetup();
  }
}

document.addEventListener('DOMContentLoaded', init);
