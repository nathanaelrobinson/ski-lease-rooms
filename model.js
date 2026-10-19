/*
 * Room allocation model for one weekend, with guests and an optional planning window.
 * The file works in the browser (global SkiModel) and in Node (module.exports).
 * All functions are pure. The caller gives the HiGHS instance and the random generator.
 *
 * The solver runs in stages:
 *   S0  Members only. A host with a partner guest counts as alone. This gives the member floor nights.
 *   S1  Members and partner guests. Member floor nights and no-bed nights must not go up.
 *   S2  Planning window (optional). Play the known future weekends forward to get projected priority.
 *       The change of each member is scaled by the confidence of their calendar entry.
 *       Solve this weekend again with it. This weekend must stay as good as S1 on the hard measures.
 *   S3  Roommate and any-bed guests fill the beds that are left. Members do not move.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkiModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NIGHTS = ['Thu', 'Fri', 'Sat'];
  const OVERFLOW = null;
  const OVERFLOW_PENALTY = 10000;
  const CAP_PENALTY = 300;
  /*
   * A couple in a real queen gets COUPLE_QUEEN_BONUS points one time, for any number of nights.
   * The bonus is larger than any weighted bed value, so the solver puts as many couples as possible in queens.
   * A host with a partner guest gets the same bonus only if the request was booked ADVANCE_WEEKS ahead.
   */
  const COUPLE_QUEEN_BONUS = 5000;
  /*
   * A host with a partner guest who did not book ahead gets PAIR_QUEEN_BONUS. It is smaller than the couple bonus
   * and larger than any weighted bed value. Queens go to member couples first, then to pairs, then to singles.
   */
  const PAIR_QUEEN_BONUS = 2500;
  const ADVANCE_WEEKS = 3;
  /* Each floor night costs FLOOR_PENALTY points, independent of the weight. */
  const FLOOR_PENALTY = 4;
  /* A host with a partner guest who sleeps alone costs ALONE_PENALTY points for each night. */
  const ALONE_PENALTY = 200;
  /* A guest with no bed costs GUEST_NOBED_PENALTY points for each night. A roommate in the host room gets ROOMMATE_BONUS. */
  const GUEST_NOBED_PENALTY = 100;
  const ROOMMATE_BONUS = 20;
  /* A couple can share a bed of these types. QUEEN_TYPES get the couple queen bonus. */
  const SHARED_TYPES = new Set(['queen', 'king', 'full', 'air_queen']);
  const QUEEN_TYPES = new Set(['queen', 'king']);
  /* A night in a bed of these types, or in no bed, counts toward the couch cap. */
  const FLOOR_TYPES = new Set(['couch', 'air_twin', 'air_queen']);
  const BASE_WEIGHT = 0.1;
  const BALANCE_SCALE = 6;
  const MAX_WEIGHT = 50;
  const GUEST_TYPES = ['partner', 'roommate', 'any'];

  const DEFAULT_SETTINGS = {
    strength: 2,
    noise: 1.5,
    genderPenalty: 3,
    couchCap: null,
    planning: true,
    leadWeeks: 4,
  };

  /* Make one flat list of beds. Each bed keeps the data of its room. */
  function flattenBeds(rooms) {
    const beds = [];
    for (const room of rooms) {
      for (const bed of room.beds) {
        beds.push({ id: bed.id, type: bed.type, value: Number(bed.value), roomId: room.id, roomName: room.name, common: !!room.common });
      }
    }
    return beds;
  }

  /* Guest k of a host has the id g:host (k = 1) or g:host#k. */
  function guestId(hostId, k = 1) {
    return k === 1 ? `g:${hostId}` : `g:${hostId}#${k}`;
  }

  function isGuest(id) {
    return typeof id === 'string' && id.startsWith('g:');
  }

  function hostOf(id) {
    return id.slice(2).split('#')[0];
  }

  /* Add one person record for each guest, so that names and genders resolve. Guests have gender X. */
  function withGuests(people, guests) {
    const out = [...people];
    for (const [hostId, g] of Object.entries(guests || {})) {
      const host = people.find((p) => p.id === hostId);
      if (!host) continue;
      for (let k = 1; k <= (g.count || 1); k++) out.push({ id: guestId(hostId, k), name: `${host.name}+`, gender: 'X', guestOf: hostId, guestType: g.type });
    }
    return out;
  }

  /*
   * Make the parties from the registrations and the guests.
   * kind = 'couple'      two members who both registered (nights = union)
   *        'single'      one member
   *        'hostPartner' one member and a partner guest who shares the bed
   *        'guest'       a roommate or any-bed guest (placed in S3)
   * A partner guest of a member whose partner also came becomes an any-bed guest.
   */
  function buildParties(people, registrations, guests = {}) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const used = new Set();
    const members = [];
    const guestParties = [];
    for (const person of people) {
      const nights = registrations[person.id];
      if (!nights || nights.length === 0 || used.has(person.id)) continue;
      used.add(person.id);
      const partner = person.partnerId ? byId.get(person.partnerId) : null;
      const partnerNights = partner ? registrations[partner.id] : null;
      const sorted = [...nights].sort();
      if (partner && partnerNights && partnerNights.length > 0 && !used.has(partner.id)) {
        used.add(partner.id);
        members.push({
          id: `c_${person.id}_${partner.id}`,
          kind: 'couple',
          members: [person.id, partner.id],
          nights: [...new Set([...nights, ...partnerNights])].sort(),
          memberNights: { [person.id]: sorted, [partner.id]: [...partnerNights].sort() },
        });
        continue;
      }
      const g = guests[person.id];
      if (g && g.type === 'partner') {
        const gid = guestId(person.id);
        members.push({
          id: `h_${person.id}`,
          kind: 'hostPartner',
          members: [person.id, gid],
          host: person.id,
          advance: !!g.advance,
          nights: sorted,
          memberNights: { [person.id]: sorted, [gid]: sorted },
        });
      } else {
        members.push({ id: `s_${person.id}`, kind: 'single', members: [person.id], nights: sorted, memberNights: { [person.id]: sorted } });
      }
    }
    /* Guests who do not share the host bed. A partner guest who shares is guest 1, so the others start at 2. */
    for (const [hostId, g] of Object.entries(guests)) {
      const nights = registrations[hostId];
      if (!nights || nights.length === 0) continue;
      const hostParty = members.find((p) => p.members.includes(hostId));
      if (!hostParty) continue;
      const first = g.type === 'partner' && hostParty.kind === 'hostPartner' ? 2 : 1;
      const sorted = [...nights].sort();
      for (let k = first; k <= (g.count || 1); k++) {
        const gid = guestId(hostId, k);
        guestParties.push({
          id: `g_${hostId}_${k}`,
          kind: 'guest',
          guestType: g.type === 'partner' || k > 1 ? 'any' : g.type,
          advance: !!g.advance,
          members: [gid],
          host: hostId,
          nights: sorted,
          memberNights: { [gid]: sorted },
        });
      }
    }
    return { members, guests: guestParties };
  }

  /*
   * List the placement options of a party.
   * single, guest: any bed.  couple, hostPartner: a shared bed or two twins in one room.
   * hostPartner also has "alone" options: the host takes a bed and the partner guest goes to S3.
   * Every party has an overflow option that uses no bed.
   */
  function buildOptions(party, beds) {
    const options = [];
    if (party.members.length === 1) {
      const [m] = party.members;
      for (const bed of beds) options.push({ beds: [bed.id], assign: { [m]: bed.id } });
    } else {
      const [a, b] = party.members;
      for (const bed of beds) {
        if (SHARED_TYPES.has(bed.type)) options.push({ beds: [bed.id], assign: { [a]: bed.id, [b]: bed.id }, queen: QUEEN_TYPES.has(bed.type), shared: true });
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
      if (party.kind === 'hostPartner') {
        for (const bed of beds) options.push({ beds: [bed.id], assign: { [a]: bed.id, [b]: OVERFLOW }, alone: true });
      }
    }
    const assign = {};
    for (const m of party.members) assign[m] = OVERFLOW;
    options.push({ beds: [], assign, overflow: true });
    return options;
  }

  /*
   * Calculate the priority weight of each member who attends.
   * The weight is exp(-strength * balance / BALANCE_SCALE), limited to the range from 1/MAX_WEIGHT to MAX_WEIGHT.
   */
  function priorityWeights(personIds, balances, strength) {
    const weights = {};
    for (const id of personIds) {
      const w = Math.exp((-strength * (balances[id] || 0)) / BALANCE_SCALE);
      weights[id] = Math.min(MAX_WEIGHT, Math.max(1 / MAX_WEIGHT, w));
    }
    return weights;
  }

  /* Return true if a bed id is a floor bed or no bed. */
  function isFloor(bedId, bedById) {
    return bedId === OVERFLOW || FLOOR_TYPES.has(bedById.get(bedId).type);
  }

  /* Count the floor nights of an option that go above the couch cap. A cap of null turns the cap off. */
  function capExcess(party, option, floorNights, cap, bedById) {
    if (cap === null || cap === undefined || cap === '') return 0;
    let excess = 0;
    for (const m of party.members) {
      if (isGuest(m) || !isFloor(option.assign[m], bedById)) continue;
      const used = floorNights[m] || 0;
      const added = party.memberNights[m].length;
      excess += Math.max(0, used + added - cap) - Math.max(0, used - cap);
    }
    return excess;
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

  function linear(coefs) {
    const t = [];
    for (const [name, c] of coefs) if (Math.abs(c) > 1e-9) t.push(term(c, name));
    return t.length ? lines(t) : ' 0 y_dummy';
  }

  /*
   * Hard measures of one option for the members, used for the stage limits.
   * floor = member floor nights, nobed = member no-bed nights, queen = couple bonus counts,
   * together = a partner guest shares with the host.
   */
  function optionMeasures(party, option, bedById) {
    let floor = 0;
    let nobed = 0;
    for (const m of party.members) {
      if (isGuest(m)) continue;
      const n = party.memberNights[m].length;
      if (option.assign[m] === OVERFLOW) nobed += n;
      if (isFloor(option.assign[m], bedById)) floor += n;
    }
    const bonus = option.queen && (party.kind === 'couple' || (party.kind === 'hostPartner' && party.advance)) ? 1 : 0;
    const together = party.kind === 'hostPartner' && !option.alone && !option.overflow ? 1 : 0;
    return { floor, nobed, bonus, together };
  }

  /*
   * Build the variables and rows for one weekend.
   * ctx.mode = 'weighted' uses the priority weights. ctx.mode = 'flat' leaves fairness to the planning rows.
   * ctx.blocked(bedId, n) is true for a bed that is already in use on night n.
   */
  function weekBlock(tag, parties, beds, ctx) {
    const { bedById, personById, settings, rng, weights, floorNights, mode } = ctx;
    const vars = [];
    parties.forEach((party, pi) => {
      for (const option of buildOptions(party, beds)) {
        if (ctx.forceAlone && party.kind === 'hostPartner' && !option.alone && !option.overflow) continue;
        if (ctx.blocked && party.nights.some((n) => option.beds.some((b) => ctx.blocked(b, n)))) continue;
        const jitter = rng() * settings.noise;
        let score = 0;
        if (party.kind === 'guest') {
          const bedId = option.assign[party.members[0]];
          const n = party.nights.length;
          const hostWeight = (weights && weights[party.host]) || 1;
          if (bedId === OVERFLOW) score -= GUEST_NOBED_PENALTY * n * (party.advance ? 2 : 1) * (1 + hostWeight / MAX_WEIGHT);
          else {
            const bed = bedById.get(bedId);
            score += (hostWeight * (bed.value + 0.1 * jitter) * 0.1 + BASE_WEIGHT * bed.value) * n;
            if (party.guestType === 'roommate' && ctx.hostRoom && ctx.hostRoom[party.host] === bed.roomId) score += ROOMMATE_BONUS * n;
          }
        } else {
          for (const m of party.members) {
            if (isGuest(m)) continue;
            const n = party.memberNights[m].length;
            const bedId = option.assign[m];
            const value = bedId === OVERFLOW ? 0 : bedById.get(bedId).value;
            const w = mode === 'weighted' ? weights[m] : 0;
            const j = mode === 'weighted' ? jitter : 0.2 * jitter;
            score += (w * (value + j) + BASE_WEIGHT * value) * n;
            if (isFloor(bedId, bedById)) score -= FLOOR_PENALTY * n;
          }
          const meas = optionMeasures(party, option, bedById);
          if (meas.bonus) score += COUPLE_QUEEN_BONUS;
          else if (option.queen && party.kind === 'hostPartner') score += PAIR_QUEEN_BONUS;
          if (option.alone) score -= ALONE_PENALTY * party.nights.length;
          score -= CAP_PENALTY * capExcess(party, option, floorNights || {}, settings.couchCap, bedById);
          score -= OVERFLOW_PENALTY * meas.nobed;
        }
        vars.push({ name: `${tag}y${vars.length}`, partyIndex: pi, option, score });
      }
    });

    const rows = [];
    const mixVars = [];
    const bins = vars.map((v) => v.name);
    const obj = vars.map((v) => [v.name, v.score]);

    /* Each party takes exactly one option. */
    parties.forEach((party, pi) => {
      const t = vars.filter((v) => v.partyIndex === pi).map((v) => term(1, v.name));
      rows.push(`${tag}p${pi}:\n${lines(t)} = 1`);
    });

    /* On each night, each bed holds at most one party. */
    for (const bed of beds) {
      for (let n = 0; n < NIGHTS.length; n++) {
        const t = vars.filter((v) => v.option.beds.includes(bed.id) && parties[v.partyIndex].nights.includes(n)).map((v) => term(1, v.name));
        if (t.length > 1) rows.push(`${tag}b${rows.length}:\n${lines(t)} <= 1`);
      }
    }

    /* Penalty for a bedroom on a night with member singles of two genders. */
    if (settings.genderPenalty > 0) {
      const roomBeds = new Map();
      for (const bed of beds) {
        if (bed.common) continue;
        if (!roomBeds.has(bed.roomId)) roomBeds.set(bed.roomId, []);
        roomBeds.get(bed.roomId).push(bed.id);
      }
      for (const [, bedIds] of roomBeds) {
        if (bedIds.length < 2) continue;
        for (let n = 0; n < NIGHTS.length; n++) {
          const byGender = { M: [], F: [] };
          for (const v of vars) {
            const party = parties[v.partyIndex];
            const alone = party.kind === 'single' || (party.kind === 'hostPartner' && v.option.alone);
            if (!alone || !party.nights.includes(n)) continue;
            if (!v.option.beds.some((b) => bedIds.includes(b))) continue;
            const g = personById.get(party.members[0]).gender;
            if (byGender[g]) byGender[g].push(v.name);
          }
          if (byGender.M.length === 0 || byGender.F.length === 0) continue;
          const k = mixVars.length;
          const gM = `${tag}gM${k}`;
          const gF = `${tag}gF${k}`;
          const z = `${tag}z${k}`;
          bins.push(gM, gF, z);
          mixVars.push(z);
          for (const name of byGender.M) rows.push(`${tag}gm${rows.length}: ${name} - ${gM} <= 0`);
          for (const name of byGender.F) rows.push(`${tag}gf${rows.length}: ${name} - ${gF} <= 0`);
          rows.push(`${tag}mx${rows.length}: ${gM} + ${gF} - ${z} <= 1`);
          obj.push([z, -settings.genderPenalty]);
        }
      }
    }
    return { tag, parties, vars, rows, bins, obj, mixVars };
  }

  /* Rows that keep the hard measures of a block within the limits of an earlier stage. */
  function limitRows(block, limits, bedById) {
    const rows = [];
    const sum = (key) => block.vars.map((v) => [v.name, optionMeasures(block.parties[v.partyIndex], v.option, bedById)[key]]);
    if (limits.floor !== undefined) rows.push(`${block.tag}Lfloor:\n${linear(sum('floor'))} <= ${limits.floor}`);
    if (limits.nobed !== undefined) rows.push(`${block.tag}Lnobed:\n${linear(sum('nobed'))} <= ${limits.nobed}`);
    if (limits.bonus !== undefined && limits.bonus > 0) rows.push(`${block.tag}Lbonus:\n${linear(sum('bonus'))} >= ${limits.bonus}`);
    if (limits.together !== undefined && limits.together > 0) rows.push(`${block.tag}Ltog:\n${linear(sum('together'))} >= ${limits.together}`);
    if (limits.mixed !== undefined && block.mixVars.length) rows.push(`${block.tag}Lmix:\n${linear(block.mixVars.map((z) => [z, 1]))} <= ${limits.mixed}`);
    return rows;
  }

  function solveLP(highs, objPairs, rows, bins) {
    const lp = ['Maximize', `obj:\n${linear(objPairs)}`, 'Subject To', ...rows, 'Binary', lines(bins), 'End'].join('\n');
    return highs.solve(lp, { mip_rel_gap: 1e-6, time_limit: 20 });
  }

  /* Read the chosen option of each party and the hard measures of a solved block. */
  function readBlock(block, sol, bedById) {
    const choices = block.parties.map((_, pi) => block.vars.find((v) => v.partyIndex === pi && sol.Columns[v.name].Primal > 0.5).option);
    const limits = { floor: 0, nobed: 0, bonus: 0, together: 0, mixed: 0 };
    block.parties.forEach((party, pi) => {
      const m = optionMeasures(party, choices[pi], bedById);
      for (const k of ['floor', 'nobed', 'bonus', 'together']) limits[k] += m[k];
    });
    for (const z of block.mixVars) if (sol.Columns[z].Primal > 0.5) limits.mixed++;
    return { choices, limits };
  }

  function isOk(sol) {
    return sol.Status === 'Optimal' || (sol.Status === 'Time limit reached' && sol.Columns && Object.keys(sol.Columns).length > 0);
  }

  /*
   * Solve one weekend.
   * input: { rooms, people, registrations, guests, balances, floorNights, settings, rng,
   *          future: [{ registrations, guests }] }  (future is used only if settings.planning is true)
   * The function returns the same result shape as the first-come baseline.
   */
  function solveWeekend(highs, input) {
    const settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) };
    const rng = input.rng || Math.random;
    const balances = input.balances || {};
    const guests = input.guests || {};
    const beds = flattenBeds(input.rooms);
    const bedById = new Map(beds.map((b) => [b.id, b]));
    const people = withGuests(input.people, guests);
    const personById = new Map(people.map((p) => [p.id, p]));
    const { members, guests: guestParties } = buildParties(input.people, input.registrations, guests);
    const attendees = members.flatMap((p) => p.members.filter((m) => !isGuest(m)));
    const weights = priorityWeights(attendees, balances, settings.strength);
    const ctx = { bedById, personById, settings, rng, weights, floorNights: input.floorNights || {}, mode: 'weighted' };
    const stages = [];

    /* S0: hosts alone. This gives the member floor and no-bed nights without partner guests. */
    let base = {};
    if (members.some((p) => p.kind === 'hostPartner')) {
      const b0 = weekBlock('a', members, beds, { ...ctx, forceAlone: true });
      const s0 = solveLP(highs, b0.obj, b0.rows, b0.bins);
      if (isOk(s0)) {
        const r0 = readBlock(b0, s0, bedById);
        base = { floor: r0.limits.floor, nobed: r0.limits.nobed };
      }
      stages.push('S0');
    }

    /* S1: members and partner guests, with the member limits from S0. */
    const b1 = weekBlock('w', members, beds, ctx);
    const s1 = solveLP(highs, b1.obj, [...b1.rows, ...limitRows(b1, base, bedById)], b1.bins);
    if (!isOk(s1)) return { status: s1.Status, parties: members, choices: [], weights, ...emptyResult() };
    let { choices, limits } = readBlock(b1, s1, bedById);
    let objective = s1.ObjectiveValue;
    stages.push('S1');

    /*
     * S2: planning window (rollout). Play the known future weekends forward with the one-weekend model.
     * The result is the projected balance of each member. A member with good beds ahead looks paid now.
     * This weekend is then solved again with the projected weights and must keep the S1 hard measures.
     */
    let projected = null;
    if (settings.planning && input.future && input.future.length) {
      projected = { ...balances };
      let floor = { ...(input.floorNights || {}) };
      for (const wk of input.future) {
        if (!Object.keys(wk.registrations).length) continue;
        const r = solveWeekend(highs, { ...input, registrations: wk.registrations, guests: wk.guests || {}, balances: projected, floorNights: floor, future: [], settings: { ...settings, planning: false } });
        if (r.status !== 'Optimal') continue;
        /* Scale the change of each member by the confidence of their calendar entry. */
        const after = updateBalances(projected, r, input.rooms).balances;
        const next = { ...projected };
        for (const [m, v] of Object.entries(after)) {
          const c = wk.confidence && wk.confidence[m] !== undefined ? wk.confidence[m] : 1;
          next[m] = (projected[m] || 0) + c * (v - (projected[m] || 0));
        }
        projected = next;
      }
      const planWeights = priorityWeights(attendees, projected, settings.strength);
      const b2 = weekBlock('w', members, beds, { ...ctx, weights: planWeights });
      const s2 = solveLP(highs, b2.obj, [...b2.rows, ...limitRows(b2, limits, bedById)], b2.bins);
      if (isOk(s2)) {
        choices = readBlock(b2, s2, bedById).choices;
        objective = s2.ObjectiveValue;
        stages.push(`S2(${input.future.length} wk)`);
      }
    }

    /* A host with a partner guest who sleeps alone becomes a single. The partner guest moves to S3. */
    const parties = [];
    const finalChoices = [];
    const s3Guests = [...guestParties];
    members.forEach((party, pi) => {
      const option = choices[pi];
      if (party.kind === 'hostPartner' && (option.alone || option.overflow)) {
        const host = party.host;
        parties.push({ id: `s_${host}`, kind: 'single', members: [host], nights: party.nights, memberNights: { [host]: party.nights }, hadPartnerGuest: true });
        finalChoices.push({ beds: option.beds, assign: { [host]: option.assign[host] }, overflow: option.overflow });
        const gid = guestId(host);
        s3Guests.push({ id: `g_${host}`, kind: 'guest', guestType: 'any', detachedPartner: true, advance: party.advance, members: [gid], host, nights: party.nights, memberNights: { [gid]: party.nights } });
      } else {
        parties.push(party);
        finalChoices.push(option);
      }
    });

    /* S3: roommate and any-bed guests fill the free beds. Members do not move. */
    if (s3Guests.length) {
      const used = NIGHTS.map(() => new Set());
      parties.forEach((party, pi) => {
        for (const n of party.nights) for (const b of finalChoices[pi].beds) used[n].add(b);
      });
      const hostRoom = {};
      parties.forEach((party, pi) => {
        for (const m of party.members) {
          const bedId = finalChoices[pi].assign[m];
          if (!isGuest(m) && bedId !== OVERFLOW && bedId !== undefined) hostRoom[m] = bedById.get(bedId).roomId;
        }
      });
      const b3 = weekBlock('g', s3Guests, beds, { ...ctx, blocked: (b, n) => used[n].has(b), hostRoom, settings: { ...settings, genderPenalty: 0 } });
      const s3 = solveLP(highs, b3.obj, b3.rows, b3.bins);
      if (isOk(s3)) {
        const r3 = readBlock(b3, s3, bedById);
        s3Guests.forEach((g, i) => {
          parties.push(g);
          finalChoices.push(r3.choices[i]);
        });
      }
      stages.push('S3');
    }

    return { status: 'Optimal', objective, weights, projected, stages, ...finishResult(parties, finalChoices, beds) };
  }

  function emptyResult() {
    return { assignment: {}, plan: NIGHTS.map(() => ({})), freeBeds: NIGHTS.map(() => []) };
  }

  /*
   * Make the bed plan from the chosen options.
   * plan[n] maps a bed id to { partyId, sleepers } on night n.
   * A couple holds its bed on every night of the party, but a member only sleeps there on their own nights.
   */
  function finishResult(parties, choices, beds) {
    const assignment = {};
    const plan = NIGHTS.map(() => ({}));
    parties.forEach((party, pi) => {
      const option = choices[pi];
      for (const m of party.members) assignment[m] = option.assign[m] === undefined ? OVERFLOW : option.assign[m];
      for (const n of party.nights) {
        for (const bedId of option.beds) {
          const sleepers = party.members.filter((m) => option.assign[m] === bedId && party.memberNights[m].includes(n));
          /* Actual data can put two stays in one bed on one night. Keep the first party and add the sleepers. */
          if (plan[n][bedId]) plan[n][bedId].sleepers.push(...sleepers);
          else plan[n][bedId] = { partyId: party.id, sleepers };
        }
      }
    });
    const freeBeds = NIGHTS.map((_, n) => beds.filter((b) => !plan[n][b.id]).map((b) => b.id));
    return { parties, choices, assignment, plan, freeBeds };
  }

  /*
   * Update the balances after one weekend.
   * Pools: members of a couple, and singles (a host with a partner guest is a single).
   * On each night, a member gets the value of their bed minus the average value of their pool.
   * A guest who does not share the host bed costs the host the amount by which the guest bed beats
   * the single average of that night. A guest on a couch below the average costs nothing.
   */
  function updateBalances(balances, result, rooms) {
    const bedById = new Map(flattenBeds(rooms).map((b) => [b.id, b]));
    const next = { ...balances };
    const nightly = [];
    const valueOf = (bedId) => (bedId === OVERFLOW || bedId === undefined ? 0 : bedById.get(bedId).value);
    for (let n = 0; n < NIGHTS.length; n++) {
      const rows = [];
      for (const party of result.parties) {
        if (party.kind === 'guest') continue;
        const pool = party.kind === 'couple' ? 'couple' : 'single';
        const option = result.choices[result.parties.indexOf(party)];
        for (const m of party.members) {
          if (isGuest(m) || !party.memberNights[m].includes(n)) continue;
          rows.push({ personId: m, pool, value: valueOf(option.assign[m]) });
        }
      }
      const averages = {};
      for (const pool of ['couple', 'single']) {
        const list = rows.filter((r) => r.pool === pool);
        if (list.length) averages[pool] = list.reduce((s, r) => s + r.value, 0) / list.length;
      }
      for (const r of rows) next[r.personId] = (next[r.personId] || 0) + r.value - averages[r.pool];
      nightly.push({ averages, rows });
    }
    /* Guest charges. */
    result.parties.forEach((party, pi) => {
      const option = result.choices[pi];
      for (const m of party.members) {
        if (!isGuest(m)) continue;
        const host = hostOf(m);
        const bedId = option.assign[m];
        if (bedId === OVERFLOW || bedId === undefined || bedId === option.assign[host]) continue;
        for (const n of party.memberNights[m]) {
          const mean = nightly[n].averages.single === undefined ? 0 : nightly[n].averages.single;
          next[host] = (next[host] || 0) + Math.max(0, valueOf(bedId) - mean);
        }
      }
    });
    return { balances: next, nightly };
  }

  return {
    NIGHTS,
    OVERFLOW,
    SHARED_TYPES,
    QUEEN_TYPES,
    FLOOR_TYPES,
    hostOf,
    GUEST_TYPES,
    ADVANCE_WEEKS,
    isFloor,
    isGuest,
    guestId,
    withGuests,
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
