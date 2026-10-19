/*
 * Season simulation and the first-come baseline.
 * The file works in the browser (global SkiSim) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'), require('./outcomes.js'));
  else root.SkiSim = factory(root.SkiModel, root.SkiOutcomes);
})(typeof self !== 'undefined' ? self : this, function (Model, Outcomes) {
  'use strict';

  const PATTERNS = {
    'thu-sat': [0, 1, 2],
    'fri-sat': [1, 2],
    'thu-fri': [0, 1],
    sat: [2],
    fri: [1],
  };
  const PATTERN_LABELS = {
    'thu-sat': 'Thu to Sat',
    'fri-sat': 'Fri and Sat',
    'thu-fri': 'Thu and Fri',
    sat: 'Sat only',
    fri: 'Fri only',
    mixed: 'Mixed',
  };
  const SEASON_START = Date.UTC(2027, 0, 7);
  const SEASON_WEEKENDS = 17;
  const MID_SEASON_WEEKENDS = 8;
  const PARTNER_TOGETHER = 0.8;
  const FLEXIBLE_HEAD_START = 0.35;

  /* Make a seeded random generator (mulberry32). The same seed gives the same sequence. */
  function rngFromSeed(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seasonWeekends() {
    const out = [];
    for (let i = 0; i < SEASON_WEEKENDS; i++) {
      const d = new Date(SEASON_START + i * 7 * 86400000);
      out.push({
        index: i,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      });
    }
    return out;
  }

  function drawNights(person, rng) {
    let key = person.pattern;
    if (key === 'mixed' || !PATTERNS[key]) {
      const keys = Object.keys(PATTERNS);
      key = keys[Math.floor(rng() * keys.length)];
    }
    return [...PATTERNS[key]];
  }

  /*
   * Draw the registrations for one weekend from the profiles.
   * If a person attends, the partner comes on the same nights with the probability PARTNER_TOGETHER.
   */
  function drawAttendance(people, rng) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const reg = {};
    const decided = new Set();
    for (const person of people) {
      if (decided.has(person.id)) continue;
      decided.add(person.id);
      const attends = rng() < person.attend;
      if (attends) reg[person.id] = drawNights(person, rng);
      const partner = person.partnerId ? byId.get(person.partnerId) : null;
      if (!partner || decided.has(partner.id)) continue;
      decided.add(partner.id);
      if (attends && rng() < PARTNER_TOGETHER) {
        reg[partner.id] = [...reg[person.id]];
      } else if (!attends && rng() < PARTNER_TOGETHER) {
        continue;
      } else if (rng() < partner.attend) {
        reg[partner.id] = drawNights(partner, rng);
      }
    }
    return reg;
  }

  /* Defaults for profiles that do not set the guest and calendar fields. */
  function guestRate(p) {
    return p.guestRate === undefined || p.guestRate === null ? 0.1 : Number(p.guestRate);
  }
  function guestType(p) {
    return p.guestType || (p.partnerId ? 'roommate' : 'partner');
  }
  function planAhead(p) {
    return p.planAhead === undefined || p.planAhead === null ? 0.5 : Number(p.planAhead);
  }

  /*
   * Draw one weekend: registrations, guests, and how many weeks ahead each entry is on the calendar.
   * A partner guest needs a host without a partner on that weekend. Else it becomes an any-bed guest.
   * guests[host].advance is true if the entry was on the calendar ADVANCE_WEEKS or more ahead.
   */
  function drawWeekend(people, rng, leadWeeks) {
    const registrations = drawAttendance(people, rng);
    const guests = {};
    const leads = {};
    for (const p of people) {
      if (!registrations[p.id]) continue;
      leads[p.id] = rng() < planAhead(p) ? leadWeeks : 0;
      if (rng() < guestRate(p)) {
        let type = guestType(p);
        if (type === 'partner' && p.partnerId && registrations[p.partnerId]) type = 'any';
        guests[p.id] = { type, advance: leads[p.id] >= Model.ADVANCE_WEEKS };
      }
    }
    return { registrations, guests, leads };
  }

  /* Keep only the calendar entries of a future weekend that are known `ahead` weeks before it. */
  function visibleWeek(week, ahead) {
    const registrations = {};
    const guests = {};
    for (const [id, nights] of Object.entries(week.registrations)) {
      if ((week.leads[id] || 0) < ahead) continue;
      registrations[id] = nights;
      if (week.guests[id]) guests[id] = week.guests[id];
    }
    return { registrations, guests };
  }

  /*
   * Assign the beds first come, first served.
   * Each party gets a random sign-up time. A party with a flexible person signs up earlier on average.
   * In sign-up order, each party takes the free option with the highest value for each person.
   */
  function firstComeWeekend(input) {
    const rng = input.rng || Math.random;
    const beds = Model.flattenBeds(input.rooms);
    const bedById = new Map(beds.map((b) => [b.id, b]));
    const personById = new Map(input.people.map((p) => [p.id, p]));
    const built = Model.buildParties(input.people, input.registrations, input.guests || {});
    const order = built.members.map((party, pi) => {
      const flexible = party.members.some((m) => !Model.isGuest(m) && personById.get(m).flexible);
      const time = -Math.log(1 - rng()) * (flexible ? FLEXIBLE_HEAD_START : 1);
      return { party, time };
    });
    order.sort((a, b) => a.time - b.time);

    /* Guests sign up together with their host, so a guest can take a bed before a late member. */
    const sequence = [];
    for (const { party } of order) {
      sequence.push(party);
      const host = party.kind === 'hostPartner' ? party.host : party.members.find((m) => !Model.isGuest(m));
      for (const g of built.guests) if (party.members.includes(g.host) || g.host === host) sequence.push(g);
    }

    const taken = Model.NIGHTS.map(() => new Set());
    const isFree = (party, option) => party.nights.every((n) => option.beds.every((b) => !taken[n].has(b)));
    const parties = [];
    const choices = [];
    const hostRoom = {};
    for (const party of sequence) {
      const options = Model.buildOptions(party, beds).filter((o) => !o.alone);
      let best = options.find((o) => o.overflow);
      let bestScore = -Infinity;
      for (const option of options) {
        if (option.overflow || !isFree(party, option)) continue;
        let score = party.members.reduce((s, m) => s + bedById.get(option.assign[m]).value, 0) / party.members.length + rng() * 0.01;
        if (party.kind === 'guest' && party.guestType === 'roommate' && hostRoom[party.host] === bedById.get(option.beds[0]).roomId) score += 100;
        if (score > bestScore) {
          best = option;
          bestScore = score;
        }
      }
      if (best.overflow && party.members.length === 2) best = splitCouple(party, beds, taken, rng) || best;
      parties.push(party);
      choices.push(best);
      for (const n of party.nights) for (const b of best.beds) taken[n].add(b);
      for (const m of party.members) if (!Model.isGuest(m) && best.assign[m]) hostRoom[m] = bedById.get(best.assign[m]).roomId;
    }
    return { status: 'Optimal', ...Model.finishResult(parties, choices, beds) };
  }

  /*
   * Split a couple into the two best free beds when no couple option is free.
   * Only the first-come baseline uses this. People in a free-for-all take any free bed.
   */
  function splitCouple(party, beds, taken, rng) {
    const free = beds
      .filter((b) => party.nights.every((n) => !taken[n].has(b.id)))
      .map((b) => ({ b, score: b.value + rng() * 0.01 }))
      .sort((x, y) => y.score - x.score);
    if (free.length < 2) return null;
    const [a, b] = party.members;
    return { beds: [free[0].b.id, free[1].b.id], assign: { [a]: free[0].b.id, [b]: free[1].b.id }, split: true };
  }

  /*
   * Run a number of weekends with one method.
   * attendance is a list of registrations, one for each weekend.
   */
  function runMethod(highs, config, attendance, method, seed, limit) {
    const rng = rngFromSeed(seed);
    const bedById = new Map(Model.flattenBeds(config.rooms).map((b) => [b.id, b]));
    const couchCap = capSetting(config.settings);
    const lead = Number(config.settings.leadWeeks) || 0;
    let balances = {};
    let floorNights = {};
    const weeks = [];
    const count = limit === undefined ? attendance.length : limit;
    for (let t = 0; t < count; t++) {
      const { registrations, guests } = attendance[t];
      const future = [];
      if (method === 'optimizer' && config.settings.planning) {
        for (let k = 1; k <= lead && t + k < attendance.length; k++) future.push(visibleWeek(attendance[t + k], k));
      }
      const input = {
        rooms: config.rooms,
        people: config.people,
        registrations,
        guests,
        future,
        balances,
        floorNights,
        settings: { ...config.settings, couchCap: method === 'optimizer' ? couchCap : null },
        rng,
      };
      const result = method === 'optimizer' ? Model.solveWeekend(highs, input) : firstComeWeekend(input);
      const people = Model.withGuests(config.people, guests);
      const outcomes = Outcomes.assessWeekend({ result, rooms: config.rooms, people, balances, floorNights, couchCap });
      const update = Model.updateBalances(balances, result, config.rooms);
      weeks.push({ registrations, guests, leads: attendance[t].leads, result, outcomes, nightly: update.nightly, balancesBefore: balances, balancesAfter: update.balances });
      balances = update.balances;
      floorNights = addFloorNights(floorNights, result, bedById);
    }
    return { method, weeks, balances, floorNights };
  }

  /* Return the couch cap as a number, or null if the cap is off. */
  function capSetting(settings) {
    const cap = settings.couchCap;
    return cap === null || cap === undefined || cap === '' || Number.isNaN(Number(cap)) ? null : Number(cap);
  }

  function addFloorNights(floorNights, result, bedById) {
    const next = { ...floorNights };
    for (const party of result.parties) {
      for (const m of party.members) {
        if (Model.isGuest(m)) continue;
        if (Model.isFloor(result.assignment[m], bedById)) next[m] = (next[m] || 0) + party.memberNights[m].length;
      }
    }
    return next;
  }

  function drawSeasonAttendance(people, seed, count, leadWeeks) {
    const rng = rngFromSeed(seed);
    const out = [];
    for (let i = 0; i < count; i++) out.push(drawWeekend(people, rng, Number(leadWeeks) || 0));
    return out;
  }

  /* Run the full season with both methods on the same attendance. */
  function runSeason(highs, config) {
    const seed = Number(config.settings.seed) || 1;
    const attendance = drawSeasonAttendance(config.people, seed, SEASON_WEEKENDS, config.settings.leadWeeks);
    const optimizer = runMethod(highs, config, attendance, 'optimizer', seed + 1);
    const firstCome = runMethod(highs, config, attendance, 'firstCome', seed + 2);
    return {
      weekends: seasonWeekends(),
      attendance,
      optimizer: { ...optimizer, metrics: metrics(optimizer, config) },
      firstCome: { ...firstCome, metrics: metrics(firstCome, config) },
    };
  }

  /* Run the optimizer on the first MID_SEASON_WEEKENDS weekends. Return the balances and the floor nights. */
  function midSeasonState(highs, config) {
    const seed = Number(config.settings.seed) || 1;
    const attendance = drawSeasonAttendance(config.people, seed, SEASON_WEEKENDS, config.settings.leadWeeks);
    const run = runMethod(highs, config, attendance, 'optimizer', seed + 1, MID_SEASON_WEEKENDS);
    return { balances: run.balances, floorNights: run.floorNights, attendance };
  }

  /*
   * Calculate the numbers for each person and the summary of one method.
   * advantage is the final balance divided by the nights. It is the average bed value above the average of each night.
   * spread is the highest minus the lowest advantage, over the people with at least MIN_NIGHTS nights.
   * stdev is the standard deviation of advantage over all person-nights. Each person counts once for each night.
   */
  const MIN_NIGHTS = 4;
  function metrics(run, config) {
    const bedById = new Map(Model.flattenBeds(config.rooms).map((b) => [b.id, b]));
    const perPerson = {};
    for (const p of config.people) {
      perPerson[p.id] = { nights: 0, valueSum: 0, couchNights: 0, overflowNights: 0, balanceHistory: [] };
    }
    for (const week of run.weeks) {
      for (const night of week.nightly) {
        for (const row of night.rows) {
          const m = perPerson[row.personId];
          if (!m) continue;
          m.nights++;
          m.valueSum += row.value;
          const bedId = week.result.assignment[row.personId];
          if (bedId === Model.OVERFLOW) m.overflowNights++;
          else if (bedById.get(bedId).type === 'couch') m.couchNights++;
        }
      }
      for (const p of config.people) perPerson[p.id].balanceHistory.push(week.balancesAfter[p.id] || 0);
    }
    for (const p of config.people) {
      const m = perPerson[p.id];
      m.balance = run.balances[p.id] || 0;
      m.avgValue = m.nights ? m.valueSum / m.nights : null;
      m.advantage = m.nights ? m.balance / m.nights : null;
    }

    const regular = config.people.filter((p) => perPerson[p.id].nights >= MIN_NIGHTS);
    const avgs = regular.map((p) => perPerson[p.id].advantage);
    const group = (pred) => {
      const list = config.people.filter(pred);
      const nights = list.reduce((s, p) => s + perPerson[p.id].nights, 0);
      const balance = list.reduce((s, p) => s + perPerson[p.id].balance, 0);
      return nights ? balance / nights : null;
    };
    let totalNights = 0;
    let sumSquares = 0;
    for (const m of Object.values(perPerson)) {
      if (!m.nights) continue;
      totalNights += m.nights;
      sumSquares += m.nights * m.advantage ** 2;
    }
    const summed = Outcomes.sumOutcomes(run.weeks.map((w) => w.outcomes), config.rooms);
    for (const p of config.people) perPerson[p.id].floorNights = run.floorNights[p.id] || 0;
    return {
      perPerson,
      outcomes: summed.counts,
      roomNights: summed.roomNights,
      incidents: run.weeks.flatMap((w, wi) => w.outcomes.incidents.map((x) => ({ ...x, week: wi }))),
      stdev: totalNights ? Math.sqrt(sumSquares / totalNights) : 0,
      spread: avgs.length ? Math.max(...avgs) - Math.min(...avgs) : 0,
      couchNights: Object.values(perPerson).reduce((s, m) => s + m.couchNights, 0),
      overflowNights: Object.values(perPerson).reduce((s, m) => s + m.overflowNights, 0),
      flexibleAvg: group((p) => p.flexible),
      otherAvg: group((p) => !p.flexible),
      flexibleSinglesAvg: group((p) => p.flexible && !p.partnerId),
      otherSinglesAvg: group((p) => !p.flexible && !p.partnerId),
      couplesAvg: group((p) => !!p.partnerId),
      singlesAvg: group((p) => !p.partnerId),
      minNights: MIN_NIGHTS,
    };
  }

  return {
    PATTERNS,
    PATTERN_LABELS,
    SEASON_WEEKENDS,
    MID_SEASON_WEEKENDS,
    rngFromSeed,
    seasonWeekends,
    drawAttendance,
    drawWeekend,
    visibleWeek,
    guestRate,
    guestType,
    planAhead,
    firstComeWeekend,
    runMethod,
    runSeason,
    midSeasonState,
    drawSeasonAttendance,
    capSetting,
    metrics,
  };
});
