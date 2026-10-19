/*
 * Page logic for the ski lease room engine.
 * The solver is in model.js, the measures are in outcomes.js, and the season loop is in simulate.js.
 */
(function () {
  'use strict';

  const M = window.SkiModel;
  const S = window.SkiSim;
  const O = window.SkiOutcomes;
  const STORAGE_KEY = 'ski-lease-config-v1';
  const HIGHS_BASE = 'https://cdn.jsdelivr.net/npm/highs@1.15.3/build/';
  const NIGHT_NAMES = ['Thursday', 'Friday', 'Saturday'];
  const METHODS = [
    ['optimizer', 'Optimizer'],
    ['firstCome', 'First come'],
  ];
  const TYPE_LABELS = {
    queen: 'Queen',
    twin: 'Twin',
    bunk_bottom: 'Bottom bunk',
    bunk_top: 'Top bunk',
    couch: 'Couch',
    air_queen: 'Air queen',
    air_twin: 'Air twin',
  };
  /* Outcome measures: key, label, unit, true if a lower number is better, and the hover text. */
  const MEASURES = [
    ['util', 'Bedroom utilization', 'spaces', false, 'Share of bedroom sleeping spaces in use. A queen counts as 2 spaces, so one person alone in a queen uses half of it.'],
    ['singleQueen', 'Single in queen', 'queen-nights', true, 'Nights where one person sleeps alone in a queen.'],
    ['wastedQueen', 'Wasted queen', 'queen-nights', true, 'One person alone in a queen while a couple uses two beds and someone sleeps on the floor that night. The queen cost the house a bed.'],
    ['heldEmptyQueen', 'Held-empty queen', 'queen-nights', true, 'A queen kept empty for a partner who arrives on a later night.'],
    ['floorNights', 'Floor nights', 'person-nights', true, 'Nights on a couch, an air mattress, or no bed.'],
    ['dominatedFloor', 'Avoidable floor', 'person-nights', true, 'Someone on the floor while a better bed was free for all of their nights, without a mixed-gender room.'],
    ['priorityInversion', 'Priority inversion', 'pairs', true, 'Two singles of the same gender on the same nights, and the one with lower priority got the better bed.'],
    ['mixedRoom', 'Mixed-gender room', 'room-nights', true, 'A bedroom on a night shared by singles of different genders.'],
    ['coupleSplit', 'Couple split', 'couples', true, 'A couple that sleeps in two separate beds that are not a twin pair in one room.'],
    ['capExcess', 'Over couch cap', 'person-nights', true, 'Floor nights above the season couch cap.'],
  ];
  const TIPS = {
    priority: 'High priority = due a better room. It goes up when a person gets a worse bed than the average of their group (couples or singles), and down when they get a better one. 0 = fair share so far.',
    floor: 'Floor nights so far this season: couch, air mattress, or no bed.',
    rotation: 'Correlation between priority before the weekend and bed quality, singles only. Positive = the people who were due got the better beds.',
    stdev: 'How far priority per night spreads around 0 across people. Lower = more even.',
    range: 'Highest minus lowest priority per night (people with 4 or more nights).',
    flex: 'How much better the beds of singles with flexible schedules were than other singles, per night. Near 0 = no sign-up advantage.',
    meanCouple: 'Average bed quality per night for couple members.',
    meanSingle: 'Average bed quality per night for singles.',
    maxFloor: 'Most floor nights for any one person in the season.',
  };
  const INCIDENT_LABELS = {
    wastedQueen: 'Wasted queen',
    heldEmptyQueen: 'Held-empty queen',
    dominatedFloor: 'Avoidable floor',
    priorityInversion: 'Priority inversion',
    mixedRoom: 'Mixed-gender room',
    coupleSplit: 'Couple split',
    capExcess: 'Over couch cap',
  };
  /* Sequential blue ramp from the chart palette. Index 0 is the lowest value. */
  const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

  let highs = null;
  let config = loadConfig();
  const weekend = { mode: 'fresh', registrations: {}, runs: 0, midState: null, last: null, view: 'optimizer', night: 2 };
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
    weekend.last = null;
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
    if (Number(v) === 0) return (0).toFixed(digits);
    return Number(v) > 0 ? `+${v}` : v.replace('-', '−');
  }

  function plain(x, digits = 1) {
    if (x === null || x === undefined || Number.isNaN(x)) return '–';
    return Number(x).toFixed(digits).replace('-', '−');
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function person(id) {
    return config.people.find((x) => x.id === id);
  }

  function personName(id) {
    const p = person(id);
    return p ? p.name : id;
  }

  function initials(id) {
    const name = personName(id).trim();
    const parts = name.split(/\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
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
        byId.set(bed.id, { ...full, label: `${TYPE_LABELS[bed.type]}${n}`, name: `${room.name} · ${TYPE_LABELS[bed.type].toLowerCase()}${n}` });
      }
    }
    return byId;
  }

  function nightsText(nights) {
    return nights.map((n) => M.NIGHTS[n][0]).join('');
  }

  function uid(prefix) {
    return `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function seg(id, options, current) {
    return `<div class="seg" id="${id}">${options.map(([v, l]) => `<button data-v="${v}" aria-pressed="${String(v) === String(current)}">${l}</button>`).join('')}</div>`;
  }

  function onSeg(id, handler) {
    for (const btn of document.querySelectorAll(`#${id} button`)) {
      btn.addEventListener('click', () => {
        for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute('aria-pressed', String(b === btn));
        handler(btn.dataset.v);
      });
    }
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

  /* Weekend */

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
      weekend.mode === 'fresh' ? `${weekendLabel()} · everyone starts even` : `${weekendLabel()} · priority from ${S.MID_SEASON_WEEKENDS} simulated weekends`;

    let html = `<thead><tr><th>Person</th>${M.NIGHTS.map((n) => `<th class="c">${n}</th>`).join('')}<th class="num"><span data-tip="${esc(TIPS.priority)}">Priority ⓘ</span></th><th class="num"><span data-tip="${esc(TIPS.floor)}">Floor ⓘ</span></th></tr></thead><tbody>`;
    for (const p of config.people) {
      const reg = weekend.registrations[p.id] || [];
      html += `<tr><td><span class="dot ${p.partnerId ? 'couple' : 'single'}"></span>${esc(p.name)}</td>`;
      for (let n = 0; n < 3; n++) {
        html += `<td class="c"><input type="checkbox" data-person="${esc(p.id)}" data-night="${n}" ${reg.includes(n) ? 'checked' : ''} aria-label="${esc(p.name)} ${NIGHT_NAMES[n]}"></td>`;
      }
      html += `<td class="num">${fmt(-(balances[p.id] || 0))}</td><td class="num">${floorNights[p.id] || 0}</td></tr>`;
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
    onSeg('start-mode', (mode) => {
      weekend.mode = mode;
      weekend.last = null;
      document.getElementById('weekend-result').innerHTML = '';
      renderRegistrations();
    });
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
      weekend.last = null;
      document.getElementById('weekend-result').innerHTML = '';
      renderRegistrations();
    });
    document.getElementById('btn-assign').addEventListener('click', assignWeekend);
  }

  /* Solve the weekend with both methods on the same registrations. */
  function assignWeekend() {
    if (!highs) return;
    if (Object.keys(weekend.registrations).length === 0) {
      document.getElementById('weekend-result').innerHTML = '<div class="card"><p class="note">No registrations.</p></div>';
      return;
    }
    weekend.runs++;
    const state = currentState();
    const couchCap = S.capSetting(config.settings);
    const seed = (Number(config.settings.seed) || 1) * 7919 + weekend.runs;
    const base = { rooms: config.rooms, people: config.people, registrations: weekend.registrations, balances: state.balances, floorNights: state.floorNights };
    const t0 = performance.now();
    const opt = M.solveWeekend(highs, { ...base, settings: { ...config.settings, couchCap }, rng: S.rngFromSeed(seed) });
    const ms = performance.now() - t0;
    if (opt.status !== 'Optimal') {
      document.getElementById('weekend-result').innerHTML = `<div class="card"><p class="note">Solver status: ${esc(opt.status)}</p></div>`;
      return;
    }
    const fc = S.firstComeWeekend({ ...base, rng: S.rngFromSeed(seed + 1) });
    const assess = (result) => O.assessWeekend({ result, rooms: config.rooms, people: config.people, balances: state.balances, floorNights: state.floorNights, couchCap });
    weekend.last = {
      state,
      ms,
      optimizer: { result: opt, outcomes: assess(opt), update: M.updateBalances(state.balances, opt, config.rooms) },
      firstCome: { result: fc, outcomes: assess(fc), update: M.updateBalances(state.balances, fc, config.rooms) },
    };
    renderWeekendResult();
  }

  function measureValue(counts, key) {
    if (key === 'util') return counts.bedroomNights ? (100 * counts.bedroomOccupied) / counts.bedroomNights : 0;
    return counts[key];
  }

  /* Return 'o', 'f', or null for the better method of a measure. */
  function better(vo, vf, lower) {
    if (vo === null || vf === null || vo === vf || lower === null) return null;
    if (lower === 'abs') return Math.abs(vo) < Math.abs(vf) ? 'o' : 'f';
    return lower ? (vo < vf ? 'o' : 'f') : vo > vf ? 'o' : 'f';
  }

  function compareRow(label, vo, vf, unit, lower, digits, signed, noUnit, tip) {
    const b = better(vo, vf, lower);
    const show = (v) => (signed ? fmt(v, digits) : plain(v, digits)) + (unit === '%' ? '%' : '');
    const delta = vo === null || vf === null ? '–' : fmt(vo - vf, digits);
    const name = tip ? `<span data-tip="${esc(tip)}">${label} <span class="i">ⓘ</span></span>` : label;
    return `<tr><td>${name}</td><td class="num ${b === 'o' ? 'win' : ''}">${show(vo)}</td><td class="num ${b === 'f' ? 'win' : ''}">${show(vf)}</td><td class="num muted">${delta}</td>${noUnit ? '' : `<td class="muted mono unit">${unit === '%' ? '' : unit}</td>`}</tr>`;
  }

  /* Each row: [label, optimizer value, first-come value, unit, lower is better, digits, signed, hover text]. */
  function compareTable(rows, noUnit) {
    let html = `<table class="metrics"><thead><tr><th>Measure</th><th class="num"><span class="key opt"></span>Optimizer</th><th class="num"><span class="key fc"></span>First come</th><th class="num">Δ</th>${noUnit ? '' : '<th></th>'}</tr></thead><tbody>`;
    for (const r of rows) {
      if (r.length === 1) html += `<tr class="group"><td colspan="5">${r[0]}</td></tr>`;
      else html += compareRow(r[0], r[1], r[2], r[3], r[4], r[5], r[6], noUnit, r[7]);
    }
    return html + '</tbody></table>';
  }

  function measureRows(co, cf) {
    return MEASURES.map(([k, label, unit, lower, tip]) => [label, measureValue(co, k), measureValue(cf, k), k === 'util' ? '%' : unit, lower, 0, false, tip]);
  }

  function incidentRows(incidents, beds, withWeek) {
    if (incidents.length === 0) return '<p class="sub mono">none</p>';
    let html = `<div class="scroll"><table class="mono tight"><thead><tr>${withWeek ? '<th>Weekend</th>' : ''}<th>Night</th><th>Type</th><th>People</th><th>Where</th></tr></thead><tbody>`;
    for (const x of incidents) {
      const detail = String(x.detail || '')
        .split('+')
        .map((id) => (beds.has(id) ? beds.get(id).name : (config.rooms.find((r) => r.id === id) || { name: id }).name))
        .join(' + ');
      html += `<tr>${withWeek ? `<td>${esc(season.weekends[x.week].label)}</td>` : ''}<td>${x.night === null ? 'all' : M.NIGHTS[x.night]}</td><td>${esc(INCIDENT_LABELS[x.type] || x.type)}</td><td>${esc(x.people.map(personName).join(', '))}</td><td>${esc(detail)}</td></tr>`;
    }
    return html + '</tbody></table></div>';
  }

  /*
   * Draw the rooms for one night. Each bed is a shape sized by type.
   * A chip shows a sleeper. A hollow chip shows a bed held for an absent partner.
   */
  function roomsHtml(result, outcomes, n) {
    let html = '<div class="plan">';
    for (const room of config.rooms) {
      const occ = outcomes.roomNights[room.id][n];
      html += `<div class="room ${room.common ? 'common' : ''}"><div class="room-h"><span>${esc(room.name)}</span><span class="mono muted">${occ.occupied}/${occ.total}</span></div><div class="beds">`;
      for (const bed of room.beds) {
        const cell = result.plan[n][bed.id];
        let chips = '';
        if (cell) {
          const party = result.parties.find((p) => p.id === cell.partyId);
          const cls = party.members.length === 2 ? 'couple' : 'single';
          for (const m of party.members) {
            if (result.assignment[m] !== bed.id) continue;
            const here = cell.sleepers.includes(m);
            chips += `<span class="chip ${cls} ${here ? '' : 'held'}" data-tip="${esc(personName(m))}${here ? '' : ' · held, arrives another night'}">${esc(initials(m))}</span>`;
          }
        }
        html += `<div class="bed t-${bed.type} ${cell ? '' : 'free'}" data-tip="${esc(TYPE_LABELS[bed.type])}${cell ? '' : ' · free'}">${chips}</div>`;
      }
      html += '</div></div>';
    }
    return html + '</div>';
  }

  /*
   * Correlation between the priority before the weekend and the bed value of the weekend.
   * Priority is the negative balance. A positive number shows that people with high priority got better beds.
   */
  function balanceCorrelation(run, balances) {
    const bedById = new Map(M.flattenBeds(config.rooms).map((b) => [b.id, b]));
    const xs = [];
    const ys = [];
    for (const party of run.result.parties) {
      if (party.members.length !== 1) continue;
      const m = party.members[0];
      const bedId = run.result.assignment[m];
      xs.push(-(balances[m] || 0));
      ys.push(bedId === M.OVERFLOW ? 0 : bedById.get(bedId).value);
    }
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
      syy += (ys[i] - my) ** 2;
    }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  function renderWeekendResult() {
    const last = weekend.last;
    if (!last) return;
    const out = document.getElementById('weekend-result');
    const beds = bedInfo();
    const o = last.optimizer;
    const f = last.firstCome;
    const view = last[weekend.view];
    const attending = o.result.parties.flatMap((p) => p.members);
    const fairRows = [['Rotation (r)', balanceCorrelation(o, last.state.balances), balanceCorrelation(f, last.state.balances), 'r', false, 2, true, TIPS.rotation]];
    const free = view.result.freeBeds.map((list) => list.length);
    const nightButtons = M.NIGHTS.map((x, i) => [i, `${x} <span class="free-n">${free[i]} free</span>`]);

    let html = `<div class="card"><div class="row"><h2>Optimizer vs first come</h2><span class="status mono">${attending.length} people · solved in ${Math.round(last.ms)} ms</span><div class="spacer"></div><button class="btn small" id="btn-reassign" data-tip="Solve again with a new random draw. Ties can come out differently.">Re-run</button></div>
      <div class="cols wk-cols"><div>${compareTable([['Outcomes'], ...measureRows(o.outcomes.counts, f.outcomes.counts), ['Rotation'], ...fairRows], true)}</div>
      <div><div class="row">${seg('plan-method', METHODS, weekend.view)}${seg('plan-night', nightButtons, weekend.night)}</div>
      ${roomsHtml(view.result, view.outcomes, weekend.night)}
      <div class="legend small"><span class="chip couple">AB</span>couple<span class="chip single">CD</span>single<span class="chip couple held">EF</span>held for partner<span class="bed-key"></span>free bed</div>
      <details ${view.outcomes.incidents.length ? 'open' : ''}><summary>Issues · ${weekend.view === 'optimizer' ? 'optimizer' : 'first come'} (${view.outcomes.incidents.length})</summary>${incidentRows(view.outcomes.incidents, beds, false)}</details>
      </div></div></div>`;

    const order = [...attending].sort((a, b) => (last.state.balances[a] || 0) - (last.state.balances[b] || 0));
    html += `<div class="card"><h3>Who got what, highest priority first</h3><div class="scroll"><table class="tight"><thead><tr><th>#</th><th>Person</th><th class="num"><span data-tip="${esc(TIPS.priority)}">Priority ⓘ</span></th><th>Nights</th><th><span class="key opt"></span>Optimizer</th><th class="num">Priority after</th><th><span class="key fc"></span>First come</th></tr></thead><tbody>`;
    order.forEach((id, i) => {
      const party = o.result.parties.find((p) => p.members.includes(id));
      const bedName = (run) => {
        const bedId = run.result.assignment[id];
        return bedId === M.OVERFLOW ? 'No bed' : beds.get(bedId).name;
      };
      html += `<tr><td class="muted">${i + 1}</td><td><span class="dot ${party.members.length === 2 ? 'couple' : 'single'}"></span>${esc(personName(id))}</td><td class="num">${fmt(-(last.state.balances[id] || 0))}</td><td class="mono">${party.memberNights[id].map((n) => M.NIGHTS[n]).join(' ')}</td><td>${esc(bedName(o))}</td><td class="num">${fmt(-o.update.balances[id])}</td><td class="muted">${esc(bedName(f))}</td></tr>`;
    });
    html += '</tbody></table></div></div>';
    out.innerHTML = html;
    document.getElementById('btn-reassign').addEventListener('click', assignWeekend);
    onSeg('plan-method', (v) => {
      weekend.view = v;
      renderWeekendResult();
    });
    onSeg('plan-night', (v) => {
      weekend.night = Number(v);
      renderWeekendResult();
    });
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
    const meanValue = (m, pred) => {
      const list = config.people.filter(pred).map((p) => m.perPerson[p.id]);
      const nights = list.reduce((s, x) => s + x.nights, 0);
      return nights ? list.reduce((s, x) => s + x.valueSum, 0) / nights : null;
    };

    const rows = [
      ['Fairness'],
      ['Priority spread (σ)', o.stdev, f.stdev, 'per night', true, 2, false, TIPS.stdev],
      ['Priority range', o.spread, f.spread, 'per night', true, 2, false, TIPS.range],
      ['Flexible-schedule edge', gap(o, 'flexibleSinglesAvg', 'otherSinglesAvg'), gap(f, 'flexibleSinglesAvg', 'otherSinglesAvg'), 'per night', 'abs', 2, true, TIPS.flex],
      ['Bed quality, couples', meanValue(o, (p) => !!p.partnerId), meanValue(f, (p) => !!p.partnerId), 'per night', null, 1, false, TIPS.meanCouple],
      ['Bed quality, singles', meanValue(o, (p) => !p.partnerId), meanValue(f, (p) => !p.partnerId), 'per night', null, 1, false, TIPS.meanSingle],
      ['Outcomes'],
      ...measureRows(o.outcomes, f.outcomes),
      ['Max floor nights, 1 person', maxFloor(o), maxFloor(f), cap === null ? 'nights' : `nights, cap ${cap}`, true, 0, false, TIPS.maxFloor],
    ];

    let util = `<table class="mono tight util"><thead><tr><th></th><th class="c" colspan="3"><span class="key opt"></span>Opt</th><th class="c gap" colspan="3"><span class="key fc"></span>FC</th></tr><tr><th>Room</th>${METHODS.map((_, i) => M.NIGHTS.map((n, j) => `<th class="c ${i === 1 && j === 0 ? 'gap' : ''}">${n[0]}</th>`).join('')).join('')}</tr></thead><tbody>`;
    for (const room of config.rooms) {
      util += `<tr><td>${esc(room.name)}</td>`;
      METHODS.forEach(([m], i) => {
        season[m].metrics.roomNights[room.id].forEach((x, j) => {
          const pct = x.total ? (100 * x.occupied) / x.total : 0;
          const idx = Math.round((pct / 100) * (RAMP.length - 1));
          util += `<td class="pct ${i === 1 && j === 0 ? 'gap' : ''}" style="background:${RAMP[idx]};color:${idx >= 6 ? '#ffffff' : '#0b0b0b'}">${pct.toFixed(0)}</td>`;
        });
      });
      util += '</tr>';
    }
    util += '</tbody></table><p class="sub mono">% of sleeping spaces used over the season · queen = 2 spaces</p>';

    let html = `<div class="card"><div class="cols"><div><h2>Metrics</h2>${compareTable(rows)}<p class="sub mono">bold = better · hover ⓘ for definitions</p></div><div><h2>Room Utilization by Night</h2>${util}</div></div></div>`;

    html += `<div class="card"><h2>Priority by Person and Weekend <span class="i" data-tip="${esc(TIPS.priority)}">ⓘ</span></h2><div class="legend small"><span class="key couple"></span>couple member<span class="key single"></span>single<span class="muted mono">· above 0 = due a better room · hover a line for the name</span></div>
      <div class="two"><div><h3>Optimizer</h3><div class="chart-box" style="height:220px"><canvas id="ch-bal-o"></canvas></div></div>
      <div><h3>First come</h3><div class="chart-box" style="height:220px"><canvas id="ch-bal-f"></canvas></div></div></div></div>`;

    html += `<div class="card"><div class="two"><div><h2>Priority per Night by Person</h2><div class="legend small"><span class="key opt"></span>Optimizer<span class="key fc"></span>First come<span class="muted mono">· (F) flexible schedule · nights stayed</span></div>
      <div class="chart-box" style="height:${config.people.length * 24 + 50}px"><canvas id="ch-adv"></canvas></div></div>
      <div><h2>Floor Nights by Person</h2><div class="legend small"><span class="key opt"></span>Optimizer<span class="key fc"></span>First come<span class="muted mono">· couch, air mattress, no bed</span></div>
      <div class="chart-box" style="height:${config.people.length * 24 + 50}px"><canvas id="ch-floor"></canvas></div></div></div></div>`;

    html += `<div class="card"><div class="row"><h2>Bed Quality by Person and Weekend</h2><span class="mono muted small">0–10 · hover a cell for the bed</span><div class="spacer"></div>${seg('grid-method', METHODS, 'optimizer')}</div>
      <div class="scroll" id="grid"></div>
      <div class="scale">0 ${RAMP.filter((_, i) => i % 2 === 0).map((c) => `<i style="background:${c}"></i>`).join('')} 10</div></div>`;

    const beds = bedInfo();
    html += '<div class="card"><h2>Issues</h2>';
    for (const [m, title] of METHODS) {
      const list = season[m].metrics.incidents;
      html += `<details><summary>${title} (${list.length})</summary>${incidentRows(list, beds, true)}</details>`;
    }
    html += '</div>';

    out.innerHTML = html;
    drawSeasonCharts();
    renderGrid('optimizer');
    onSeg('grid-method', renderGrid);
  }

  function renderGrid(method) {
    const run = season[method];
    const beds = bedInfo();
    let html = '<table class="heat"><thead><tr><th style="text-align:left">Person</th>';
    for (const w of season.weekends) html += `<th>${esc(w.label)}</th>`;
    html += `<th class="num"><span data-tip="Priority per night at the end of the season. Above 0 = due a better room.">Priority ⓘ</span></th></tr></thead><tbody>`;
    for (const p of config.people) {
      html += `<tr><td class="name"><span class="dot ${p.partnerId ? 'couple' : 'single'}"></span>${esc(p.name)}</td>`;
      run.weeks.forEach((week) => {
        const nights = week.registrations[p.id];
        const party = week.result.parties.find((x) => x.members.includes(p.id));
        if (!nights || !party) {
          html += '<td class="cell none"></td>';
          return;
        }
        const bedId = week.result.assignment[p.id];
        const value = bedId === M.OVERFLOW ? 0 : beds.get(bedId).value;
        const idx = Math.max(0, Math.min(RAMP.length - 1, Math.round((value / 10) * (RAMP.length - 1))));
        const ink = idx >= 6 ? '#ffffff' : '#0b0b0b';
        const title = `${p.name}: ${bedId === M.OVERFLOW ? 'no bed' : beds.get(bedId).name}, ${nightsText(party.memberNights[p.id])}`;
        html += `<td class="cell" style="background:${RAMP[idx]};color:${ink}" title="${esc(title)}">${value}</td>`;
      });
      html += `<td class="num">${fmt(-run.metrics.perPerson[p.id].advantage, 2)}</td></tr>`;
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
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.fillStyle = opts.color;
      ctx.textBaseline = 'middle';
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        if (meta.hidden) return;
        meta.data.forEach((bar, i) => {
          const v = ds.data[i];
          if (v === null || v === undefined) return;
          const neg = v < 0;
          ctx.textAlign = neg ? 'right' : 'left';
          ctx.fillText(opts.format(v), bar.x + (neg ? -3 : 3), bar.y);
        });
      });
      ctx.restore();
    },
  };

  function axisTitle(text, color) {
    return { display: true, text, color, font: { size: 11 } };
  }

  function drawSeasonCharts() {
    for (const c of Object.values(charts)) c.destroy();
    const text2 = cssVar('--text-2');
    const grid = cssVar('--grid');
    Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.color = text2;
    const cOpt = cssVar('--opt');
    const cFc = cssVar('--fc');
    const cCouple = cssVar('--couple');
    const cSingle = cssVar('--single');
    const labels = season.weekends.map((w) => w.label);

    /* Use one y range for both balance charts, so the two panels compare directly. */
    let lo = 0;
    let hi = 0;
    for (const [m] of METHODS) {
      for (const p of config.people) {
        for (const b of season[m].metrics.perPerson[p.id].balanceHistory) {
          const v = -b;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    const pad = (hi - lo) * 0.05 || 1;
    const balanceChart = (canvasId, method) =>
      new Chart(document.getElementById(canvasId), {
        type: 'line',
        data: {
          labels,
          datasets: config.people.map((p) => ({
            label: p.name,
            data: season[method].metrics.perPerson[p.id].balanceHistory.map((v) => Math.round(-v * 10) / 10),
            borderColor: p.partnerId ? cCouple : cSingle,
            backgroundColor: p.partnerId ? cCouple : cSingle,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.2,
          })),
        },
        options: {
          maintainAspectRatio: false,
          interaction: { mode: 'nearest', intersect: false },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 }, title: axisTitle('Weekend (Thursday date)', text2) },
            y: { min: Math.floor(lo - pad), max: Math.ceil(hi + pad), grid: { color: grid }, title: axisTitle('Priority (points)', text2) },
          },
        },
      });
    charts.balO = balanceChart('ch-bal-o', 'optimizer');
    charts.balF = balanceChart('ch-bal-f', 'firstCome');

    const names = config.people.map((p) => `${p.name}${p.flexible ? ' (F)' : ''} · ${season.optimizer.metrics.perPerson[p.id].nights}`);
    const hbar = (canvasId, key, digits, xTitle, sign = 1) => {
      const get = (m) =>
        config.people.map((p) => {
          const v = season[m].metrics.perPerson[p.id][key];
          return v === null ? null : Math.round(sign * v * 10 ** digits) / 10 ** digits;
        });
      const ds = (label, data, color) => ({ label, data, backgroundColor: color, borderRadius: 3, borderSkipped: false, barPercentage: 0.9, categoryPercentage: 0.8 });
      return new Chart(document.getElementById(canvasId), {
        type: 'bar',
        data: { labels: names, datasets: [ds('Optimizer', get('optimizer'), cOpt), ds('First come', get('firstCome'), cFc)] },
        options: {
          indexAxis: 'y',
          maintainAspectRatio: false,
          layout: { padding: { right: 30, left: 4 } },
          plugins: {
            legend: { display: false },
            barValues: { color: text2, format: (v) => (digits ? fmt(v, digits) : String(v)) },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${digits ? fmt(c.parsed.x, digits) : c.parsed.x}` } },
          },
          scales: { x: { grid: { color: grid }, title: axisTitle(xTitle, text2), grace: '12%' }, y: { grid: { display: false }, ticks: { font: { size: 10 } } } },
        },
        plugins: [barValues],
      });
    };
    charts.adv = hbar('ch-adv', 'advantage', 2, 'Priority per night (points)', -1);
    charts.floor = hbar('ch-floor', 'floorNights', 0, 'Floor nights (count)');
  }

  /* Setup */

  /* Each setting has named levels. A level maps to one number in the configuration. */
  const SETTING_LEVELS = [
    ['strength', 'Rotation', 'How hard the optimizer gives the good beds to people with high priority. Off = priority is ignored. Max = priority almost decides alone.', [['Off', 0], ['Gentle', 1], ['Strong', 2], ['Max', 3.5]]],
    ['noise', 'Randomness', 'A small random tie-breaker. It makes equal choices come out differently each week, so the plan is not the same every time.', [['None', 0], ['Low', 0.75], ['Med', 1.5], ['High', 3]]],
    ['genderPenalty', 'Same-gender rooms', 'How much the optimizer avoids shared rooms with singles of different genders. Strong can send someone to the couch to avoid a mixed room.', [['Ignore', 0], ['Prefer', 3], ['Strong', 8]]],
  ];

  function nearestLevel(levels, value) {
    let best = levels[0];
    for (const l of levels) if (Math.abs(l[1] - value) < Math.abs(best[1] - value)) best = l;
    return best[1];
  }

  function renderSettings() {
    const s = config.settings;
    let html = '<div class="settings">';
    for (const [key, label, tip, levels] of SETTING_LEVELS) {
      html += `<div class="set"><span class="set-l" data-tip="${esc(tip)}">${label} <span class="i">ⓘ</span></span>${seg(`set-${key}`, levels.map(([l, v]) => [v, l]), nearestLevel(levels, Number(s[key])))}</div>`;
    }
    const cap = S.capSetting(s);
    html += `<div class="set"><span class="set-l" data-tip="Most floor nights (couch, air mattress, no bed) per person per season. The optimizer goes over only if there is no other way. Blank = off.">Couch cap <span class="i">ⓘ</span></span><input type="number" id="set-cap" min="0" step="1" value="${cap === null ? '' : cap}" placeholder="off"></div>`;
    html += `<div class="set"><span class="set-l" data-tip="Fixes the random attendance and tie-breaks, so the same seed gives the same season.">Seed <span class="i">ⓘ</span></span><input type="number" id="set-seed" value="${s.seed}"></div></div>`;
    const el = document.getElementById('settings');
    el.innerHTML = html;
    for (const [key] of SETTING_LEVELS) {
      onSeg(`set-${key}`, (v) => {
        config.settings[key] = Number(v);
        configChanged();
      });
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
    let html = '<thead><tr><th>Room</th><th class="c" title="Shared living space: no gender rule">Shared</th><th>Beds (type · value)</th><th></th></tr></thead><tbody>';
    config.rooms.forEach((room, ri) => {
      html += `<tr><td><input data-r="${ri}" data-f="name" value="${esc(room.name)}" class="w-name"></td>
        <td class="c"><input type="checkbox" data-r="${ri}" data-f="common" ${room.common ? 'checked' : ''}></td><td><div class="bed-chips">`;
      room.beds.forEach((bed, bi) => {
        html += `<span class="bed-chip"><select data-r="${ri}" data-b="${bi}" data-f="type">${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${bed.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="number" min="0" max="10" step="1" data-r="${ri}" data-b="${bi}" data-f="value" value="${bed.value}"><button data-act="del-bed" data-r="${ri}" data-b="${bi}" title="Remove bed">×</button></span>`;
      });
      html += `<button class="btn small" data-act="add-bed" data-r="${ri}">+ bed</button></div></td><td><button class="btn small" data-act="del-room" data-r="${ri}" title="Remove room">×</button></td></tr>`;
    });
    el.innerHTML = html + '</tbody>';

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

  function setPartner(p, partnerId) {
    for (const q of config.people) {
      if (q.partnerId === p.id || q.id === p.partnerId) q.partnerId = null;
    }
    p.partnerId = partnerId || null;
    if (partnerId) {
      const partner = person(partnerId);
      for (const q of config.people) if (q.partnerId === partner.id && q !== p) q.partnerId = null;
      partner.partnerId = p.id;
    }
  }

  function renderPeopleEditor() {
    const el = document.getElementById('people-editor');
    let html = '<thead><tr><th>Name</th><th>G</th><th>Partner</th><th class="num">Attend %</th><th>Nights</th><th class="c" title="Earlier sign-up in first come only">Flex</th><th></th></tr></thead><tbody>';
    config.people.forEach((p, i) => {
      html += `<tr><td><input data-i="${i}" data-f="name" value="${esc(p.name)}" class="w-name"></td>
        <td><select data-i="${i}" data-f="gender">${['M', 'F', 'X'].map((g) => `<option ${p.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></td>
        <td><select data-i="${i}" data-f="partnerId"><option value="">–</option>${config.people.filter((q) => q.id !== p.id).map((q) => `<option value="${esc(q.id)}" ${p.partnerId === q.id ? 'selected' : ''}>${esc(q.name)}</option>`).join('')}</select></td>
        <td class="num"><input type="number" min="0" max="100" step="5" data-i="${i}" data-f="attend" value="${Math.round(p.attend * 100)}"></td>
        <td><select data-i="${i}" data-f="pattern">${Object.entries(S.PATTERN_LABELS).map(([k, v]) => `<option value="${k}" ${p.pattern === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
        <td class="c"><input type="checkbox" data-i="${i}" data-f="flexible" ${p.flexible ? 'checked' : ''}></td>
        <td><button class="btn small" data-del="${i}" title="Remove person">×</button></td></tr>`;
    });
    el.innerHTML = html + '</tbody>';
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

  function renderSetup() {
    renderSettings();
    renderRoomsEditor();
    renderPeopleEditor();
  }

  function setupSetup() {
    renderSetup();
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
        renderSetup();
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
      e.target.value = '';
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (!confirm('Replace the setup with the sample?')) return;
      config = defaultConfig();
      weekend.registrations = {};
      configChanged();
      renderSetup();
    });
  }

  /* Model */

  function renderModel() {
    document.getElementById('model').innerHTML = `
<div class="cols"><div>
<h3>Sets</h3>
<pre class="model mono">N    = {Thu, Fri, Sat}
P    = parties: single | 2 partners who both registered (nights = union)
O(p) = single: any bed | no bed
       couple: queen | air queen | 2 twins in 1 room | no bed
floor = couch, air twin, air queen, no bed</pre>
<h3>Variables</h3>
<pre class="model mono">y[p,o] ∈ {0,1}   party p takes option o for all its nights
gM, gF, z[r,n] ∈ {0,1}   room r, night n: male / female single / both</pre>
<h3>Objective</h3>
<pre class="model mono">max Σ y[p,o]·( Σ_m n_m·[ w_m·(v_m + ε_o) + 0.1·v_m − 4·floor_m ]
             + 5000·[couple in real queen]
             − 300·capExcess − 10000·nobed )
    − G·Σ z[r,n]

w_m = clamp(exp(s·priority_m / 6), 1/50, 50)
ε_o ~ U(0, ε max)</pre>
</div><div>
<h3>Constraints</h3>
<pre class="model mono">Σ_o y[p,o] = 1                         ∀ p
Σ { y[p,o] : b ∈ o, n ∈ nights(p) } ≤ 1  ∀ b, n
y[p,o] ≤ gM[r,n]  (male single in r, n); same for gF
gM + gF − z ≤ 1                        ∀ bedroom r, n</pre>
<h3>Priority</h3>
<pre class="model mono">pool = couple | single  (per weekend)
priority_m += mean_pool,n(v) − v_m,n    ∀ nights of m
Σ_pool Δpriority = 0  per night
high priority = due a better room</pre>
<h3>Measures</h3>
<pre class="model mono">Utilization      sleepers / spaces (queen = 2), bedrooms
Single in queen  queen-night, 1 sleeper
Wasted queen     single in Q ∧ couple in 2 beds ∧ someone on floor
Held-empty queen queen held for an absent partner
Avoidable floor  floor while a better option was free (gender-safe)
Priority inv.    same gender + nights, Δpriority > 1, lower priority has better bed
Mixed room       bedroom-night, singles of 2 genders
Couple split     couple in 2 beds outside 1 twin room</pre>
<h3>First come</h3>
<pre class="model mono">t ~ Exp(1)·(0.35 if flexible); in order of t, take the best free option
couple without a couple option → 2 best free beds</pre>
</div></div>`;
  }

  /*
   * Show one floating hover box for any element with a data-tip attribute.
   * The box is fixed to the page, so a scroll area cannot cut it off.
   */
  function setupTips() {
    const box = document.createElement('div');
    box.className = 'tipbox';
    document.body.appendChild(box);
    let current = null;
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-tip]');
      if (!el) {
        box.style.display = 'none';
        current = null;
        return;
      }
      if (el === current) return;
      current = el;
      box.textContent = el.dataset.tip;
      box.style.display = 'block';
      const r = el.getBoundingClientRect();
      const w = box.offsetWidth;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      const below = r.bottom + 6 + box.offsetHeight < window.innerHeight;
      box.style.left = `${left}px`;
      box.style.top = `${below ? r.bottom + 6 : r.top - box.offsetHeight - 6}px`;
    });
    window.addEventListener('scroll', () => {
      box.style.display = 'none';
      current = null;
    }, { passive: true });
  }

  /* Start */

  function start() {
    setupTips();
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
      if (tab && document.getElementById(`panel-${tab}`)) showTab(tab);
    } catch (e) {
      /* Storage can be blocked. */
    }
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (season) drawSeasonCharts();
    });
  }

  start();
})();
