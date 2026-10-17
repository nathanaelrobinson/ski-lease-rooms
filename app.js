/*
 * Page logic for the ski lease room demo.
 * The solver logic is in model.js and the season logic is in simulate.js.
 */
(function () {
  'use strict';

  const M = window.SkiModel;
  const S = window.SkiSim;
  const O = window.SkiOutcomes;
  const STORAGE_KEY = 'ski-lease-config-v1';
  const HIGHS_BASE = 'https://cdn.jsdelivr.net/npm/highs@1.15.3/build/';
  const NIGHT_NAMES = ['Thursday', 'Friday', 'Saturday'];
  const TYPE_LABELS = {
    queen: 'Queen',
    twin: 'Twin',
    bunk_bottom: 'Bottom bunk',
    bunk_top: 'Top bunk',
    couch: 'Couch',
    air_queen: 'Air queen',
    air_twin: 'Air twin',
  };
  /* Labels and directions of the outcome measures. lower = true means that a lower number is better. */
  const MEASURES = [
    ['util', 'Bedroom utilization', '%', false],
    ['singleQueen', 'Single in queen', 'queen-nights', true],
    ['wastedQueen', 'Wasted queen', 'queen-nights', true],
    ['heldEmptyQueen', 'Held-empty queen', 'queen-nights', true],
    ['floorNights', 'Floor nights', 'person-nights', true],
    ['dominatedFloor', 'Dominated floor', 'person-nights', true],
    ['priorityInversion', 'Priority inversion', 'pairs', true],
    ['mixedRoom', 'Mixed-gender room', 'room-nights', true],
    ['coupleSplit', 'Couple split', 'couple-weekends', true],
    ['capExcess', 'Over couch cap', 'person-nights', true],
  ];
  const INCIDENT_LABELS = {
    wastedQueen: 'Wasted queen',
    heldEmptyQueen: 'Held-empty queen',
    dominatedFloor: 'Dominated floor',
    priorityInversion: 'Priority inversion',
    mixedRoom: 'Mixed-gender room',
    coupleSplit: 'Couple split',
    capExcess: 'Over couch cap',
  };
  /* Sequential blue ramp from the chart palette. Step 100 is value 0 and step 700 is value 10. */
  const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

  let highs = null;
  let config = loadConfig();
  let weekend = { mode: 'fresh', registrations: {}, runs: 0, midState: null };
  let season = null;
  const charts = {};

  /* Configuration */

  function clone(x) {
    return JSON.parse(JSON.stringify(x));
  }

  function defaultConfig() {
    return { rooms: clone(SkiDefaults.rooms), people: clone(SkiDefaults.people), settings: clone(SkiDefaults.settings) };
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (Array.isArray(c.rooms) && Array.isArray(c.people)) {
          c.settings = { ...SkiDefaults.settings, ...(c.settings || {}) };
          return c;
        }
      }
    } catch (e) {
      /* Storage can be blocked. Use the sample configuration. */
    }
    return defaultConfig();
  }

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      /* Storage can be blocked. The page still works without it. */
    }
  }

  /* Call this after each change to the configuration. */
  function configChanged() {
    saveConfig();
    season = null;
    weekend.midState = null;
    const ids = new Set(config.people.map((p) => p.id));
    for (const id of Object.keys(weekend.registrations)) if (!ids.has(id)) delete weekend.registrations[id];
    document.getElementById('season-result').innerHTML = '';
    document.getElementById('weekend-result').innerHTML = '';
    renderRegistrations();
  }

  /* Helpers */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmt(x, digits = 1) {
    if (x === null || x === undefined || Number.isNaN(x)) return '–';
    const v = Number(x).toFixed(digits);
    return Number(v) > 0 ? `+${v}` : v.replace('-', '−');
  }

  function plain(x, digits = 1) {
    if (x === null || x === undefined || Number.isNaN(x)) return '–';
    return Number(x).toFixed(digits).replace('-', '−');
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function personName(id) {
    const p = config.people.find((x) => x.id === id);
    return p ? p.name : id;
  }

  function bedInfo() {
    const beds = M.flattenBeds(config.rooms);
    const byId = new Map();
    for (const room of config.rooms) {
      const counts = {};
      for (const bed of room.beds) counts[bed.type] = (counts[bed.type] || 0) + 1;
      const seen = {};
      for (const bed of room.beds) {
        seen[bed.type] = (seen[bed.type] || 0) + 1;
        const n = counts[bed.type] > 1 ? ` ${seen[bed.type]}` : '';
        const full = beds.find((b) => b.id === bed.id);
        byId.set(bed.id, { ...full, label: `${TYPE_LABELS[bed.type]}${n}`, name: `${room.name}, ${TYPE_LABELS[bed.type].toLowerCase()}${n}` });
      }
    }
    return byId;
  }

  function nightsText(nights) {
    return nights.map((n) => M.NIGHTS[n]).join(', ');
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /* Solver loading */

  function loadSolver() {
    const statuses = ['weekend-status', 'season-status'].map((id) => document.getElementById(id));
    statuses.forEach((el) => (el.textContent = 'loading solver…'));
    window
      .Module({ locateFile: (file) => HIGHS_BASE + file })
      .then((h) => {
        highs = h;
        statuses.forEach((el) => (el.textContent = ''));
        document.getElementById('btn-assign').disabled = false;
        document.getElementById('btn-season').disabled = false;
        if (weekend.mode === 'mid') renderRegistrations();
        if (document.getElementById('panel-season').classList.contains('active')) runSeason();
      })
      .catch((err) => {
        statuses.forEach((el) => (el.textContent = `solver load failed: ${err.message || err}`));
      });
  }

  /* Tabs */

  function setupTabs() {
    for (const btn of document.querySelectorAll('nav.tabs button')) {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    }
  }

  function showTab(name) {
    for (const btn of document.querySelectorAll('nav.tabs button')) btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    for (const panel of document.querySelectorAll('section.panel')) panel.classList.toggle('active', panel.id === `panel-${name}`);
    if (name === 'season' && !season && highs) runSeason();
    try {
      localStorage.setItem('ski-lease-tab', name);
    } catch (e) {
      /* Storage can be blocked. */
    }
  }

  /* One weekend */

  function currentState() {
    if (weekend.mode === 'fresh') return { balances: {}, floorNights: {} };
    if (!weekend.midState && highs) weekend.midState = S.midSeasonState(highs, config);
    return weekend.midState || { balances: {}, floorNights: {} };
  }

  function weekendLabel() {
    const weekends = S.seasonWeekends();
    return weekend.mode === 'fresh' ? weekends[0].label : weekends[S.MID_SEASON_WEEKENDS].label;
  }

  function renderRegistrations() {
    const { balances, floorNights } = currentState();
    document.getElementById('weekend-sub').textContent =
      weekend.mode === 'fresh'
        ? `${weekendLabel()} · balances = 0`
        : `${weekendLabel()} · state after ${S.MID_SEASON_WEEKENDS} simulated weekends`;

    const ranked = config.people.map((p) => ({ id: p.id, bal: balances[p.id] || 0 })).sort((a, b) => a.bal - b.bal);
    const rank = new Map(ranked.map((r, i) => [r.id, i + 1]));
    const cap = S.capSetting(config.settings);

    let html = '<thead><tr><th>Person</th>';
    for (const n of M.NIGHTS) html += `<th class="c">${n}</th>`;
    html += `<th class="num">Balance</th><th class="num">Floor${cap === null ? '' : ` / ${cap}`}</th><th class="num">Rank</th></tr></thead><tbody>`;
    for (const p of config.people) {
      const reg = weekend.registrations[p.id] || [];
      const partner = p.partnerId ? config.people.find((x) => x.id === p.partnerId) : null;
      html += `<tr><td>${esc(p.name)}${partner ? `<span class="tag">+ ${esc(partner.name)}</span>` : ''}</td>`;
      for (let n = 0; n < 3; n++) {
        html += `<td class="c"><input type="checkbox" data-person="${esc(p.id)}" data-night="${n}" ${reg.includes(n) ? 'checked' : ''} aria-label="${esc(p.name)} ${NIGHT_NAMES[n]}"></td>`;
      }
      html += `<td class="num">${fmt(balances[p.id] || 0)}</td><td class="num">${floorNights[p.id] || 0}</td><td class="num muted">${weekend.mode === 'fresh' ? '–' : rank.get(p.id)}</td></tr>`;
    }
    html += '</tbody>';
    const table = document.getElementById('reg-table');
    table.innerHTML = html;
    for (const box of table.querySelectorAll('input[type="checkbox"]')) {
      box.addEventListener('change', () => {
        const id = box.dataset.person;
        const n = Number(box.dataset.night);
        const set = new Set(weekend.registrations[id] || []);
        if (box.checked) set.add(n);
        else set.delete(n);
        weekend.registrations[id] = [...set].sort();
        if (weekend.registrations[id].length === 0) delete weekend.registrations[id];
      });
    }
  }

  function setupWeekend() {
    for (const btn of document.querySelectorAll('#start-mode button')) {
      btn.addEventListener('click', () => {
        weekend.mode = btn.dataset.mode;
        for (const b of document.querySelectorAll('#start-mode button')) b.setAttribute('aria-pressed', String(b === btn));
        document.getElementById('weekend-result').innerHTML = '';
        renderRegistrations();
      });
    }
    document.getElementById('btn-random').addEventListener('click', () => {
      weekend.registrations = S.drawAttendance(config.people, S.rngFromSeed(Math.floor(Math.random() * 1e9)));
      renderRegistrations();
    });
    document.getElementById('btn-all-sat').addEventListener('click', () => {
      weekend.registrations = {};
      for (const p of config.people) weekend.registrations[p.id] = [2];
      renderRegistrations();
    });
    document.getElementById('btn-clear').addEventListener('click', () => {
      weekend.registrations = {};
      document.getElementById('weekend-result').innerHTML = '';
      renderRegistrations();
    });
    document.getElementById('btn-assign').addEventListener('click', assignWeekend);
  }

  function assignWeekend() {
    if (!highs) return;
    if (Object.keys(weekend.registrations).length === 0) {
      document.getElementById('weekend-result').innerHTML = '<div class="card"><p class="note">No registrations.</p></div>';
      return;
    }
    weekend.runs++;
    const state = currentState();
    const couchCap = S.capSetting(config.settings);
    const t0 = performance.now();
    const result = M.solveWeekend(highs, {
      rooms: config.rooms,
      people: config.people,
      registrations: weekend.registrations,
      balances: state.balances,
      floorNights: state.floorNights,
      settings: { ...config.settings, couchCap },
      rng: S.rngFromSeed((Number(config.settings.seed) || 1) * 7919 + weekend.runs),
    });
    const ms = performance.now() - t0;
    const outcomes =
      result.status === 'Optimal'
        ? O.assessWeekend({ result, rooms: config.rooms, people: config.people, balances: state.balances, floorNights: state.floorNights, couchCap })
        : null;
    renderWeekendResult(result, state, outcomes, ms);
  }

  function measureValue(counts, key) {
    if (key === 'util') return counts.bedroomNights ? (100 * counts.bedroomOccupied) / counts.bedroomNights : 0;
    return counts[key];
  }

  function measureText(counts, key) {
    const v = measureValue(counts, key);
    return key === 'util' ? `${v.toFixed(0)}%` : String(v);
  }

  function incidentRows(incidents, beds, withWeek) {
    if (incidents.length === 0) return '<p class="sub mono">none</p>';
    let html = `<div class="scroll"><table class="mono"><thead><tr>${withWeek ? '<th>Weekend</th>' : ''}<th>Night</th><th>Type</th><th>People</th><th>Detail</th></tr></thead><tbody>`;
    for (const x of incidents) {
      const detail = String(x.detail || '')
        .split('+')
        .map((id) => (beds.has(id) ? beds.get(id).name : (config.rooms.find((r) => r.id === id) || { name: id }).name))
        .join(' + ');
      html += `<tr>${withWeek ? `<td>${esc(season.weekends[x.week].label)}</td>` : ''}<td>${x.night === null ? 'all' : M.NIGHTS[x.night]}</td><td>${esc(INCIDENT_LABELS[x.type] || x.type)}</td><td>${esc(x.people.map(personName).join(', '))}</td><td>${esc(detail)}</td></tr>`;
    }
    return html + '</tbody></table></div>';
  }

  function renderWeekendResult(result, state, outcomes, ms) {
    const out = document.getElementById('weekend-result');
    if (result.status !== 'Optimal') {
      out.innerHTML = `<div class="card"><p class="note">Solver status: ${esc(result.status)}</p></div>`;
      return;
    }
    const balances = state.balances;
    const beds = bedInfo();
    const update = M.updateBalances(balances, result, config.rooms);
    const attending = result.parties.flatMap((p) => p.members);
    const noBed = attending.filter((id) => result.assignment[id] === M.OVERFLOW);

    let html = `<div class="card"><div class="row"><h2>Outcomes</h2><div class="spacer"></div><span class="status mono">run ${weekend.runs} · ${Math.round(ms)} ms · ${attending.length} people · obj ${plain(result.objective, 1)}</span><button class="btn small" id="btn-reassign">Re-run</button></div><div class="strip">`;
    for (const [key, label] of MEASURES) {
      html += `<div><div class="k">${label}</div><div class="v">${measureText(outcomes.counts, key)}</div></div>`;
    }
    html += '</div>';
    if (noBed.length) html += `<p class="note">No bed: ${noBed.map((id) => esc(personName(id))).join(', ')}</p>`;
    html += `<details ${outcomes.incidents.length ? 'open' : ''}><summary>Incidents (${outcomes.incidents.length})</summary>${incidentRows(outcomes.incidents, beds, false)}</details></div>`;

    html += '<div class="card"><h2>Bed plan</h2><p class="sub mono">italic = held for an absent partner · occupied / beds per night</p><div class="rooms">';
    for (const room of config.rooms) {
      const occ = outcomes.roomNights[room.id].map((x) => `${x.occupied}/${x.total}`).join(' · ');
      html += `<div class="room"><h4>${esc(room.name)}<span class="occ mono">${occ}</span></h4><div class="bedrow head"><span></span>${M.NIGHTS.map((n) => `<span>${n}</span>`).join('')}</div>`;
      for (const bed of room.beds) {
        const info = beds.get(bed.id);
        html += `<div class="bedrow"><span class="label">${esc(info.label)} · ${bed.value}</span>`;
        for (let n = 0; n < 3; n++) {
          const cell = result.plan[n][bed.id];
          if (!cell) html += '<span class="slot free">open</span>';
          else if (cell.sleepers.length === 0) {
            const party = result.parties.find((p) => p.id === cell.partyId);
            html += `<span class="slot held">${esc(party.members.map(personName).join(' & '))}</span>`;
          } else html += `<span class="slot">${esc(cell.sleepers.map(personName).join(' & '))}</span>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';

    html += '<div class="card"><h3>Open for guests</h3><table class="mono"><tbody>';
    for (let n = 0; n < 3; n++) {
      const free = result.freeBeds[n].map((id) => beds.get(id).name);
      html += `<tr><td style="width:60px">${M.NIGHTS[n]}</td><td class="num" style="width:40px">${free.length}</td><td>${free.length ? esc(free.join(' · ')) : '–'}</td></tr>`;
    }
    html += '</tbody></table></div>';

    const order = [...attending].sort((a, b) => result.weights[b] - result.weights[a]);
    html += '<div class="card"><h3>Priority</h3><div class="scroll"><table><thead><tr><th>#</th><th>Person</th><th class="num">Bal₀</th><th class="num">w</th><th>Bed</th><th class="num">v</th><th>Nights</th><th class="num">Bal₁</th></tr></thead><tbody>';
    order.forEach((id, i) => {
      const party = result.parties.find((p) => p.members.includes(id));
      const bedId = result.assignment[id];
      const bed = bedId === M.OVERFLOW ? 'No bed' : beds.get(bedId).name;
      const value = bedId === M.OVERFLOW ? 0 : beds.get(bedId).value;
      const partner = party.members.length === 2 ? `<span class="tag">+ ${esc(personName(party.members.find((m) => m !== id)))}</span>` : '';
      html += `<tr><td class="muted">${i + 1}</td><td>${esc(personName(id))}${partner}</td><td class="num">${fmt(balances[id] || 0)}</td><td class="num">${plain(result.weights[id], 2)}</td><td>${esc(bed)}</td><td class="num">${value}</td><td class="mono">${nightsText(party.memberNights[id])}</td><td class="num">${fmt(update.balances[id])}</td></tr>`;
    });
    html += '</tbody></table></div></div>';
    out.innerHTML = html;
    document.getElementById('btn-reassign').addEventListener('click', assignWeekend);
  }

  /* Season */

  function runSeason() {
    if (!highs) return;
    const status = document.getElementById('season-status');
    status.textContent = 'running…';
    setTimeout(() => {
      const t0 = performance.now();
      season = S.runSeason(highs, config);
      status.textContent = `${Math.round(performance.now() - t0)} ms · seed ${config.settings.seed}`;
      renderSeason();
    }, 20);
  }

  function renderSeason() {
    const out = document.getElementById('season-result');
    const o = season.optimizer.metrics;
    const f = season.firstCome.metrics;
    const gap = (m, a, b) => (m[a] === null || m[b] === null ? null : m[a] - m[b]);
    const maxFloor = (m) => Math.max(0, ...Object.values(m.perPerson).map((x) => x.floorNights));
    const cap = S.capSetting(config.settings);

    /* Each row: label, optimizer value, first-come value, unit, and true if a lower number is better. */
    const rows = [
      ['Fairness'],
      ['σ advantage', o.stdev, f.stdev, 'points / night', true, 2],
      ['Advantage range', o.spread, f.spread, `points, ≥ ${o.minNights} nights`, true, 2],
      ['Flexible − other singles', gap(o, 'flexibleSinglesAvg', 'otherSinglesAvg'), gap(f, 'flexibleSinglesAvg', 'otherSinglesAvg'), 'points / night', 'abs', 2],
      ['Couples − singles', gap(o, 'couplesAvg', 'singlesAvg'), gap(f, 'couplesAvg', 'singlesAvg'), 'points / night', 'abs', 2],
      ['Utilization'],
      ...MEASURES.slice(0, 4).map(([k, label, unit, lower]) => [label, measureValue(o.outcomes, k), measureValue(f.outcomes, k), unit, lower, k === 'util' ? 1 : 0]),
      ['Poor assignments'],
      ...MEASURES.slice(4).map(([k, label, unit, lower]) => [label, measureValue(o.outcomes, k), measureValue(f.outcomes, k), unit, lower, 0]),
      ['Max floor nights, one person', maxFloor(o), maxFloor(f), cap === null ? 'person-nights' : `person-nights, cap ${cap}`, true, 0],
    ];
    let html = '<div class="card"><h2>Metrics</h2><p class="sub mono">advantage = (bed value − nightly mean) / nights · bold = better · cap applies to the optimizer only</p><div class="scroll"><table class="metrics"><thead><tr><th>Measure</th><th class="num">Optimizer</th><th class="num">First come</th><th>Unit</th></tr></thead><tbody>';
    for (const [label, vo, vf, unit, lower, digits] of rows) {
      if (vo === undefined) {
        html += `<tr class="group"><td colspan="4">${label}</td></tr>`;
        continue;
      }
      const score = (v) => (lower === 'abs' ? Math.abs(v) : v);
      const better = vo === vf ? null : lower ? (score(vo) < score(vf) ? 'o' : 'f') : vo > vf ? 'o' : 'f';
      const show = (v) => (digits === 2 && lower === 'abs' ? fmt(v, 2) : plain(v, digits)) + (unit === '%' ? '%' : '');
      html += `<tr><td>${label}</td><td class="num ${better === 'o' ? 'better' : ''}">${show(vo)}</td><td class="num ${better === 'f' ? 'better' : ''}">${show(vf)}</td><td class="muted mono">${unit === '%' ? 'bedroom bed-nights' : unit}</td></tr>`;
    }
    html += '</tbody></table></div></div>';

    html += '<div class="card"><h2>Room Utilization by Night</h2><p class="sub mono">occupied bed-nights / available bed-nights, all 17 weekends</p><div class="two">';
    for (const [m, title] of [['optimizer', 'Optimizer'], ['firstCome', 'First come']]) {
      html += `<div><h3>${title}</h3><table class="mono"><thead><tr><th>Room</th>${M.NIGHTS.map((n) => `<th class="c">${n}</th>`).join('')}</tr></thead><tbody>`;
      for (const room of config.rooms) {
        html += `<tr><td>${esc(room.name)}</td>`;
        for (const x of season[m].metrics.roomNights[room.id]) {
          const pct = x.total ? (100 * x.occupied) / x.total : 0;
          const idx = Math.round((pct / 100) * (RAMP.length - 1));
          html += `<td class="pct" style="background:${RAMP[idx]};color:${idx >= 6 ? '#ffffff' : '#0b0b0b'}">${pct.toFixed(0)}%</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</div></div>';

    html += `<div class="card"><h2>Running Balance by Person and Weekend</h2><p class="sub mono">bed value points after each weekend · hover for the person</p>
      <div class="legend"><span style="--sw:var(--series-1)">Couple member</span><span style="--sw:var(--series-2)">Single</span></div>
      <div class="two"><div><h3>Optimizer</h3><div class="chart-box" style="height:300px"><canvas id="ch-bal-o"></canvas></div></div>
      <div><h3>First come</h3><div class="chart-box" style="height:300px"><canvas id="ch-bal-f"></canvas></div></div></div></div>`;

    html += `<div class="card"><h2>Advantage per Night by Person</h2><p class="sub mono">(bed value − nightly mean) / nights · label: name (F = flexible) · nights</p>
      <div class="legend"><span style="--sw:var(--series-1)">Optimizer</span><span style="--sw:var(--series-2)">First come</span></div>
      <div class="chart-box" style="height:${config.people.length * 34 + 60}px"><canvas id="ch-adv"></canvas></div></div>`;

    html += `<div class="card"><h2>Floor Nights by Person</h2><p class="sub mono">couch + air mattress + no bed · person-nights</p>
      <div class="legend"><span style="--sw:var(--series-1)">Optimizer</span><span style="--sw:var(--series-2)">First come</span></div>
      <div class="chart-box" style="height:${config.people.length * 30 + 60}px"><canvas id="ch-floor"></canvas></div></div>`;

    html += `<div class="card"><div class="row"><div><h2>Bed Value by Person and Weekend</h2><p class="sub mono">mean bed value over the nights of the weekend · hover for the bed</p></div><div class="spacer"></div>
      <div class="seg" id="grid-method"><button data-m="optimizer" aria-pressed="true">Optimizer</button><button data-m="firstCome" aria-pressed="false">First come</button></div></div>
      <div class="scroll" id="grid"></div>
      <div class="scale">0 ${RAMP.filter((_, i) => i % 2 === 0).map((c) => `<i style="background:${c}"></i>`).join('')} 10</div></div>`;

    const beds = bedInfo();
    html += '<div class="card"><h2>Incidents</h2>';
    for (const [m, title] of [['optimizer', 'Optimizer'], ['firstCome', 'First come']]) {
      const list = season[m].metrics.incidents;
      html += `<details><summary>${title} (${list.length})</summary>${incidentRows(list, beds, true)}</details>`;
    }
    html += '</div>';

    out.innerHTML = html;
    drawSeasonCharts();
    renderGrid('optimizer');
    for (const btn of document.querySelectorAll('#grid-method button')) {
      btn.addEventListener('click', () => {
        for (const b of document.querySelectorAll('#grid-method button')) b.setAttribute('aria-pressed', String(b === btn));
        renderGrid(btn.dataset.m);
      });
    }
  }

  function renderGrid(method) {
    const run = season[method];
    const beds = bedInfo();
    let html = '<table class="heat"><thead><tr><th style="text-align:left">Person</th>';
    for (const w of season.weekends) html += `<th>${esc(w.label)}</th>`;
    html += '<th class="num">Adv.</th></tr></thead><tbody>';
    for (const p of config.people) {
      html += `<tr><td class="name">${esc(p.name)}</td>`;
      run.weeks.forEach((week) => {
        const nights = week.registrations[p.id];
        const party = week.result.parties.find((x) => x.members.includes(p.id));
        if (!nights || !party) {
          html += '<td class="cell none">·</td>';
          return;
        }
        const bedId = week.result.assignment[p.id];
        const value = bedId === M.OVERFLOW ? 0 : beds.get(bedId).value;
        const idx = Math.max(0, Math.min(RAMP.length - 1, Math.round((value / 10) * (RAMP.length - 1))));
        const ink = idx >= 6 ? '#ffffff' : '#0b0b0b';
        const title = `${p.name}: ${bedId === M.OVERFLOW ? 'no bed' : beds.get(bedId).name}, ${nightsText(party.memberNights[p.id])}`;
        html += `<td class="cell" style="background:${RAMP[idx]};color:${ink}" title="${esc(title)}">${value}</td>`;
      });
      html += `<td class="num">${fmt(run.metrics.perPerson[p.id].advantage, 2)}</td></tr>`;
    }
    html += '</tbody></table>';
    document.getElementById('grid').innerHTML = html;
  }

  /* Draw the value of each bar at the end of the bar. */
  const barValues = {
    id: 'barValues',
    afterDatasetsDraw(chart, _args, opts) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = opts.color;
      ctx.textBaseline = 'middle';
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach((bar, i) => {
          const v = ds.data[i];
          if (v === null || v === undefined) return;
          const text = opts.format(v);
          const neg = v < 0;
          ctx.textAlign = neg ? 'right' : 'left';
          ctx.fillText(text, bar.x + (neg ? -4 : 4), bar.y);
        });
      });
      ctx.restore();
    },
  };

  function baseOptions() {
    const text2 = cssVar('--text-2');
    const grid = cssVar('--grid');
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.color = text2;
    return { grid, text2 };
  }

  function axisTitle(text, color) {
    return { display: true, text, color, font: { size: 12 } };
  }

  function drawSeasonCharts() {
    for (const c of Object.values(charts)) c.destroy();
    const { grid, text2 } = baseOptions();
    const s1 = cssVar('--series-1');
    const s2 = cssVar('--series-2');
    const labels = season.weekends.map((w) => w.label);

    /* Use one y range for both balance charts, so the two panels compare directly. */
    let lo = 0;
    let hi = 0;
    for (const m of ['optimizer', 'firstCome']) {
      for (const p of config.people) {
        for (const v of season[m].metrics.perPerson[p.id].balanceHistory) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const pad = (hi - lo) * 0.05 || 1;
    const balanceChart = (canvasId, method) => {
      const datasets = config.people.map((p) => ({
        label: p.name,
        data: season[method].metrics.perPerson[p.id].balanceHistory.map((v) => Math.round(v * 10) / 10),
        borderColor: p.partnerId ? s1 : s2,
        backgroundColor: p.partnerId ? s1 : s2,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0.2,
      }));
      return new Chart(document.getElementById(canvasId), {
        type: 'line',
        data: { labels, datasets },
        options: {
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)} points` } },
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, title: axisTitle('Weekend (Thursday date)', text2) },
            y: { min: Math.floor(lo - pad), max: Math.ceil(hi + pad), grid: { color: grid }, title: axisTitle('Balance (bed value points)', text2) },
          },
        },
      });
    };
    charts.balO = balanceChart('ch-bal-o', 'optimizer');
    charts.balF = balanceChart('ch-bal-f', 'firstCome');

    const names = config.people.map((p) => {
      const n = season.optimizer.metrics.perPerson[p.id].nights;
      return `${p.name}${p.flexible ? ' (F)' : ''} · ${n}`;
    });
    const hbar = (canvasId, key, digits, xTitle) => {
      const get = (m) => config.people.map((p) => {
        const v = season[m].metrics.perPerson[p.id][key];
        return v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;
      });
      return new Chart(document.getElementById(canvasId), {
        type: 'bar',
        data: {
          labels: names,
          datasets: [
            { label: 'Optimizer', data: get('optimizer'), backgroundColor: s1, borderRadius: 4, borderSkipped: false, barPercentage: 0.8, categoryPercentage: 0.8 },
            { label: 'First come', data: get('firstCome'), backgroundColor: s2, borderRadius: 4, borderSkipped: false, barPercentage: 0.8, categoryPercentage: 0.8 },
          ],
        },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          layout: { padding: { right: 36, left: 8 } },
          plugins: {
            legend: { display: false },
            barValues: { color: text2, format: (v) => (digits ? fmt(v, digits) : String(v)) },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${digits ? fmt(c.parsed.x, digits) : c.parsed.x}` } },
          },
          scales: {
            x: { grid: { color: grid }, title: axisTitle(xTitle, text2), grace: '10%' },
            y: { grid: { display: false } },
          },
        },
        plugins: [barValues],
      });
    };
    charts.adv = hbar('ch-adv', 'advantage', 2, 'Advantage per night (bed value points)');
    charts.floor = hbar('ch-floor', 'floorNights', 0, 'Floor nights (person-nights)');
  }

  /* Setup */

  function renderSettings() {
    const s = config.settings;
    const rows = [
      ['strength', 'Rotation strength s', 0, 4, 0.5, 'w = exp(−s · balance / 6). 0 = no rotation.'],
      ['noise', 'Noise ε max', 0, 5, 0.5, 'ε ~ U(0, max), bed value points.'],
      ['genderPenalty', 'Gender penalty G', 0, 10, 1, 'Cost per mixed-gender room-night.'],
    ];
    let html = '';
    for (const [key, label, min, max, step, help] of rows) {
      html += `<div class="setting"><label for="set-${key}" title="${esc(help)}">${label}</label><input type="range" id="set-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"><span class="num mono" id="val-${key}">${s[key]}</span></div>`;
    }
    const cap = S.capSetting(s);
    html += `<div class="setting"><label for="set-cap" title="Floor = couch, air mattress, or no bed. Blank = off.">Couch cap (floor nights / season)</label><input type="number" id="set-cap" min="0" step="1" value="${cap === null ? '' : cap}" placeholder="off" style="width:90px"><span></span></div>`;
    html += `<div class="setting"><label for="set-seed">Seed</label><input type="number" id="set-seed" value="${s.seed}" style="width:120px"><span></span></div>`;
    const el = document.getElementById('settings');
    el.innerHTML = html;
    for (const input of el.querySelectorAll('input[type="range"]')) {
      input.addEventListener('input', () => {
        config.settings[input.dataset.key] = Number(input.value);
        document.getElementById(`val-${input.dataset.key}`).textContent = input.value;
      });
      input.addEventListener('change', configChanged);
    }
    document.getElementById('set-cap').addEventListener('change', (e) => {
      const v = e.target.value.trim();
      config.settings.couchCap = v === '' ? null : Math.max(0, Math.floor(Number(v)) || 0);
      configChanged();
    });
    document.getElementById('set-seed').addEventListener('change', (e) => {
      config.settings.seed = Math.floor(Number(e.target.value)) || 1;
      configChanged();
    });
  }

  function renderRoomsEditor() {
    const el = document.getElementById('rooms-editor');
    let html = '';
    config.rooms.forEach((room, ri) => {
      html += `<div class="room"><div class="bed-edit"><input data-r="${ri}" data-f="name" value="${esc(room.name)}" style="flex:1;font-weight:600">
        <button class="btn small" data-act="del-room" data-r="${ri}" title="Remove room">Remove</button></div>
        <label class="sub" style="display:flex;gap:6px;align-items:center;margin:6px 0"><input type="checkbox" data-r="${ri}" data-f="common" ${room.common ? 'checked' : ''}> Shared living space</label>
        <div class="bed-list">`;
      room.beds.forEach((bed, bi) => {
        html += `<div class="bed-edit"><select data-r="${ri}" data-b="${bi}" data-f="type">${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${bed.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <label class="sub" style="margin:0">value <input type="number" min="0" max="10" step="1" data-r="${ri}" data-b="${bi}" data-f="value" value="${bed.value}"></label>
          <button class="btn small" data-act="del-bed" data-r="${ri}" data-b="${bi}" title="Remove bed">×</button></div>`;
      });
      html += `</div><button class="btn small" style="margin-top:8px" data-act="add-bed" data-r="${ri}">Add bed</button></div>`;
    });
    el.innerHTML = html;

    el.querySelectorAll('input, select').forEach((input) => {
      input.addEventListener('change', () => {
        const room = config.rooms[Number(input.dataset.r)];
        const f = input.dataset.f;
        if (input.dataset.b !== undefined) {
          const bed = room.beds[Number(input.dataset.b)];
          bed[f] = f === 'value' ? Math.max(0, Math.min(10, Number(input.value) || 0)) : input.value;
        } else if (f === 'common') room.common = input.checked;
        else room[f] = input.value;
        configChanged();
      });
    });
    el.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ri = Number(btn.dataset.r);
        if (btn.dataset.act === 'del-room') config.rooms.splice(ri, 1);
        if (btn.dataset.act === 'add-bed') config.rooms[ri].beds.push({ id: uid(config.rooms[ri].id), type: 'twin', value: 5 });
        if (btn.dataset.act === 'del-bed') config.rooms[ri].beds.splice(Number(btn.dataset.b), 1);
        configChanged();
        renderRoomsEditor();
      });
    });
  }

  function setPartner(person, partnerId) {
    for (const p of config.people) {
      if (p.partnerId === person.id || p.id === person.partnerId) p.partnerId = null;
    }
    person.partnerId = partnerId || null;
    if (partnerId) {
      const partner = config.people.find((p) => p.id === partnerId);
      for (const p of config.people) if (p.partnerId === partner.id && p !== person) p.partnerId = null;
      partner.partnerId = person.id;
    }
  }

  function renderPeopleEditor() {
    const el = document.getElementById('people-editor');
    let html = '<thead><tr><th>Name</th><th>Gender</th><th>Partner</th><th>Attend %</th><th>Usual nights</th><th class="c">Flexible</th><th></th></tr></thead><tbody>';
    config.people.forEach((p, i) => {
      html += `<tr><td><input data-i="${i}" data-f="name" value="${esc(p.name)}" style="width:120px"></td>
        <td><select data-i="${i}" data-f="gender">${['M', 'F', 'X'].map((g) => `<option ${p.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></td>
        <td><select data-i="${i}" data-f="partnerId"><option value="">None</option>${config.people.filter((q) => q.id !== p.id).map((q) => `<option value="${esc(q.id)}" ${p.partnerId === q.id ? 'selected' : ''}>${esc(q.name)}</option>`).join('')}</select></td>
        <td><input type="number" min="0" max="100" step="5" data-i="${i}" data-f="attend" value="${Math.round(p.attend * 100)}"></td>
        <td><select data-i="${i}" data-f="pattern">${Object.entries(S.PATTERN_LABELS).map(([k, v]) => `<option value="${k}" ${p.pattern === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="c"><input type="checkbox" data-i="${i}" data-f="flexible" ${p.flexible ? 'checked' : ''}></td>
        <td><button class="btn small" data-del="${i}" title="Remove person">×</button></td></tr>`;
    });
    html += '</tbody>';
    el.innerHTML = html;
    el.querySelectorAll('input, select').forEach((input) => {
      input.addEventListener('change', () => {
        const p = config.people[Number(input.dataset.i)];
        const f = input.dataset.f;
        if (f === 'partnerId') {
          setPartner(p, input.value);
          configChanged();
          renderPeopleEditor();
          return;
        }
        if (f === 'attend') p.attend = Math.max(0, Math.min(100, Number(input.value) || 0)) / 100;
        else if (f === 'flexible') p.flexible = input.checked;
        else p[f] = input.value;
        configChanged();
        if (f === 'name') renderPeopleEditor();
      });
    });
    el.querySelectorAll('button[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = config.people[Number(btn.dataset.del)];
        setPartner(p, null);
        config.people.splice(Number(btn.dataset.del), 1);
        configChanged();
        renderPeopleEditor();
      });
    });
  }

  function setupSetup() {
    renderSettings();
    renderRoomsEditor();
    renderPeopleEditor();
    document.getElementById('btn-add-room').addEventListener('click', () => {
      const id = uid('room');
      config.rooms.push({ id, name: 'New room', beds: [{ id: uid(id), type: 'twin', value: 5 }] });
      configChanged();
      renderRoomsEditor();
    });
    document.getElementById('btn-add-person').addEventListener('click', () => {
      config.people.push({ id: uid('p'), name: 'New person', gender: 'X', partnerId: null, attend: 0.6, pattern: 'fri-sat', flexible: false });
      configChanged();
      renderPeopleEditor();
    });
    document.getElementById('btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ski-lease-config.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    document.getElementById('file-import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const c = JSON.parse(await file.text());
        if (!Array.isArray(c.rooms) || !Array.isArray(c.people)) throw new Error('The file needs "rooms" and "people" lists.');
        config = { rooms: c.rooms, people: c.people, settings: { ...SkiDefaults.settings, ...(c.settings || {}) } };
        weekend.registrations = {};
        configChanged();
        setupSetupRender();
      } catch (err) {
        alert(`The import failed: ${err.message}`);
      }
      e.target.value = '';
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (!confirm('Replace the setup with the sample?')) return;
      config = defaultConfig();
      weekend.registrations = {};
      configChanged();
      setupSetupRender();
    });
  }

  function setupSetupRender() {
    renderSettings();
    renderRoomsEditor();
    renderPeopleEditor();
  }

  /* How it works */

  function renderModel() {
    document.getElementById('model').innerHTML = `
      <h2>Model</h2>
      <h3>Sets</h3>
<pre class="model mono">N = {Thu, Fri, Sat}
P = parties: a single, or two partners who both registered (nights = union)
O(p) = options of party p
  single: any bed | no bed
  couple: queen | air queen | 2 twins in one room | no bed
floor = couch, air twin, air queen, no bed</pre>
      <h3>Variables</h3>
<pre class="model mono">y[p,o] ∈ {0,1}            party p takes option o for all its nights
gM[r,n], gF[r,n], z[r,n] ∈ {0,1}   room r on night n has a male / female single / both</pre>
      <h3>Objective</h3>
<pre class="model mono">max  Σ y[p,o] · ( Σ_m n_m · [ w_m·(v_o,m + ε_o) + 0.1·v_o,m − 4·floor_o,m ]
                 + 2·n_p·queen_o
                 − 300·capExcess_o
                 − 1000·nobed_o )
     − G · Σ z[r,n]

w_m = clamp( exp(−s · bal_m / 6), 1/50, 50 )
ε_o ~ U(0, ε max)</pre>
      <h3>Constraints</h3>
<pre class="model mono">Σ_o y[p,o] = 1                          ∀ p
Σ { y[p,o] : b ∈ o, n ∈ nights(p) } ≤ 1   ∀ b, n
y[p,o] ≤ gM[r,n]   (male single in r on n),   same for gF
gM[r,n] + gF[r,n] − z[r,n] ≤ 1          ∀ bedroom r, n</pre>
      <h3>Balance update</h3>
<pre class="model mono">bal_m += v_m,n − mean_n(v)    for each night n of person m   (no bed: v = 0)
Σ_m Δbal_m,n = 0</pre>
      <h3>Outcome measures</h3>
<pre class="model mono">Bedroom utilization  occupied / available bed-nights, real beds in bedrooms
Single in queen      queen-night with one sleeper
Wasted queen         single in queen  ∧  couple in 2 beds  ∧  someone on floor, same night
Held-empty queen     queen held for a partner who is absent that night
Dominated floor      floor while a better option was free on all party nights (gender-safe)
Priority inversion   same-gender singles, same nights, Δbal > 1, higher balance has better bed
Mixed-gender room    bedroom-night with singles of two genders
Couple split         couple in 2 beds outside one twin room (first come only)
Over couch cap       floor nights above the cap</pre>
      <h3>Baseline: first come</h3>
<pre class="model mono">sign-up time t ~ Exp(1) · (0.35 if flexible)
in order of t: take the free option with the highest value per person
couple with no couple option: 2 best free beds (split)</pre>`;
  }

  /* Start */

  function start() {
    setupTabs();
    setupWeekend();
    setupSetup();
    renderModel();
    renderRegistrations();
    document.getElementById('btn-season').disabled = true;
    document.getElementById('btn-season').addEventListener('click', runSeason);
    loadSolver();
    try {
      const tab = localStorage.getItem('ski-lease-tab');
      if (tab) showTab(tab);
    } catch (e) {
      /* Storage can be blocked. */
    }
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (season) drawSeasonCharts();
    });
  }

  start();
})();
