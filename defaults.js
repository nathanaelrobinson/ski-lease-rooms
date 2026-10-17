/*
 * Sample house and placeholder people.
 * Replace the people with the real lease list in the Setup tab, or import a JSON file.
 * pattern is the usual set of nights. "mixed" picks a random pattern each weekend.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SkiDefaults = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const rooms = [
    { id: 'primary', name: 'Primary Suite', beds: [{ id: 'primary-q', type: 'queen', value: 10 }] },
    { id: 'lake', name: 'Lake Room', beds: [{ id: 'lake-q', type: 'queen', value: 8 }] },
    {
      id: 'twin',
      name: 'Twin Room',
      beds: [
        { id: 'twin-1', type: 'twin', value: 6 },
        { id: 'twin-2', type: 'twin', value: 6 },
      ],
    },
    {
      id: 'loft',
      name: 'Loft',
      beds: [
        { id: 'loft-1', type: 'twin', value: 5 },
        { id: 'loft-2', type: 'twin', value: 5 },
      ],
    },
    {
      id: 'bunk',
      name: 'Bunk Room',
      beds: [
        { id: 'bunk-1b', type: 'bunk_bottom', value: 4 },
        { id: 'bunk-1t', type: 'bunk_top', value: 3 },
        { id: 'bunk-2b', type: 'bunk_bottom', value: 4 },
        { id: 'bunk-2t', type: 'bunk_top', value: 3 },
      ],
    },
    {
      id: 'living',
      name: 'Living Room',
      common: true,
      beds: [
        { id: 'couch-1', type: 'couch', value: 2 },
        { id: 'couch-2', type: 'couch', value: 2 },
        { id: 'couch-3', type: 'couch', value: 1 },
      ],
    },
  ];

  const P = (id, name, gender, partnerId, attend, pattern, flexible) => ({
    id, name, gender, partnerId, attend, pattern, flexible,
  });

  const people = [
    P('alex', 'Alex', 'M', 'blair', 0.8, 'thu-sat', true),
    P('blair', 'Blair', 'F', 'alex', 0.8, 'thu-sat', true),
    P('casey', 'Casey', 'M', 'dana', 0.7, 'fri-sat', false),
    P('dana', 'Dana', 'F', 'casey', 0.7, 'fri-sat', false),
    P('eli', 'Eli', 'M', 'fran', 0.6, 'mixed', false),
    P('fran', 'Fran', 'F', 'eli', 0.6, 'mixed', false),
    P('gabe', 'Gabe', 'M', 'hana', 0.5, 'sat', false),
    P('hana', 'Hana', 'F', 'gabe', 0.5, 'sat', false),
    P('ivan', 'Ivan', 'M', null, 0.85, 'thu-sat', true),
    P('jess', 'Jess', 'F', null, 0.75, 'thu-sat', true),
    P('kai', 'Kai', 'M', null, 0.7, 'fri-sat', false),
    P('lena', 'Lena', 'F', null, 0.65, 'fri-sat', false),
    P('max', 'Max', 'M', null, 0.6, 'sat', false),
    P('nora', 'Nora', 'F', null, 0.55, 'mixed', false),
    P('owen', 'Owen', 'M', null, 0.5, 'fri', false),
    P('pia', 'Pia', 'F', null, 0.6, 'sat', false),
    P('quinn', 'Quinn', 'M', null, 0.45, 'mixed', false),
  ];

  const settings = { strength: 2, noise: 1.5, genderPenalty: 3, coupleBonus: 2, couchCap: 4, seed: 2027 };

  return { rooms, people, settings };
});
