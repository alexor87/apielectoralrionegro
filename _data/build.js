#!/usr/bin/env node
/**
 * Procesa los CSV oficiales de la Registraduría (MMV TERRITORIALES) y genera
 * los JSON estáticos que consume el portal — uno por (elección, corporación)
 * con estructura idéntica a las respuestas de scrutix.co.
 *
 * Soporta múltiples años. Cada elección tiene su propio CSV en _data/.
 *
 * Uso:
 *   node _data/build.js
 *
 * Lee:   _data/MMV_2023_01_ANTIOQUIA.csv
 *        _data/MMV_2019_01_ANTIOQUIA.csv
 * Emite: data/elections.json
 *        data/corporations/{election_id}.json   (uno por elección)
 *        data/results/{election_id}_{CORP}.json (uno por corporación por elección)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data');

const MUNICIPALITY_CODE = '214'; // Rionegro
const MUNICIPALITY_NAME = 'RIONEGRO';

// ----------------------------------------------------------------
// Elecciones a procesar (orden = orden en el dropdown; el primero queda
// como default al cargar el portal).
// ----------------------------------------------------------------
const ELECTIONS = [
  { id: 'territoriales-2023', name: 'Elecciones Territoriales 2023', year: 2023, date: '2023-10-29',
    csv: 'MMV_2023_01_ANTIOQUIA.csv' },
  { id: 'territoriales-2019', name: 'Elecciones Territoriales 2019', year: 2019, date: '2019-10-27',
    csv: 'MMV_2019_01_ANTIOQUIA.csv' },
];

// ----------------------------------------------------------------
// Registro canónico de puestos.
// Cuando un puesto físico aparece en varios años con códigos/nombres
// distintos, lo unificamos aquí. El nombre y comuna canónicos siguen el
// formato 2023.
// ----------------------------------------------------------------
const CANONICAL_PUESTOS = [
  // === 4 matches confirmados (mismo lugar, código y/o nombre cambió entre años) ===
  { id: '01-01', name: 'I.E. JULIO SANIN', commune: 'COMUNA 1 LIBORIO MEJIA',
    aliases: [{ year: 2019, zone: '01', puesto: '02' }, { year: 2023, zone: '01', puesto: '01' }] },

  { id: '03-01', name: 'IE SAN ANTONIO', commune: 'COMUNA 2 SAN ANTONIO',
    aliases: [{ year: 2019, zone: '03', puesto: '01' }, { year: 2023, zone: '03', puesto: '01' }] },

  { id: '03-04', name: 'IE JOSEFINA MUÑOZ GONZALEZ SD CUATRO ESQ',
    commune: 'COMUNA 3 MONS. ALFONSO URIBE J',
    aliases: [{ year: 2019, zone: '03', puesto: '04' }, { year: 2023, zone: '03', puesto: '04' }] },

  { id: '02-02', name: 'IE JOSEFINA MUÑOZ GONZALEZ SD BALDOMERO',
    commune: 'COMUNA 1 LIBORIO MEJIA',
    aliases: [{ year: 2019, zone: '90', puesto: '01' }, { year: 2023, zone: '02', puesto: '02' }] },

  // === Puestos 2019-only DESPLAZADOS para evitar colisión de código ===
  // Su código raw (01-01 / 02-02) ahora pertenece a un puesto canónico de 2023.
  { id: '2019-01-01', name: 'I.E. JOSEFINA MUÑOZ GONZALEZ',
    commune: 'COMUNA 1 LIBORIO MEJIA',
    aliases: [{ year: 2019, zone: '01', puesto: '01' }] },

  { id: '2019-02-02', name: 'COL QUEBRADA ARRIBA',
    commune: 'COMUNA 2 SAN ANTONIO',
    aliases: [{ year: 2019, zone: '02', puesto: '02' }] },
];

// Lookup por (year, zone, puesto). Construido una vez al inicio.
const CANONICAL_INDEX = new Map();
for (const c of CANONICAL_PUESTOS) {
  for (const a of c.aliases) {
    CANONICAL_INDEX.set(`${a.year}|${a.zone}|${a.puesto}`, {
      id: c.id, name: c.name, commune: c.commune,
    });
  }
}

function lookupCanonical(year, zone, puesto) {
  return CANONICAL_INDEX.get(`${year}|${zone}|${puesto}`) || null;
}

// ----------------------------------------------------------------
// Normalización de nombre de comuna.
// El CSV 2019 trae prefijo numérico pegado al nombre y typos en la fuente
// (LIBONO en vez de LIBORIO, ALFONOS en vez de ALFONSO). Limpiamos.
// ----------------------------------------------------------------
function normalizeComuna(raw) {
  if (!raw || raw === 'NULL') return '';
  let s = String(raw).trim();
  s = s.replace(/^\d{2}/, '');             // strip prefijo 2019 "01..."
  s = s.replace(/LIBONO/gi, 'LIBORIO');    // typo Registraduría 2019
  s = s.replace(/ALFONOS/gi, 'ALFONSO');   // typo Registraduría 2019
  return s.trim();
}

// ----------------------------------------------------------------
// Constantes de candidato
// ----------------------------------------------------------------
// Composite candidate keys que representan votos no-candidato.
const INVALID_CANDIDATE_CODES = new Set([
  '00000_00996', // VOTOS EN BLANCO
  '00000_00997', // VOTOS NULOS
  '00000_00998', // VOTOS NO MARCADOS
]);

// ----------------------------------------------------------------
// CSV parsing (handles quoted fields with possible embedded commas)
// ----------------------------------------------------------------
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

// ----------------------------------------------------------------
// Aggregation helpers (operan sobre un Map por elección, no global)
// ----------------------------------------------------------------
function getCorp(corps, code, name) {
  if (!corps.has(code)) {
    corps.set(code, {
      code,
      name,
      total_votes: 0,
      candidates: new Map(),
      parties: new Map(),
      stations: new Map(),
    });
  }
  return corps.get(code);
}

function getStation(corp, key, meta) {
  if (!corp.stations.has(key)) {
    corp.stations.set(key, {
      ...meta,
      total_votes: 0,
      mesas: new Map(),
    });
  }
  return corp.stations.get(key);
}

function getMesa(station, num) {
  if (!station.mesas.has(num)) {
    station.mesas.set(num, {
      total_votes: 0,
      candidates: new Map(),
    });
  }
  return station.mesas.get(num);
}

// ----------------------------------------------------------------
// Procesa un CSV completo y devuelve un Map de corporaciones agregadas.
// ----------------------------------------------------------------
async function processCsv(election) {
  const csvPath = path.join(__dirname, election.csv);
  const corps = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  let processed = 0;
  let kept = 0;

  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    processed++;

    const f = parseCsvLine(line);
    // 0:depCode 1:depName 2:munCode 3:munName 4:zoneCode 5:puestoCode
    // 6:puestoName 7:mesa 8:comunaCode 9:comunaName 10:corpCode 11:corpName
    // 12:circumscription 13:partyCode 14:partyName 15:candCode 16:candName
    // 17:totalVotos
    if (f[2] !== MUNICIPALITY_CODE) continue;
    kept++;

    const corpCode = f[10];
    const corpName = f[11];
    const zoneCode = f[4];
    const puestoCode = f[5];
    const rawPuestoName = f[6];
    const mesa = f[7];
    const comunaCode = f[8];
    const rawComunaName = f[9];
    const partyCode = f[13];
    const partyName = f[14];
    const candCode = f[15];
    const candName = f[16];
    const votes = Number(f[17]) || 0;

    // Aplicar el override canónico cuando hay match. Si no, el código y
    // nombre crudos del CSV son el id del puesto.
    const canonical = lookupCanonical(election.year, zoneCode, puestoCode);
    const stationKey = canonical ? canonical.id : `${zoneCode}-${puestoCode}`;
    const stationName = canonical ? canonical.name : rawPuestoName;
    const stationCommune = canonical ? canonical.commune : normalizeComuna(rawComunaName);

    const corp = getCorp(corps, corpCode, corpName);
    const station = getStation(corp, stationKey, {
      code: stationKey,
      name: stationName,
      zone_code: zoneCode,
      puesto_code: puestoCode,
      commune_code: comunaCode,
      commune: stationCommune,
    });
    const mesaObj = getMesa(station, mesa);

    // Always count votes towards station / mesa total (incl. invalid).
    station.total_votes += votes;
    mesaObj.total_votes += votes;
    corp.total_votes += votes;

    // Per-candidate aggregation at all levels.
    // Composite key: in Concejo/Asamblea/JAL each party numbers its candidates
    // 1..N, so plain candCode collides across parties.
    const candKey = `${partyCode}_${candCode}`;
    if (!mesaObj.candidates.has(candKey)) {
      mesaObj.candidates.set(candKey, {
        candidate_code: candKey,
        candidate_name: candName,
        party_code: partyCode,
        votes: 0,
      });
    }
    mesaObj.candidates.get(candKey).votes += votes;

    if (!corp.candidates.has(candKey)) {
      corp.candidates.set(candKey, {
        candidate_code: candKey,
        candidate_name: candName,
        party_code: partyCode,
        party_name: partyName,
        votes: 0,
      });
    }
    corp.candidates.get(candKey).votes += votes;

    // Party totals — skip the "CANDIDATOS TOTALES" rollup row that holds invalid votes.
    if (!INVALID_CANDIDATE_CODES.has(candKey)) {
      if (!corp.parties.has(partyCode)) {
        corp.parties.set(partyCode, {
          party_code: partyCode,
          party_name: partyName,
          votes: 0,
        });
      }
      corp.parties.get(partyCode).votes += votes;
    }
  }

  console.log(`  ${election.id}: ${processed} filas procesadas, ${kept} de Rionegro.`);
  return corps;
}

// ----------------------------------------------------------------
// Emit JSON files
// ----------------------------------------------------------------
function isInvalid(candCode) {
  return INVALID_CANDIDATE_CODES.has(candCode);
}

function buildResultJson(election, corp) {
  // Real candidates (excluding blank/null/no marcado).
  const realCandidates = [...corp.candidates.values()]
    .filter(c => !isInvalid(c.candidate_code))
    .sort((a, b) => b.votes - a.votes);

  const totalValidVotes = realCandidates.reduce((s, c) => s + c.votes, 0);

  const candidatesOut = realCandidates.map(c => ({
    candidate_code: c.candidate_code,
    candidate_name: c.candidate_name,
    party_code: c.party_code,
    party_name: c.party_name,
    votes: c.votes,
    pct: totalValidVotes ? +(c.votes / totalValidVotes * 100).toFixed(4) : 0,
  }));

  const partiesOut = [...corp.parties.values()]
    .sort((a, b) => b.votes - a.votes)
    .map(p => ({
      party_code: p.party_code,
      party_name: p.party_name,
      votes: p.votes,
      pct: totalValidVotes ? +(p.votes / totalValidVotes * 100).toFixed(4) : 0,
    }));

  // Stations sorted by total votes desc.
  const stationsOut = [...corp.stations.values()].map(st => {
    const realCands = [...st.mesas.values()]
      .flatMap(m => [...m.candidates.values()])
      .filter(c => !isInvalid(c.candidate_code));

    const stationByCand = new Map();
    for (const c of realCands) {
      if (!stationByCand.has(c.candidate_code)) {
        stationByCand.set(c.candidate_code, { ...c, votes: 0 });
      }
      stationByCand.get(c.candidate_code).votes += c.votes;
    }

    let topCand = null;
    for (const c of stationByCand.values()) {
      if (!topCand || c.votes > topCand.votes) topCand = c;
    }

    let topPartyName = '';
    if (topCand) {
      const enriched = corp.candidates.get(topCand.candidate_code);
      topPartyName = enriched?.party_name || '';
    }

    return {
      polling_station_code: st.code,
      polling_station_name: st.name,
      commune: st.commune,
      commune_code: st.commune_code,
      zone_code: st.zone_code,
      total_votes: st.total_votes,
      mesa_count: st.mesas.size,
      top_candidate_name: topCand ? topCand.candidate_name : '',
      top_candidate_votes: topCand ? topCand.votes : 0,
      top_party_name: topPartyName,
      top_party_code: topCand ? topCand.party_code : '',
    };
  }).sort((a, b) => b.total_votes - a.total_votes);

  // Per-station detail with mesas + candidate breakdown.
  const stationsDetail = {};
  for (const st of corp.stations.values()) {
    const stationByCand = new Map();
    for (const m of st.mesas.values()) {
      for (const c of m.candidates.values()) {
        if (!stationByCand.has(c.candidate_code)) {
          const enriched = corp.candidates.get(c.candidate_code);
          stationByCand.set(c.candidate_code, {
            candidate_code: c.candidate_code,
            candidate_name: c.candidate_name,
            party_code: c.party_code,
            party_name: enriched?.party_name || '',
            votes: 0,
          });
        }
        stationByCand.get(c.candidate_code).votes += c.votes;
      }
    }

    const topCandidatesAll = [...stationByCand.values()].sort((a, b) => b.votes - a.votes);

    const stTotalValid = topCandidatesAll
      .filter(c => !isInvalid(c.candidate_code))
      .reduce((s, c) => s + c.votes, 0);

    const top_candidates = topCandidatesAll.map(c => ({
      ...c,
      pct: stTotalValid && !isInvalid(c.candidate_code)
        ? +(c.votes / stTotalValid * 100).toFixed(4) : 0,
    }));

    const by_mesa = [...st.mesas.entries()]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([num, m]) => ({
        mesa: num,
        total_votes: m.total_votes,
        candidates: [...m.candidates.values()].map(c => ({
          candidate_code: c.candidate_code,
          candidate_name: c.candidate_name,
          party_code: c.party_code,
          votes: c.votes,
        })),
      }));

    stationsDetail[st.code] = {
      polling_station_code: st.code,
      polling_station_name: st.name,
      commune: st.commune,
      commune_code: st.commune_code,
      zone_code: st.zone_code,
      total_votes: st.total_votes,
      top_candidates,
      by_mesa,
    };
  }

  return {
    election_id: election.id,
    corporation_code: corp.code,
    corporation_name: corp.name,
    municipality_code: MUNICIPALITY_CODE,
    municipality_name: MUNICIPALITY_NAME,
    benchmark: {
      total_votes: totalValidVotes,
      total_votes_with_invalid: corp.total_votes,
      candidates: candidatesOut,
      parties: partiesOut,
      polling_stations_count: corp.stations.size,
    },
    polling_stations: stationsOut,
    stations_detail: stationsDetail,
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj));
  const size = (fs.statSync(filePath).size / 1024).toFixed(1);
  console.log(`  wrote ${path.relative(ROOT, filePath)} (${size} KB)`);
}

async function main() {
  console.log('Procesando CSVs...');

  // Procesar cada elección y guardar su Map de corporaciones.
  const results = [];
  for (const election of ELECTIONS) {
    const corps = await processCsv(election);
    results.push({ election, corps });
  }

  console.log('\nResumen por elección:');
  for (const { election, corps } of results) {
    console.log(`  ${election.id}:`);
    for (const corp of corps.values()) {
      console.log(`    ${corp.code} ${corp.name}: ${corp.stations.size} puestos, ${corp.candidates.size} candidatos, ${corp.parties.size} partidos`);
    }
  }

  console.log('\nEscribiendo JSON...');

  // 1) elections.json — todas las elecciones en orden.
  writeJson(path.join(OUT_DIR, 'elections.json'), {
    elections: ELECTIONS.map(e => ({
      id: e.id, name: e.name, year: e.year, date: e.date,
    })),
  });

  // 2) Por cada elección: corporations + results
  for (const { election, corps } of results) {
    const corporations = [...corps.values()]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map(c => ({
        corporation_code: c.code,
        name: c.name,
        total_votes: c.total_votes,
      }));
    writeJson(
      path.join(OUT_DIR, 'corporations', `${election.id}.json`),
      { corporations }
    );

    for (const corp of corps.values()) {
      const result = buildResultJson(election, corp);
      writeJson(
        path.join(OUT_DIR, 'results', `${election.id}_${corp.code}.json`),
        result
      );
    }
  }

  console.log('\nListo.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
