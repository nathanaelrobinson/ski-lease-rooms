const test = require('node:test');
const assert = require('node:assert');
const loadHighs = require('highs');
const Model = require('../model.js');
const Sim = require('../simulate.js');
const Defaults = require('../defaults.js');

const config = { rooms: Defaults.rooms, people: Defaults.people, settings: Defaults.settings };
const beds = Model.flattenBeds(config.rooms);
const bedById = new Map(beds.map((b) => [b.id, b]));
let highs;

test.before(async () => {
  highs = await loadHighs();
});

/* Make sure that one result obeys the hard rules of the spec. */
function assertValid(result, allowSplit = false) {
  for (let n = 0; n < 3; n++) {
    const seen = new Set();
    result.parties.forEach((party, pi) => {
      if (!party.nights.includes(n)) return;
      for (const b of result.choices[pi].beds) {
        assert.ok(!seen.has(b), `bed ${b} holds two parties on night ${n}`);
        seen.add(b);
      }
    });
  }
  result.parties.forEach((party, pi) => {
    const option = result.choices[pi];
    if (party.members.length === 2 && !option.overflow && !(allowSplit && option.split)) {
      const [a, b] = party.members.map((m) => bedById.get(option.assign[m]));
      const queen = a.id === b.id && a.type === 'queen';
      const twins = a.id !== b.id && a.type === 'twin' && b.type === 'twin' && a.roomId === b.roomId;
      assert.ok(queen || twins, `couple ${party.id} is in ${a.id} and ${b.id}`);
    }
    for (const m of party.members) assert.ok(m in result.assignment, `person ${m} has no single bed`);
  });
}

function everyone(nights) {
  const reg = {};
  for (const p of config.people) reg[p.id] = nights;
  return reg;
}

test('a full Saturday obeys the rules', () => {
  const result = Model.solveWeekend(highs, { ...config, registrations: everyone([2]), rng: Sim.rngFromSeed(1) });
  assert.strictEqual(result.status, 'Optimal');
  assertValid(result);
});

test('overflow only occurs if the beds run out', () => {
  const small = { ...config, registrations: { ivan: [0, 1, 2], jess: [1, 2], alex: [2], blair: [2] } };
  const result = Model.solveWeekend(highs, { ...small, rng: Sim.rngFromSeed(2) });
  assert.ok(Object.values(result.assignment).every((b) => b !== null));

  /*
   * The house has 13 beds. 2 couples in queens and 2 couples in twins use 6 beds.
   * The 9 singles get the 7 other beds, so a full Saturday has exactly 2 overflow people.
   */
  const full = Model.solveWeekend(highs, { ...config, registrations: everyone([2]), rng: Sim.rngFromSeed(3) });
  assert.strictEqual(Object.values(full.assignment).filter((b) => b === null).length, 2);
});

test('a person keeps one bed for the stay and partners with other nights share a spot', () => {
  const reg = { alex: [0, 1, 2], blair: [2], ivan: [1, 2], max: [2] };
  const result = Model.solveWeekend(highs, { ...config, registrations: reg, rng: Sim.rngFromSeed(4) });
  assertValid(result);
  const couple = result.parties.find((p) => p.members.includes('alex'));
  assert.deepStrictEqual(couple.nights, [0, 1, 2]);
  const bed = result.assignment.alex;
  for (const n of [0, 1, 2]) assert.strictEqual(result.plan[n][bed].partyId, couple.id);
  assert.deepStrictEqual(result.plan[0][bed].sleepers, ['alex']);
});

test('the balance changes on each night add up to zero', () => {
  const reg = Sim.drawAttendance(config.people, Sim.rngFromSeed(5));
  const result = Model.solveWeekend(highs, { ...config, registrations: reg, rng: Sim.rngFromSeed(6) });
  const { balances } = Model.updateBalances({}, result, config.rooms);
  const total = Object.values(balances).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total) < 1e-9, `total is ${total}`);
});

test('the person with the lowest balance gets the best single bed', () => {
  const reg = { ivan: [2], kai: [2], max: [2] };
  const balances = { ivan: 5, kai: -5, max: 0 };
  const result = Model.solveWeekend(highs, {
    ...config, registrations: reg, balances, settings: { noise: 0 }, rng: Sim.rngFromSeed(7),
  });
  assert.strictEqual(result.assignment.kai, 'primary-q');
});

test('the first-come baseline obeys the rules', () => {
  const reg = Sim.drawAttendance(config.people, Sim.rngFromSeed(8));
  const result = Sim.firstComeWeekend({ ...config, registrations: reg, rng: Sim.rngFromSeed(9) });
  assertValid(result, true);
});

test('over a season the optimizer has a smaller deviation of advantage than first come', () => {
  for (const seed of [2027, 11, 42, 7]) {
    const season = Sim.runSeason(highs, { ...config, settings: { ...config.settings, seed } });
    for (const week of season.optimizer.weeks) assertValid(week.result);
    const o = season.optimizer.metrics;
    const f = season.firstCome.metrics;
    console.log(`seed ${seed}: stdev ${o.stdev.toFixed(2)}/${f.stdev.toFixed(2)} spread ${o.spread.toFixed(2)}/${f.spread.toFixed(2)};`,
      `flex singles gap ${(o.flexibleSinglesAvg - o.otherSinglesAvg).toFixed(2)}/${(f.flexibleSinglesAvg - f.otherSinglesAvg).toFixed(2)};`,
      `couple gap ${(o.couplesAvg - o.singlesAvg).toFixed(2)}/${(f.couplesAvg - f.singlesAvg).toFixed(2)};`,
      `overflow ${o.overflowNights}/${f.overflowNights}; couch ${o.couchNights}/${f.couchNights}`);
    assert.ok(o.stdev < f.stdev, `seed ${seed}: ${o.stdev} >= ${f.stdev}`);
  }
});
