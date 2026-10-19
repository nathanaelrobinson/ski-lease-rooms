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

Each person has a running balance. The page shows the negative balance as "Priority": a high priority means the person is due a better room. People who sleep as a couple and people who sleep as a single on a weekend are in two separate pools. For each night, the tool computes the average bed value of each pool. Each person's balance then increases by the value of their bed minus the average of their pool. A partner who comes alone is in the single pool for that weekend. A no-bed night has a value of 0. The balances in each pool on each night add up to zero.

Decision on 2026-10-19: couples get the queens first. With one shared pool, couples always drift up and singles drift down. Then the absolute weights saturate and rotation inside each group stops. Two pools keep the rotation inside each group. Singles get the queens that couples do not need.

## Solver model

The model is a mixed-integer program that HiGHS solves in the browser.

- Variables: one binary variable for each pair of party and placement option.
- Each party takes exactly one option.
- On each night, each bed holds at most one option.
- Objective (maximize): the sum of bed value times priority weight, over each person and each night. The objective also adds a random term and a bonus of 5000 for each couple in a real queen, one time for any number of nights. It subtracts the floor penalty, the couch cap penalty, the gender penalty, and a no-bed penalty of 10000 for each person-night.
- Priority weight: `exp(-strength * balance / 6)`, limited to the range from 1/50 to 50. The weight is absolute. A first version used a weight relative to the lowest and highest balance, but its push was too weak. Tests showed that it gave a larger spread than first come.
- The random term and the base term: each person-night adds `weight * (value + jitter) + 0.1 * value`. The jitter is uniform in `[0, noise]`. The scale by weight prevents a move to a worse bed type.

- Floor penalty: each floor night costs 4 points, independent of the weight. Tests showed that without it, people with a low weight went to the couch while a bed was free.

## Outcome measures

`outcomes.js` measures each weekend for both methods:

- Bedroom utilization: sleepers divided by sleeping spaces, for real beds in bedrooms. A queen has 2 spaces.
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

The Weekend tab runs both methods on the same registrations. It shows a table of measures (Opt, FC, Δ) and draws each room for one night. Each bed is a shape sized by type, with initials chips for the sleepers. Colors: teal for the optimizer, neutral gray for first come, violet for couples, and teal for singles. The colorblind validator passed for the teal and violet pair and for teal against gray.

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

## Guests and planning ahead (added 2026-10-19)

Guests:

- A member can bring one guest for the member's nights. Types: partner (shares the host bed), roommate (in the host room), and any bed.
- Guests never displace members. Stage S0 places members with each host alone and records the member floor and no-bed nights. Stage S1 adds partner guests under the limit that member floor and no-bed nights do not go up. Stage S3 places roommate and any-bed guests in the beds that are left, and members do not move.
- A partner guest booked 3 or more weeks ahead gets the same queen bonus as a member couple. Priority then decides. A later request only gets the queens that member couples do not need.
- A host with a partner guest stays in the single pool, so a queen costs the host priority. A guest in their own bed costs the host the amount by which the guest bed beats the single average of that night (minimum 0).

Calendar and planning ahead:

- Each person can put weekends on the calendar ahead of time (people table: Plan %, settings: calendar lead).
- Stage S2 (rollout): before it decides this weekend, the solver plays the known future weekends forward with the one-weekend model. The result is a projected priority for each member. This weekend is solved again with the projected priority. It must keep the S1 hard measures: member floor, no-bed nights, and mixed rooms do not go up, and couples in queens and partner guests with hosts do not go down.
- A first version solved the window as one multi-week MIP. It took 10 to 60 seconds for a season and did not improve fairness, so the rollout replaced it.

New measures: guest nights placed, guest nights with no bed, partner guests with host, and member on the floor while a guest has a bed.
