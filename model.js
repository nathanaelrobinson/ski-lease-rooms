/*
 * Room allocation model for one weekend.
 * The file works in the browser (global SkiModel) and in Node (module.exports).
 * All functions are pure. The caller gives the HiGHS instance and the random generator.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkiModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NIGHTS = ['Thu', 'Fri', 'Sat'];
  const OVERFLOW = null;
  const OVERFLOW_PENALTY = 1000;
  const BASE_WEIGHT = 0.1;

  const DEFAULT_SETTINGS = {
    strength: 2,
    noise: 1.5,
    genderPenalty: 3,
    coupleBonus: 2,
  };

  /* Make one flat list of beds. Each bed keeps the data of its room. */
  function flattenBeds(rooms) {
    const beds = [];
    for (const room of rooms) {
      for (const bed of room.beds) {
        beds.push({
          id: bed.id,
          type: bed.type,
          value: Number(bed.value),
          roomId: room.id,
          roomName: room.name,
          common: !!room.common,
        });
      }
    }
    return beds;
  }

  /*
   * Make the parties from the registrations.
   * registrations maps a person id to a list of night indexes.
   * Two partners who both registered become one party for the union of their nights.
   */
  function buildParties(people, registrations) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const used = new Set();
    const parties = [];
    for (const person of people) {
      const nights = registrations[person.id];
      if (!nights || nights.length === 0 || used.has(person.id)) continue;
      used.add(person.id);
      const partner = person.partnerId ? byId.get(person.partnerId) : null;
      const partnerNights = partner ? registrations[partner.id] : null;
      if (partner && partnerNights && partnerNights.length > 0 && !used.has(partner.id)) {
        used.add(partner.id);
        const union = [...new Set([...nights, ...partnerNights])].sort();
        parties.push({
          id: `c_${person.id}_${partner.id}`,
          members: [person.id, partner.id],
          nights: union,
          memberNights: { [person.id]: [...nights].sort(), [partner.id]: [...partnerNights].sort() },
        });
      } else {
        parties.push({
          id: `s_${person.id}`,
          members: [person.id],
          nights: [...nights].sort(),
          memberNights: { [person.id]: [...nights].sort() },
        });
      }
    }
    return parties;
  }

  /*
   * List the placement options of a party.
   * A single can take any bed. A couple can take a queen or two twins in the same room.
   * Every party also has an overflow option that uses no bed.
   */
  function buildOptions(party, beds) {
    const options = [];
    if (party.members.length === 1) {
      const [m] = party.members;
      for (const bed of beds) options.push({ beds: [bed.id], assign: { [m]: bed.id } });
    } else {
      const [a, b] = party.members;
      for (const bed of beds) {
        if (bed.type === 'queen') options.push({ beds: [bed.id], assign: { [a]: bed.id, [b]: bed.id }, queen: true });
      }
      const twinsByRoom = new Map();
      for (const bed of beds) {
        if (bed.type !== 'twin') continue;
        if (!twinsByRoom.has(bed.roomId)) twinsByRoom.set(bed.roomId, []);
        twinsByRoom.get(bed.roomId).push(bed);
      }
      for (const twins of twinsByRoom.values()) {
        for (let i = 0; i < twins.length; i++) {
          for (let j = i + 1; j < twins.length; j++) {
            options.push({ beds: [twins[i].id, twins[j].id], assign: { [a]: twins[i].id, [b]: twins[j].id } });
          }
        }
      }
    }
    const assign = {};
    for (const m of party.members) assign[m] = OVERFLOW;
    options.push({ beds: [], assign, overflow: true });
    return options;
  }

  /*
   * Calculate the priority weight of each person who attends.
   * The weight is exp(-strength * balance / BALANCE_SCALE). A strength of 0 gives a weight of 1 to all people.
   * With the default strength of 2, a person 3 points behind has about 2.7 times the weight of a person at 0.
   * The weight is absolute, so a person far behind gets a strong push, not only the top rank.
   */
  const BALANCE_SCALE = 6;
  const MAX_WEIGHT = 50;
  function priorityWeights(personIds, balances, strength) {
    const weights = {};
    for (const id of personIds) {
      const w = Math.exp((-strength * (balances[id] || 0)) / BALANCE_SCALE);
      weights[id] = Math.min(MAX_WEIGHT, Math.max(1 / MAX_WEIGHT, w));
    }
    return weights;
  }

  function term(coef, name) {
    const c = Math.round(coef * 1e6) / 1e6;
    return `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${name}`;
  }

  function lines(terms) {
    const out = [];
    for (let i = 0; i < terms.length; i += 8) out.push(' ' + terms.slice(i, i + 8).join(' '));
    return out.join('\n');
  }

  /*
   * Solve one weekend.
   * input: { rooms, people, registrations, balances, settings, rng }.
   * The function returns the same result shape as the first-come baseline.
   */
  function solveWeekend(highs, input) {
    const settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
    const rng = input.rng || Math.random;
    const balances = input.balances || {};
    const beds = flattenBeds(input.rooms);
    const bedById = new Map(beds.map((b) => [b.id, b]));
    const people = input.people;
    const personById = new Map(people.map((p) => [p.id, p]));
    const parties = buildParties(people, input.registrations);
    const attendees = parties.flatMap((p) => p.members);
    const weights = priorityWeights(attendees, balances, settings.strength);

    /* Make one variable for each pair of party and option. */
    const vars = [];
    parties.forEach((party, pi) => {
      for (const option of buildOptions(party, beds)) {
        /*
         * The random term scales with the weight, so it never moves a person to a worse bed type.
         * The base term BASE_WEIGHT * value makes the solver fill the better beds first.
         */
        let score = 0;
        let personNights = 0;
        const jitter = rng() * settings.noise;
        for (const m of party.members) {
          const n = party.memberNights[m].length;
          personNights += n;
          const bedId = option.assign[m];
          const value = bedId === OVERFLOW ? 0 : bedById.get(bedId).value;
          score += (weights[m] * (value + jitter) + BASE_WEIGHT * value) * n;
        }
        if (option.queen) score += settings.coupleBonus * party.nights.length;
        if (option.overflow) score -= OVERFLOW_PENALTY * personNights;
        vars.push({ name: `y${vars.length}`, partyIndex: pi, option, score });
      }
    });

    const rows = [];
    const extraVars = [];
    const objTerms = vars.map((v) => term(v.score, v.name));

    /* Each party takes exactly one option. */
    parties.forEach((party, pi) => {
      const t = vars.filter((v) => v.partyIndex === pi).map((v) => term(1, v.name));
      rows.push(`party${pi}:\n${lines(t)} = 1`);
    });

    /* On each night, each bed holds at most one party. */
    for (const bed of beds) {
      for (let n = 0; n < NIGHTS.length; n++) {
        const t = vars
          .filter((v) => v.option.beds.includes(bed.id) && parties[v.partyIndex].nights.includes(n))
          .map((v) => term(1, v.name));
        if (t.length > 1) rows.push(`bed_${rows.length}:\n${lines(t)} <= 1`);
      }
    }

    /*
     * Apply a penalty to a shared room on a night with singles of two genders.
     * gM and gF show that a male or a female single is in the room. z shows a mixed room.
     */
    if (settings.genderPenalty > 0) {
      const rooms = new Map();
      for (const bed of beds) {
        if (bed.common) continue;
        if (!rooms.has(bed.roomId)) rooms.set(bed.roomId, []);
        rooms.get(bed.roomId).push(bed.id);
      }
      for (const [roomId, bedIds] of rooms) {
        if (bedIds.length < 2) continue;
        for (let n = 0; n < NIGHTS.length; n++) {
          const byGender = { M: [], F: [] };
          for (const v of vars) {
            const party = parties[v.partyIndex];
            if (party.members.length !== 1 || !party.nights.includes(n)) continue;
            if (!v.option.beds.some((b) => bedIds.includes(b))) continue;
            const g = personById.get(party.members[0]).gender;
            if (byGender[g]) byGender[g].push(v.name);
          }
          if (byGender.M.length === 0 || byGender.F.length === 0) continue;
          const k = extraVars.length;
          const gM = `gM${k}`;
          const gF = `gF${k}`;
          const z = `z${k}`;
          extraVars.push(gM, gF, z);
          for (const name of byGender.M) rows.push(`gm_${rows.length}: ${name} - ${gM} <= 0`);
          for (const name of byGender.F) rows.push(`gf_${rows.length}: ${name} - ${gF} <= 0`);
          rows.push(`mix_${rows.length}: ${gM} + ${gF} - ${z} <= 1`);
          objTerms.push(term(-settings.genderPenalty, z));
        }
      }
    }

    const lp = [
      'Maximize',
      `obj:\n${lines(objTerms)}`,
      'Subject To',
      ...rows,
      'Binary',
      lines([...vars.map((v) => v.name), ...extraVars]),
      'End',
    ].join('\n');

    const sol = highs.solve(lp);
    if (sol.Status !== 'Optimal') {
      return { status: sol.Status, parties, choices: [], ...emptyResult() };
    }
    const choices = parties.map((_, pi) => {
      const chosen = vars.find((v) => v.partyIndex === pi && sol.Columns[v.name].Primal > 0.5);
      return chosen.option;
    });
    let mixedRoomNights = 0;
    for (const name of extraVars) if (name[0] === 'z' && sol.Columns[name].Primal > 0.5) mixedRoomNights++;
    return {
      status: sol.Status,
      objective: sol.ObjectiveValue,
      weights,
      mixedRoomNights,
      ...finishResult(parties, choices, beds),
    };
  }

  function emptyResult() {
    return { assignment: {}, plan: NIGHTS.map(() => ({})), freeBeds: NIGHTS.map(() => []) };
  }

  /*
   * Make the bed plan from the chosen options.
   * plan[n] maps a bed id to the person ids in that bed on night n.
   * A couple holds its bed on every night of the party, but a member only sleeps there on their own nights.
   */
  function finishResult(parties, choices, beds) {
    const assignment = {};
    const plan = NIGHTS.map(() => ({}));
    parties.forEach((party, pi) => {
      const option = choices[pi];
      for (const m of party.members) assignment[m] = option.assign[m];
      for (const n of party.nights) {
        for (const bedId of option.beds) {
          const sleepers = party.members.filter(
            (m) => option.assign[m] === bedId && party.memberNights[m].includes(n),
          );
          plan[n][bedId] = { partyId: party.id, sleepers };
        }
      }
    });
    const freeBeds = NIGHTS.map((_, n) => beds.filter((b) => !plan[n][b.id]).map((b) => b.id));
    return { parties, choices, assignment, plan, freeBeds };
  }

  /*
   * Update the balances after one weekend.
   * On each night, a person gets the value of their bed minus the average value of all person-nights.
   * An overflow night has a value of 0. The changes on each night add up to zero.
   */
  function updateBalances(balances, result, rooms) {
    const bedById = new Map(flattenBeds(rooms).map((b) => [b.id, b]));
    const next = { ...balances };
    const nightly = [];
    for (let n = 0; n < NIGHTS.length; n++) {
      const rows = [];
      for (const party of result.parties) {
        for (const m of party.members) {
          if (!party.memberNights[m].includes(n)) continue;
          const bedId = result.assignment[m];
          rows.push({ personId: m, value: bedId === OVERFLOW ? 0 : bedById.get(bedId).value });
        }
      }
      if (rows.length === 0) {
        nightly.push({ average: null, rows });
        continue;
      }
      const average = rows.reduce((s, r) => s + r.value, 0) / rows.length;
      for (const r of rows) next[r.personId] = (next[r.personId] || 0) + r.value - average;
      nightly.push({ average, rows });
    }
    return { balances: next, nightly };
  }

  return {
    NIGHTS,
    OVERFLOW,
    DEFAULT_SETTINGS,
    flattenBeds,
    buildParties,
    buildOptions,
    priorityWeights,
    solveWeekend,
    finishResult,
    updateBalances,
  };
});
