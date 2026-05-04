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
  loading: false,
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
  const key = input.value.trim();
  if (!key) return;

  const btn = $('#connect-btn');
  const errBox = $('#setup-error');
  errBox.hidden = true;

  btn.disabled = true;
  $('.btn__label', btn).hidden = true;
  $('.btn__spinner', btn).hidden = false;

  ElectoralAPI.setKey(key);

  try {
    await ElectoralAPI.validateKey();
    showApp();
    bootstrap();
  } catch (err) {
    ElectoralAPI.clearKey();
    errBox.textContent = err.message || 'No se pudo validar la API key.';
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

    // Default: prefer Alcaldía (001), else first
    const def =
      state.corporations.find(c => String(c.code) === '001') ||
      state.corporations.find(c => /alcald/i.test(c.name)) ||
      state.corporations[0];
    state.corporationCode = def.code;
    $('#corporation-select').value = def.code;

    await loadElectionData();
  } catch (err) {
    showError(err.message);
  }
}

function normalizeCorporations(payload) {
  const arr = toArray(payload, 'corporations');
  return arr.map(c => ({
    code: String(pick(c, 'code', 'corporation_code', 'id') ?? ''),
    name: pick(c, 'name', 'title', 'label') || 'Cargo',
  })).filter(c => c.code);
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

    $('#ai-global-btn').disabled = false;
    renderAll();
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

function normalizeBenchmark(payload) {
  if (!payload) return null;
  const root = payload.data || payload;

  const candidatesRaw = toArray(root, 'top_candidates', 'candidates');
  const partiesRaw = toArray(root, 'top_parties', 'parties');

  const candidates = candidatesRaw.map(c => ({
    name: pick(c, 'name', 'candidate_name', 'full_name') || '—',
    party: pick(c, 'party', 'party_name', 'political_party') || '—',
    list: pick(c, 'list_number', 'list', 'ballot_number'),
    votes: Number(pick(c, 'votes', 'total_votes', 'vote_count')) || 0,
    pct: Number(pick(c, 'percentage', 'pct', 'vote_pct')) || null,
  }));

  const parties = partiesRaw.map(p => ({
    name: pick(p, 'name', 'party_name') || '—',
    votes: Number(pick(p, 'votes', 'total_votes')) || 0,
    pct: Number(pick(p, 'percentage', 'pct', 'vote_pct')) || null,
  }));

  // Totals: prefer explicit, else derive
  const totals = pick(root, 'totals', 'summary') || {};
  const totalVotes = Number(
    pick(totals, 'valid_votes', 'total_valid_votes', 'total_votes') ??
    pick(root, 'total_votes', 'valid_votes')
  ) || candidates.reduce((s, c) => s + c.votes, 0);

  const totalCandidates = Number(pick(totals, 'candidates_count')) || candidates.length;
  const totalParties = Number(pick(totals, 'parties_count')) || parties.length;
  const totalStations = Number(
    pick(totals, 'stations_count', 'polling_stations_count')
  ) || null;

  // Compute pct if missing
  candidates.forEach(c => {
    if (c.pct == null) c.pct = totalVotes ? (c.votes / totalVotes) * 100 : 0;
  });
  parties.forEach(p => {
    if (p.pct == null) p.pct = totalVotes ? (p.votes / totalVotes) * 100 : 0;
  });

  return { candidates, parties, totalVotes, totalCandidates, totalParties, totalStations };
}

function normalizeMap(payload) {
  if (!payload) return null;
  const root = payload.data || payload;
  const stationsRaw = toArray(root, 'polling_stations', 'stations', 'puestos');

  const stations = stationsRaw.map(s => {
    const candsRaw = toArray(s, 'top_candidates', 'candidates', 'results');
    const candidates = candsRaw.map(c => ({
      name: pick(c, 'name', 'candidate_name', 'full_name') || '—',
      party: pick(c, 'party', 'party_name') || '—',
      votes: Number(pick(c, 'votes', 'total_votes')) || 0,
      pct: Number(pick(c, 'percentage', 'pct')) || null,
    }));

    const totalVotes = Number(
      pick(s, 'total_votes', 'valid_votes', 'votes')
    ) || candidates.reduce((sum, c) => sum + c.votes, 0);

    candidates.forEach(c => {
      if (c.pct == null) c.pct = totalVotes ? (c.votes / totalVotes) * 100 : 0;
    });

    return {
      code: String(pick(s, 'code', 'station_code', 'polling_station_code', 'id') ?? ''),
      name: pick(s, 'name', 'station_name', 'polling_station_name') || 'Puesto',
      zone: pick(s, 'zone', 'comuna', 'district', 'sector') || '',
      address: pick(s, 'address', 'location') || '',
      totalVotes,
      candidates: candidates.sort((a, b) => b.votes - a.votes),
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

  const maxV = Math.max(...list.map(c => c.votes), 1);

  $('#candidate-list').innerHTML = list.map((c, i) => `
    <div class="candidate-row">
      <span class="candidate-row__rank">${i + 1}</span>
      <div class="candidate-row__name">
        <span class="candidate-row__color" style="background:${ChartHelpers.color(i)}"></span>
        <div class="candidate-row__text">
          <span class="candidate-row__person">${escapeHtml(c.name)}</span>
          <span class="candidate-row__party">${escapeHtml(c.party)}${c.list ? ' · Lista ' + escapeHtml(String(c.list)) : ''}</span>
        </div>
      </div>
      <div class="candidate-row__bar">
        <div class="candidate-row__fill" style="width:${ChartHelpers.pctOfMax(c.votes, maxV)}%; background:${ChartHelpers.color(i)}"></div>
      </div>
      <div class="candidate-row__nums">
        <span class="candidate-row__votes">${fmt(c.votes)}</span>
        <span class="candidate-row__pct">${fmtPct(c.pct)}</span>
      </div>
    </div>
  `).join('') || emptyState('No hay candidatos para mostrar.');
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
    const top3 = s.candidates.slice(0, 3);
    return `
      <button class="station-card" data-station="${escapeHtml(s.code)}" type="button">
        <div class="station-card__head">
          <h3 class="station-card__name">${escapeHtml(s.name)}</h3>
          ${s.zone ? `<span class="station-card__zone">${escapeHtml(s.zone)}</span>` : ''}
        </div>
        <div class="station-card__mini">
          <div class="station-card__bars">
            ${top3.map((c, i) => `
              <div class="station-mini-bar">
                <span class="station-mini-bar__name">${escapeHtml(c.name)}</span>
                <span class="station-mini-bar__pct">${fmtPct(c.pct)}</span>
                <div class="station-mini-bar__bar">
                  <div class="station-mini-bar__fill" style="width:${Math.min(100, c.pct)}%; background:${ChartHelpers.color(i)}"></div>
                </div>
              </div>`).join('')}
          </div>
        </div>
        <div class="station-card__foot">
          <span class="station-card__total-label">Total votos</span>
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
  const candidatesRaw = toArray(root, 'candidates', 'results') ;
  const candidates = (candidatesRaw.length > 0 ? candidatesRaw : station.candidates).map(c => ({
    name: pick(c, 'name', 'candidate_name', 'full_name') || c.name || '—',
    party: pick(c, 'party', 'party_name') || c.party || '—',
    votes: Number(pick(c, 'votes', 'total_votes')) || c.votes || 0,
    pct: Number(pick(c, 'percentage', 'pct')) || c.pct || null,
  })).sort((a, b) => b.votes - a.votes);

  const totalVotes = Number(pick(root, 'total_votes', 'valid_votes')) || station.totalVotes;
  const tablesRaw = toArray(root, 'tables', 'mesas');
  const totalTables = Number(pick(root, 'tables_count', 'total_tables')) || tablesRaw.length;

  candidates.forEach(c => {
    if (c.pct == null) c.pct = totalVotes ? (c.votes / totalVotes) * 100 : 0;
  });

  const maxV = Math.max(...candidates.map(c => c.votes), 1);

  // Tables table — only if API returned per-table breakdown
  let tablesHtml = '';
  if (tablesRaw.length > 0) {
    // Collect candidate names from tables (top 3 by total votes)
    const top3 = candidates.slice(0, 3);
    tablesHtml = `
      <h4 class="station-detail__h3">Mesas</h4>
      <table class="tables-table">
        <thead>
          <tr>
            <th>Mesa</th>
            ${top3.map(c => `<th>${escapeHtml(shortName(c.name))}</th>`).join('')}
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${tablesRaw.map(t => {
            const tNum = pick(t, 'number', 'table_number', 'mesa', 'id') ?? '—';
            const tTotal = Number(pick(t, 'total_votes', 'valid_votes', 'votes')) || 0;
            const tCands = toArray(t, 'candidates', 'results');
            const cells = top3.map(target => {
              const found = tCands.find(c =>
                (pick(c, 'name', 'candidate_name') || '').toLowerCase() ===
                target.name.toLowerCase()
              );
              const v = Number(pick(found, 'votes', 'total_votes')) || 0;
              return `<td>${fmt(v)}</td>`;
            }).join('');
            return `<tr><td>Mesa ${escapeHtml(String(tNum))}</td>${cells}<td>${fmt(tTotal)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  $('#station-modal-body').innerHTML = `
    <div class="station-detail__metrics">
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Votos válidos</span>
        <span class="station-detail__metric-value">${fmt(totalVotes)}</span>
      </div>
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Mesas</span>
        <span class="station-detail__metric-value">${fmt(totalTables)}</span>
      </div>
      <div class="station-detail__metric">
        <span class="station-detail__metric-label">Candidatos</span>
        <span class="station-detail__metric-value">${fmt(candidates.length)}</span>
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

    ${tablesHtml}
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

function shortName(name) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 2) return name;
  // Take first name + last surname
  return `${parts[0]} ${parts[parts.length - 1]}`;
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
