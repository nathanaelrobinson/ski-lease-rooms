/*
 * Assignment quality measures for one weekend.
 * The file works in the browser (global SkiOutcomes) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else root.SkiOutcomes = factory(root.SkiModel);
})(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  /* A pair of singles is an inversion only if the balance gap is more than this number of points. */
  const INVERSION_GAP = 1;

  const COUNT_KEYS = [
    'bedroomNights',
    'bedroomOccupied',
    'singleQueen',
    'wastedQueen',
    'heldEmptyQueen',
    'floorNights',
    'dominatedFloor',
    'priorityInversion',
    'mixedRoom',
    'coupleSplit',
    'capExcess',
  ];

  function zeroCounts() {
    const c = {};
    for (const k of COUNT_KEYS) c[k] = 0;
    return c;
  }

  /*
   * Measure one weekend.
   * input: { result, rooms, people, balances, floorNights, couchCap }.
   * balances and floorNights are the values before this weekend.
   * The function returns the counts, the occupancy of each room on each night, and a list of incidents.
   */
  function assessWeekend(input) {
    const { result, rooms, people } = input;
    const balances = input.balances || {};
    const floorBefore = input.floorNights || {};
    const cap = input.couchCap;
    const beds = Model.flattenBeds(rooms);
    const bedById = new Map(beds.map((b) => [b.id, b]));
    const personById = new Map(people.map((p) => [p.id, p]));
    const counts = zeroCounts();
    const incidents = [];
    const add = (type, night, ids, detail) => incidents.push({ type, night, people: ids, detail });
    /* Return true if a single of another gender sleeps in the room of the bed on night n. */
    const otherGenderInRoom = (bed, n, gender) => {
      if (!gender || bed.common || (gender !== 'M' && gender !== 'F')) return false;
      for (const other of beds) {
        if (other.roomId !== bed.roomId) continue;
        const cell = result.plan[n][other.id];
        if (!cell) continue;
        const party = result.parties.find((p) => p.id === cell.partyId);
        if (party.members.length !== 1) continue;
        const g = personById.get(party.members[0]).gender;
        if ((g === 'M' || g === 'F') && g !== gender) return true;
      }
      return false;
    };
    const valueOf = (bedId) => (bedId === Model.OVERFLOW ? 0 : bedById.get(bedId).value);

    /*
     * Utilization counts sleeping spaces, not beds. A queen or an air queen has 2 spaces. Other beds have 1.
     * A single in a queen uses 1 of 2 spaces. A held bed with no sleeper uses 0 spaces.
     */
    const spaces = (bed) => (Model.SHARED_TYPES.has(bed.type) ? 2 : 1);
    const sleepers = (bedId, n) => (result.plan[n][bedId] || { sleepers: [] }).sleepers.length;
    const roomNights = {};
    for (const room of rooms) {
      roomNights[room.id] = Model.NIGHTS.map((_, n) => ({
        occupied: room.beds.reduce((s, b) => s + sleepers(b.id, n), 0),
        total: room.beds.reduce((s, b) => s + spaces(b), 0),
      }));
    }

    /* Bedroom utilization counts only real beds in rooms that are not shared living space. */
    const bedroomBeds = beds.filter((b) => !b.common && !Model.FLOOR_TYPES.has(b.type));
    for (let n = 0; n < Model.NIGHTS.length; n++) {
      for (const bed of bedroomBeds) {
        counts.bedroomNights += spaces(bed);
        counts.bedroomOccupied += sleepers(bed.id, n);
      }
    }

    /* People on a floor bed or no bed, for each night. */
    const floorOnNight = Model.NIGHTS.map((_, n) =>
      result.parties.flatMap((p) => p.members.filter((m) => p.memberNights[m].includes(n) && Model.isFloor(result.assignment[m], bedById))),
    );

    /*
     * Queen measures. A wasted queen is a single in a queen on a night when a couple uses two beds
     * and a person is on the floor. On that night, the queen cost a bed.
     */
    for (let n = 0; n < Model.NIGHTS.length; n++) {
      const couplesInTwoBeds = result.parties.filter(
        (p, pi) => p.members.length === 2 && p.nights.includes(n) && result.choices[pi].beds.length === 2,
      );
      for (const bed of beds) {
        if (bed.type !== 'queen') continue;
        const cell = result.plan[n][bed.id];
        if (!cell) continue;
        if (cell.sleepers.length === 0) {
          counts.heldEmptyQueen++;
          add('heldEmptyQueen', n, [], bed.id);
        } else if (cell.sleepers.length === 1) {
          const party = result.parties.find((p) => p.id === cell.partyId);
          if (party.members.length === 1) {
            counts.singleQueen++;
            if (couplesInTwoBeds.length > 0 && floorOnNight[n].length > 0) {
              counts.wastedQueen++;
              add('wastedQueen', n, [...cell.sleepers, ...couplesInTwoBeds[0].members], bed.id);
            }
          }
        }
      }
    }

    /* Floor nights, dominated floor nights, and nights above the couch cap. */
    result.parties.forEach((party, pi) => {
      const option = result.choices[pi];
      const onFloor = party.members.filter((m) => Model.isFloor(option.assign[m], bedById));
      if (onFloor.length === 0) return;
      for (const m of onFloor) {
        const nights = party.memberNights[m].length;
        counts.floorNights += nights;
        if (cap !== null && cap !== undefined && cap !== '') {
          const used = floorBefore[m] || 0;
          const excess = Math.max(0, used + nights - cap) - Math.max(0, used - cap);
          if (excess > 0) {
            counts.capExcess += excess;
            add('capExcess', null, [m], `${used + nights} > ${cap}`);
          }
        }
      }
      /*
       * A floor night is dominated if a better option was free on all the nights of the party.
       * For a single, the free bed must not make a room with two genders.
       */
      const better = Model.buildOptions(party, beds).filter(
        (o) => !o.overflow && o.beds.every((b) => !Model.FLOOR_TYPES.has(bedById.get(b).type)),
      );
      const gender = party.members.length === 1 ? personById.get(party.members[0]).gender : null;
      const free = better.find((o) =>
        party.nights.every((n) => o.beds.every((b) => !result.plan[n][b] && !otherGenderInRoom(bedById.get(b), n, gender))),
      );
      if (free) {
        const nights = onFloor.reduce((s, m) => s + party.memberNights[m].length, 0);
        counts.dominatedFloor += nights;
        add('dominatedFloor', null, onFloor, free.beds.join('+'));
      }
    });

    /*
     * Priority inversion: two singles of the same gender with the same nights.
     * The person with the higher balance has the better bed, so a swap was possible and fairer.
     */
    const singles = result.parties.filter((p) => p.members.length === 1);
    for (let i = 0; i < singles.length; i++) {
      for (let j = 0; j < singles.length; j++) {
        if (i === j) continue;
        const a = singles[i].members[0];
        const b = singles[j].members[0];
        if (personById.get(a).gender !== personById.get(b).gender) continue;
        if (singles[i].nights.join() !== singles[j].nights.join()) continue;
        const gap = (balances[a] || 0) - (balances[b] || 0);
        if (gap > INVERSION_GAP && valueOf(result.assignment[a]) > valueOf(result.assignment[b])) {
          counts.priorityInversion++;
          add('priorityInversion', null, [a, b], `luck gap ${gap.toFixed(1)}`);
        }
      }
    }

    /* Room-nights with singles of two genders. */
    for (const room of rooms) {
      if (room.common || room.beds.length < 2) continue;
      for (let n = 0; n < Model.NIGHTS.length; n++) {
        const genders = new Set();
        const ids = [];
        for (const bed of room.beds) {
          const cell = result.plan[n][bed.id];
          if (!cell) continue;
          const party = result.parties.find((p) => p.id === cell.partyId);
          if (party.members.length !== 1) continue;
          for (const m of cell.sleepers) {
            genders.add(personById.get(m).gender);
            ids.push(m);
          }
        }
        if (genders.has('M') && genders.has('F')) {
          counts.mixedRoom++;
          add('mixedRoom', n, ids, room.id);
        }
      }
    }

    result.parties.forEach((party, pi) => {
      if (result.choices[pi].split) {
        counts.coupleSplit++;
        add('coupleSplit', null, party.members, result.choices[pi].beds.join('+'));
      }
    });

    return { counts, roomNights, incidents };
  }

  /* Add the counts and the room occupancy of many weekends. */
  function sumOutcomes(list, rooms) {
    const counts = zeroCounts();
    const roomNights = {};
    for (const room of rooms) roomNights[room.id] = [0, 1, 2].map(() => ({ occupied: 0, total: 0 }));
    for (const o of list) {
      for (const k of COUNT_KEYS) counts[k] += o.counts[k];
      for (const room of rooms) {
        const rn = o.roomNights[room.id];
        if (!rn) continue;
        rn.forEach((x, n) => {
          roomNights[room.id][n].occupied += x.occupied;
          roomNights[room.id][n].total += x.total;
        });
      }
    }
    return { counts, roomNights };
  }

  return { COUNT_KEYS, assessWeekend, sumOutcomes };
});
