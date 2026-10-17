# Ski lease room allocation: design

Date: 2026-10-17. Status: approved by Nate.

## Purpose

The lease has 17 members and one house with 5 bedrooms and couch spots. In past seasons, members signed up first come, first served each Tuesday. People with flexible schedules got the best beds, and people who signed up late got the couch. This demo shows the lease organizer that an optimizer with a memory of past weekends can share the good beds fairly.

The demo is a static web page on GitHub Pages. It simulates a season and a single weekend. It has no server and no real sign-up form.

## Rules

1. Each weekend has three nights: Thursday, Friday, and Saturday. The season runs from Thursday 7 January to Sunday 2 May, 2027 (17 weekends).
2. A person keeps one bed for all the nights of a stay. Nobody moves during a stay.
3. A bed holds one party on a night. A party is a single, or two linked partners who both registered.
4. A couple takes a queen, an air queen, or two twins in the same room. A couple never takes a bunk or a couch.
5. A couple holds its spot for every night that either partner stays. If only one partner registers, that person is a single for the weekend.
6. Singles can share twin and bunk rooms. The model applies a penalty for each shared room on each night with mixed genders. This is a preference, not a rule.
7. Every party has a no-bed option with a large penalty. The model always has a solution.
9. Couch cap (optimizer only): a floor night is a night on a couch, an air twin, an air queen, or no bed. Each floor night above the cap for the season costs 300 points. A blank cap turns the rule off.
8. After assignment, the page shows the free beds on each night as open for guests.

## Fairness

Each person has a running balance. For each night, the tool computes the average value of the occupied person-nights. The balance of each person on that night increases by the value of their bed minus that average. Both partners in a couple get the full value of their shared bed. An overflow night has a value of 0. The balances on each night add up to zero.

## Solver model

The model is a mixed-integer program that HiGHS solves in the browser.

- Variables: one binary variable for each pair of party and placement option.
- Each party takes exactly one option.
- On each night, each bed holds at most one option.
- Objective (maximize): the sum of bed value times priority weight, over each person and each night. The objective also adds a random term and a bonus for couples in queens. It subtracts the gender penalty and the overflow penalty.
- Priority weight: `exp(-strength * balance / 6)`, limited to the range from 1/50 to 50. The weight is absolute. A first version used a weight relative to the lowest and highest balance, but its push was too weak. Tests showed that it gave a larger spread than first come.
- The random term and the base term: each person-night adds `weight * (value + jitter) + 0.1 * value`. The jitter is uniform in `[0, noise]`. The scale by weight prevents a move to a worse bed type.

- Floor penalty: each floor night costs 4 points, independent of the weight. Tests showed that without it, people with a low weight went to the couch while a bed was free.

## Outcome measures

`outcomes.js` measures each weekend for both methods:

- Bedroom utilization: occupied bed-nights divided by available bed-nights, for real beds in bedrooms.
- Single in queen: a queen-night with one sleeper.
- Wasted queen: a single in a queen on a night when a couple uses two beds and a person is on the floor.
- Held-empty queen: a queen that a couple holds for a partner who is absent that night.
- Dominated floor: a floor night while a better option was free on all the nights of the party. For a single, the free bed must not make a mixed-gender room.
- Priority inversion: two singles of the same gender with the same nights. The person with the higher balance (by more than 1 point) has the better bed.
- Mixed-gender room, couple split, and nights over the couch cap.

## First-come baseline

The baseline uses the same attendance. Each party gets a random sign-up time. People with a flexible schedule sign up earlier on average. In sign-up order, each party takes the best free option that fits all its nights, under the same rules. If no couple option fits, the couple splits into the two best free beds. If no option fits, the party goes to overflow.

## Page

- Setup tab: rooms editor, people editor, strength and noise sliders, gender penalty, seed, JSON import and export.
- Weekend tab: a start state (fresh, or the balances after 8 simulated weekends) and a grid of people by nights. It also has a random sign-up button and an Assign button. The result shows a bed plan for each night, the free beds, and one reason line for each person.
- Season tab: both methods on the same attendance. A grid of people by weekends colored by bed value. Charts: "Running Balance by Person and Weekend", "Average Bed Value per Night by Person", "Couch and Overflow Nights by Person". Summary numbers: the standard deviation and the range of advantage (balance divided by nights), the gap between flexible singles and other singles, the gap between couples and singles, and the couch and overflow nights.

Chart titles describe the data. They do not state a conclusion.

## Files

- `model.js`: parties, options, LP text, solve, balance update. Pure functions.
- `simulate.js`: seeded random generator, attendance, first-come baseline, season loop, metrics.
- `defaults.js`: the sample house and 17 placeholder people.
- `app.js` and `index.html`: the page and the charts.
- Libraries: highs 1.15.3 from jsDelivr, Chart.js 4.5.1 from cdnjs.

## Tests

`npm test` runs Node tests on `model.js` and `simulate.js` with the same HiGHS package. The tests make sure that:

- No bed holds two parties on a night.
- Every person keeps one bed for the stay.
- Couples are together in a queen or a twin pair.
- Overflow only occurs if the beds run out.
- The balances on each night add up to zero.
- Over a season, the optimizer gives a smaller standard deviation of advantage than the baseline.
