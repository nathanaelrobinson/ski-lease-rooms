/*
 * Page logic for the ski lease room demo.
 * The solver logic is in model.js and the season logic is in simulate.js.
 */
(function () {
  'use strict';

  const M = window.SkiModel;
  const S = window.SkiSim;
  const STORAGE_KEY = 'ski-lease-config-v1';
  const HIGHS_BASE = 'https://cdn.jsdelivr.net/npm/highs@1.15.3/build/';
  const NIGHT_NAMES = ['Thursday', 'Friday', 'Saturday'];
  const TYPE_LABELS = { queen: 'Queen', twin: 'Twin', bunk_bottom: 'Bottom bunk', bunk_top: 'Top bunk', couch: 'Couch' };
  /* Sequential blue ramp from the chart palette. Step 100 is value 0 and step 700 is value 10. */
  const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

  let highs = null;
  let config = loadConfig();
  let weekend = { mode: 'fresh', registrations: {}, runs: 0, midBalances: null };
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
    weekend.midBalances = null;
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
    statuses.forEach((el) => (el.textContent = 'Loading the solver…'));
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
        statuses.forEach((el) => (el.textContent = `The solver did not load: ${err.message || err}`));
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

  function currentBalances() {
    if (weekend.mode === 'fresh') return {};
    if (!weekend.midBalances && highs) weekend.midBalances = S.midSeasonBalances(highs, config);
    return weekend.midBalances || {};
  }

  function weekendLabel() {
    const weekends = S.seasonWeekends();
    return weekend.mode === 'fresh' ? weekends[0].label : weekends[S.MID_SEASON_WEEKENDS].label;
  }

  function renderRegistrations() {
    const balances = currentBalances();
    const sub = document.getElementById('weekend-sub');
    sub.textContent =
      weekend.mode === 'fresh'
        ? `Weekend of ${weekendLabel()}. All balances start at zero, so the random term decides between equal people.`
        : `Weekend of ${weekendLabel()}. The balances come from a simulation of the first ${S.MID_SEASON_WEEKENDS} weekends with the optimizer.`;

    const ranked = config.people
      .map((p) => ({ id: p.id, bal: balances[p.id] || 0 }))
      .sort((a, b) => a.bal - b.bal);
    const rank = new Map(ranked.map((r, i) => [r.id, i + 1]));

    let html = '<thead><tr><th>Person</th>';
    for (const n of NIGHT_NAMES) html += `<th class="c">${n.slice(0, 3)}</th>`;
    html += '<th class="num">Balance</th><th class="num">Priority</th></tr></thead><tbody>';
    for (const p of config.people) {
      const reg = weekend.registrations[p.id] || [];
      const partner = p.partnerId ? config.people.find((x) => x.id === p.partnerId) : null;
      html += `<tr><td>${esc(p.name)}${partner ? `<span class="tag">with ${esc(partner.name)}</span>` : ''}</td>`;
      for (let n = 0; n < 3; n++) {
        html += `<td class="c"><input type="checkbox" data-person="${esc(p.id)}" data-night="${n}" ${reg.includes(n) ? 'checked' : ''} aria-label="${esc(p.name)} ${NIGHT_NAMES[n]}"></td>`;
      }
      html += `<td class="num">${fmt(balances[p.id] || 0)}</td><td class="num muted">${weekend.mode === 'fresh' ? 'equal' : `#${rank.get(p.id)}`}</td></tr>`;
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
      document.getElementById('weekend-result').innerHTML = '<div class="card"><p class="note">Nobody is registered. Click Random sign-up or tick some nights.</p></div>';
      return;
    }
    weekend.runs++;
    const balances = currentBalances();
    const t0 = performance.now();
    const result = M.solveWeekend(highs, {
      rooms: config.rooms,
      people: config.people,
      registrations: weekend.registrations,
      balances,
      settings: config.settings,
      rng: S.rngFromSeed((Number(config.settings.seed) || 1) * 7919 + weekend.runs),
    });
    const ms = performance.now() - t0;
    renderWeekendResult(result, balances, ms);
  }

  function renderWeekendResult(result, balances, ms) {
    const out = document.getElementById('weekend-result');
    if (result.status !== 'Optimal') {
      out.innerHTML = `<div class="card"><p class="note">The solver returned the status "${esc(result.status)}".</p></div>`;
      return;
    }
    const beds = bedInfo();
    const update = M.updateBalances(balances, result, config.rooms);
    const attending = result.parties.flatMap((p) => p.members);
    const overflow = attending.filter((id) => result.assignment[id] === M.OVERFLOW);

    let html = `<div class="card"><div class="row"><h2>Bed plan</h2><div class="spacer"></div><span class="status">Run ${weekend.runs}. Solved in ${Math.round(ms)} ms. ${attending.length} people.</span><button class="btn small" id="btn-reassign">Assign again</button></div>`;
    html += '<p class="sub">Each person keeps one bed for all their nights. An italic name shows a bed that a couple holds for a partner who arrives on another night.</p>';
    if (overflow.length) html += `<p class="note">Not enough beds: ${overflow.map((id) => esc(personName(id))).join(', ')} get an air mattress.</p>`;
    html += '<div class="rooms">';
    for (const room of config.rooms) {
      html += `<div class="room"><h4>${esc(room.name)}</h4><div class="bedrow head"><span></span>${M.NIGHTS.map((n) => `<span>${n}</span>`).join('')}</div>`;
      for (const bed of room.beds) {
        const info = beds.get(bed.id);
        html += `<div class="bedrow"><span class="label">${esc(info.label)} · ${bed.value}</span>`;
        for (let n = 0; n < 3; n++) {
          const cell = result.plan[n][bed.id];
          if (!cell) html += '<span class="slot free">open</span>';
          else if (cell.sleepers.length === 0) {
            const party = result.parties.find((p) => p.id === cell.partyId);
            html += `<span class="slot held" title="Held for the couple">${esc(party.members.map(personName).join(' & '))}</span>`;
          } else html += `<span class="slot">${esc(cell.sleepers.map(personName).join(' & '))}</span>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';

    /* Open beds for guests */
    html += '<div class="card"><h3>Open for guests</h3><table><tbody>';
    for (let n = 0; n < 3; n++) {
      const free = result.freeBeds[n].map((id) => beds.get(id).name);
      html += `<tr><td style="width:110px">${NIGHT_NAMES[n]}</td><td>${free.length ? esc(free.join('; ')) : '<span class="muted">None</span>'}</td></tr>`;
    }
    html += '</tbody></table></div>';

    /* Reason for each person, in priority order */
    const order = [...attending].sort((a, b) => result.weights[b] - result.weights[a]);
    html += '<div class="card"><h3>Why each person got their bed</h3><p class="sub">People are in priority order. A lower balance gives a higher weight. The weight multiplies the bed value in the optimizer.</p><div class="scroll"><table><thead><tr><th>#</th><th>Person</th><th class="num">Balance before</th><th class="num">Weight</th><th>Bed</th><th>Nights</th><th class="num">Balance after</th></tr></thead><tbody>';
    order.forEach((id, i) => {
      const party = result.parties.find((p) => p.members.includes(id));
      const bedId = result.assignment[id];
      const bed = bedId === M.OVERFLOW ? 'Air mattress (0)' : `${beds.get(bedId).name} (${beds.get(bedId).value})`;
      const partner = party.members.length === 2 ? `<span class="tag">with ${esc(personName(party.members.find((m) => m !== id)))}</span>` : '';
      html += `<tr><td class="muted">${i + 1}</td><td>${esc(personName(id))}${partner}</td><td class="num">${fmt(balances[id] || 0)}</td><td class="num">${plain(result.weights[id], 2)}</td><td>${esc(bed)}</td><td>${nightsText(party.memberNights[id])}</td><td class="num">${fmt(update.balances[id])}</td></tr>`;
    });
    html += '</tbody></table></div>';
    if (result.mixedRoomNights) html += `<p class="sub" style="margin-top:8px">${result.mixedRoomNights} room-night(s) have singles of two genders, because no better plan was possible.</p>`;
    html += '</div>';
    out.innerHTML = html;
    document.getElementById('btn-reassign').addEventListener('click', assignWeekend);
  }

  /* Season */

  function runSeason() {
    if (!highs) return;
    const status = document.getElementById('season-status');
    status.textContent = 'Running 17 weekends…';
    setTimeout(() => {
      const t0 = performance.now();
      season = S.runSeason(highs, config);
      status.textContent = `Done in ${Math.round(performance.now() - t0)} ms. Seed ${config.settings.seed}.`;
      renderSeason();
    }, 20);
  }

  function renderSeason() {
    const out = document.getElementById('season-result');
    const o = season.optimizer.metrics;
    const f = season.firstCome.metrics;
    const gap = (m, a, b) => (m[a] === null || m[b] === null ? null : m[a] - m[b]);
    const tile = (k, vo, vf, d) =>
      `<div class="tile"><div class="k">${k}</div><div class="v">${vo} <span class="vs">optimizer</span></div><div class="v" style="font-size:16px">${vf} <span class="vs">first come</span></div><div class="d">${d}</div></div>`;

    let html = '<div class="card"><h2>Summary</h2><p class="sub">Advantage is the bed value that a person got above the average bed value of the same night, averaged over their nights. A fair rotation keeps every advantage close to 0.</p><div class="tiles">';
    html += tile('Standard deviation of advantage', plain(o.stdev, 2), plain(f.stdev, 2), 'Points. Over all person-nights.');
    html += tile('Highest minus lowest advantage', plain(o.spread, 2), plain(f.spread, 2), `Points. People with ${o.minNights} or more nights.`);
    html += tile('Flexible singles minus other singles', fmt(gap(o, 'flexibleSinglesAvg', 'otherSinglesAvg'), 2), fmt(gap(f, 'flexibleSinglesAvg', 'otherSinglesAvg'), 2), 'Points of advantage per night. This shows the sign-up bias.');
    html += tile('Couples minus singles', fmt(gap(o, 'couplesAvg', 'singlesAvg'), 2), fmt(gap(f, 'couplesAvg', 'singlesAvg'), 2), 'Points of advantage per night. Couples can only use queens and twin pairs.');
    html += tile('Couch and air-mattress nights', `${o.couchNights + o.overflowNights}`, `${f.couchNights + f.overflowNights}`, 'Person-nights in the season.');
    html += '</div><p class="sub" style="margin:12px 0 0">The optimizer can use the couch more often, for two reasons. It avoids rooms with singles of two genders, and the first-come method ignores gender. A person also keeps one bed for the stay, so a bed that is free on one night can be held for another night.</p></div>';

    html += `<div class="card"><h2>Running Balance by Person and Weekend</h2><p class="sub">One line for each person. Balance in bed value points, after each weekend. Hover a line to see the person.</p>
      <div class="legend"><span style="--sw:var(--series-1)">Member of a couple</span><span style="--sw:var(--series-2)">Single</span></div>
      <div class="two"><div><h3>Optimizer</h3><div class="chart-box" style="height:300px"><canvas id="ch-bal-o"></canvas></div></div>
      <div><h3>First come, first served</h3><div class="chart-box" style="height:300px"><canvas id="ch-bal-f"></canvas></div></div></div></div>`;

    html += `<div class="card"><h2>Advantage per Night by Person</h2><p class="sub">Bed value minus the nightly average, averaged over the nights of each person, in points. The number after each name is the nights stayed. A flag (F) shows a flexible schedule.</p>
      <div class="legend"><span style="--sw:var(--series-1)">Optimizer</span><span style="--sw:var(--series-2)">First come</span></div>
      <div class="chart-box" style="height:${config.people.length * 34 + 60}px"><canvas id="ch-adv"></canvas></div></div>`;

    html += `<div class="card"><h2>Couch and Air-Mattress Nights by Person</h2><p class="sub">Person-nights in the season.</p>
      <div class="legend"><span style="--sw:var(--series-1)">Optimizer</span><span style="--sw:var(--series-2)">First come</span></div>
      <div class="chart-box" style="height:${config.people.length * 30 + 60}px"><canvas id="ch-couch"></canvas></div></div>`;

    html += `<div class="card"><div class="row"><div><h2>Bed Value by Person and Weekend</h2><p class="sub">Average bed value over the nights of each weekend. An empty cell shows that the person did not attend. Hover a cell to see the bed.</p></div><div class="spacer"></div>
      <div class="seg" id="grid-method"><button data-m="optimizer" aria-pressed="true">Optimizer</button><button data-m="firstCome" aria-pressed="false">First come</button></div></div>
      <div class="scroll" id="grid"></div>
      <div class="scale">0 ${RAMP.filter((_, i) => i % 2 === 0).map((c) => `<i style="background:${c}"></i>`).join('')} 10 points</div></div>`;

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
        const title = `${p.name}: ${bedId === M.OVERFLOW ? 'air mattress' : beds.get(bedId).name}, ${nightsText(party.memberNights[p.id])}`;
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
    const couchKey = 'couchPlusOverflow';
    for (const m of ['optimizer', 'firstCome']) {
      for (const pm of Object.values(season[m].metrics.perPerson)) pm[couchKey] = pm.couchNights + pm.overflowNights;
    }
    charts.couch = hbar('ch-couch', couchKey, 0, 'Couch and air-mattress nights (count)');
  }

  /* Setup */

  function renderSettings() {
    const s = config.settings;
    const rows = [
      ['strength', 'Rotation strength', 0, 4, 0.5, 'How hard the optimizer favors people with low balances. 0 turns rotation off.'],
      ['noise', 'Randomness', 0, 5, 0.5, 'Size of the random term, in bed value points.'],
      ['genderPenalty', 'Gender matching', 0, 10, 1, 'Penalty for a shared room with singles of two genders on a night.'],
    ];
    let html = '';
    for (const [key, label, min, max, step, help] of rows) {
      html += `<div class="setting"><label for="set-${key}" title="${esc(help)}">${label}</label><input type="range" id="set-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}"><span class="num" id="val-${key}">${s[key]}</span></div>`;
    }
    html += `<div class="setting"><label for="set-seed">Random seed</label><input type="number" id="set-seed" value="${s.seed}" style="width:120px"><span></span></div>`;
    html += '<p class="sub">The seed fixes the random attendance and the random term, so the same seed gives the same season.</p>';
    const el = document.getElementById('settings');
    el.innerHTML = html;
    for (const input of el.querySelectorAll('input[type="range"]')) {
      input.addEventListener('input', () => {
        config.settings[input.dataset.key] = Number(input.value);
        document.getElementById(`val-${input.dataset.key}`).textContent = input.value;
      });
      input.addEventListener('change', configChanged);
    }
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
    let html = '<thead><tr><th>Name</th><th>Gender</th><th>Partner</th><th>Attend %</th><th>Usual nights</th><th class="c">Flexible schedule</th><th></th></tr></thead><tbody>';
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
      if (!confirm('Replace the rooms, people, and settings with the sample?')) return;
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

  function renderHow() {
    document.getElementById('how').innerHTML = `
      <h2>How the assignment works</h2>
      <p>Members register for Thursday, Friday, or Saturday night by Tuesday evening. Then the optimizer assigns all beds at the same time, so the sign-up time has no effect.</p>
      <h3>Rules</h3>
      <p>Each person keeps one bed for all the nights of a stay. A bed holds one party on a night. A couple takes a queen, or two twins in the same room. If partners come on different nights, the couple holds its bed for all the nights that either partner stays. If only one partner comes, that person registers as a single. Singles can share twin and bunk rooms, and the optimizer tries to keep shared rooms to one gender. If more people come than there are beds, the last people get an air mattress. After the assignment, the free beds on each night are open for guests.</p>
      <h3>Fairness</h3>
      <p>Each person has a balance. On each night, the optimizer calculates the average bed value of all people in the house. Each person's balance then goes up by the value of their bed minus that average. A balance above 0 means that the person got better beds than average so far. The balances on each night add up to 0, so a person on a crowded Saturday is compared with the other people on that Saturday, not with a quiet Thursday.</p>
      <h3>Priority and randomness</h3>
      <p>Each person gets a weight of exp(−strength × balance ÷ 6). A person 3 points behind has about 2.7 times the weight of a person at 0, with the default strength of 2. The optimizer is a mixed-integer program. It finds the plan with the highest sum of weight × bed value over all person-nights, under the rules above. A small random term, scaled by each weight, makes equal choices come out differently each week.</p>
      <h3>Solver</h3>
      <p>The page uses HiGHS, an open-source solver, compiled to WebAssembly. It runs in your browser. No data leaves the page.</p>`;
  }

  /* Start */

  function start() {
    setupTabs();
    setupWeekend();
    setupSetup();
    renderHow();
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
