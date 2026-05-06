#!/usr/bin/env node
/**
 * Procesa el CSV oficial de la Registraduría (MMV_TERRITORIALES2023_ANTIOQUIA)
 * y genera los JSON estáticos que consume el portal — uno por corporación
 * con estructura idéntica a las respuestas de scrutix.co.
 *
 * Uso:
 *   node _data/build.js
 *
 * Lee:   _data/MMV_2023_01_ANTIOQUIA.csv
 * Emite: data/elections.json
 *        data/corporations/territoriales-2023.json
 *        data/results/territoriales-2023_{CORP}.json   (uno por corporación)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const CSV_PATH = path.join(__dirname, 'MMV_2023_01_ANTIOQUIA.csv');
const OUT_DIR = path.join(ROOT, 'data');

const ELECTION = {
  id: 'territoriales-2023',
  name: 'Elecciones Territoriales 2023',
  year: 2023,
  date: '2023-10-29',
};

const MUNICIPALITY_CODE = '214'; // Rionegro
const MUNICIPALITY_NAME = 'RIONEGRO';

// Candidate codes that represent invalid/blank votes, not real candidates.
const INVALID_CANDIDATE_CODES = new Set(['00996', '00997', '00998']);

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
// Aggregation
// ----------------------------------------------------------------
// data[corpCode] = {
//   corp_name,
//   total_votes,
//   candidates: Map<candidate_code, {name, party_code, party_name, votes}>,
//   parties: Map<party_code, {name, votes}>,
//   stations: Map<station_key, {
//     code, name, zone_code, puesto_code, commune_code, commune,
//     total_votes,
//     mesas: Map<mesa_num, {
//       total_votes,
//       candidates: Map<candidate_code, {name, party_code, votes}>
//     }>
//   }>
// }
const data = new Map();

function getCorp(code, name) {
  if (!data.has(code)) {
    data.set(code, {
      code,
      name,
      total_votes: 0,
      candidates: new Map(),
      parties: new Map(),
      stations: new Map(),
    });
  }
  return data.get(code);
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
// Stream and process
// ----------------------------------------------------------------
async function processCsv() {
  const rl = readline.createInterface({
    input: fs.createReadStream(CSV_PATH),
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
    const puestoName = f[6];
    const mesa = f[7];
    const comunaCode = f[8];
    const comunaName = f[9];
    const partyCode = f[13];
    const partyName = f[14];
    const candCode = f[15];
    const candName = f[16];
    const votes = Number(f[17]) || 0;

    const corp = getCorp(corpCode, corpName);
    const stationKey = `${zoneCode}-${puestoCode}`;
    const station = getStation(corp, stationKey, {
      code: stationKey,
      name: puestoName,
      zone_code: zoneCode,
      puesto_code: puestoCode,
      commune_code: comunaCode,
      commune: comunaName,
    });
    const mesaObj = getMesa(station, mesa);

    // Always count votes towards station / mesa total (incl. invalid).
    station.total_votes += votes;
    mesaObj.total_votes += votes;
    corp.total_votes += votes;

    // Per-candidate aggregation at all levels.
    const candKey = candCode;
    if (!mesaObj.candidates.has(candKey)) {
      mesaObj.candidates.set(candKey, {
        candidate_code: candCode,
        candidate_name: candName,
        party_code: partyCode,
        votes: 0,
      });
    }
    mesaObj.candidates.get(candKey).votes += votes;

    if (!corp.candidates.has(candKey)) {
      corp.candidates.set(candKey, {
        candidate_code: candCode,
        candidate_name: candName,
        party_code: partyCode,
        party_name: partyName,
        votes: 0,
      });
    }
    corp.candidates.get(candKey).votes += votes;

    // Party totals — skip the "CANDIDATOS TOTALES" rollup row that holds invalid votes.
    if (!INVALID_CANDIDATE_CODES.has(candCode)) {
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

  console.log(`Procesadas ${processed} filas, ${kept} de Rionegro (${MUNICIPALITY_NAME}).`);
}

// ----------------------------------------------------------------
// Emit JSON files
// ----------------------------------------------------------------
function isInvalid(candCode) {
  return INVALID_CANDIDATE_CODES.has(candCode);
}

function buildResultJson(corp) {
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

    // Find party_name from the corporation candidate registry.
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
    // Top candidates for this station (by aggregated votes across its mesas).
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
    election_id: ELECTION.id,
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
  console.log('Procesando CSV...');
  await processCsv();

  console.log(`\nCorporaciones encontradas: ${data.size}`);
  for (const corp of data.values()) {
    console.log(`  ${corp.code} ${corp.name}: ${corp.stations.size} puestos, ${corp.candidates.size} candidatos, ${corp.parties.size} partidos`);
  }

  console.log('\nEscribiendo JSON...');

  // 1) elections.json
  writeJson(path.join(OUT_DIR, 'elections.json'), {
    elections: [{
      id: ELECTION.id,
      name: ELECTION.name,
      year: ELECTION.year,
      date: ELECTION.date,
    }],
  });

  // 2) corporations/{election_id}.json
  const corporations = [...data.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(c => ({
      corporation_code: c.code,
      name: c.name,
      total_votes: c.total_votes,
    }));
  writeJson(
    path.join(OUT_DIR, 'corporations', `${ELECTION.id}.json`),
    { corporations }
  );

  // 3) results/{election_id}_{corp_code}.json
  for (const corp of data.values()) {
    const result = buildResultJson(corp);
    writeJson(
      path.join(OUT_DIR, 'results', `${ELECTION.id}_${corp.code}.json`),
      result
    );
  }

  console.log('\nListo.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
