# Room assignment in tahoe-house: integration spec

Date: 2026-11-07. Status: tahoe-house PR 1 (shadow mode) is on the branch `room-assignment-shadow`. Live mode is next.

Decisions from Nate on 2026-11-07:

- Add the new tables and `Bed.value`.
- Drop gender.
- Use `CoupleLink` for partners, with a "book together" choice for each weekend.
- Put overflow beds in the solver run, and give admins a way to describe them.
- Start priority at 0 each season.
- The model must accept any set of nights, on any days of the week.

## Summary

The tahoe-house app assigns beds first come, first served. When the member release window opens (Tuesday 10:00), a member picks a bed on the sheet. The unique index on `Stay.activeKey` settles the race. When the guest window opens on Thursday, guests take the beds that are left.

The optimizer replaces the member race, not the guest flow. While the member window is open, members register for nights. At a lock time, a solver run assigns the beds and writes ordinary `Stay` rows. After the run, the sheet, the guest release, cancellation, and the admin tools work as they do now.

The work is behind a new season feature flag, `features.roomAssignment`, with three values: `off`, `shadow`, and `on`. The default is `off`. A deploy changes nothing until an admin changes the flag.

## How tahoe-house works now

- Season configuration is a JSON column (`Season.config`). The zod schema in `lib/season-config.ts` validates it. Feature flags already live there (`features.guests`, `features.board`, and others). The admin season page (`app/(app)/admin/season/page.tsx`) shows them as tick boxes.
- A `Stay` is one bed on one night. A couple that shares a bed is one `Stay` with `membershipId` and `companionMembershipId`. Couples come from `CoupleLink` rows that both partners accepted (`lib/couples.ts`).
- `lib/booking.ts` (`claimBed`) is the single write path. It examines the season dates, the release window, the membership, and the house of the bed. It also applies the rule of one bed for each person on each night.
- `ReleaseRule` rows make `ReleaseWindow` rows (`lib/release-sync.ts`, cron `/api/cron/release-windows`). A window has an audience (`MEMBER` or `GUEST`), an open time, and a covered date range.
- A `Bed` has a `label`, a `BedType`, a `sleeps` number, `isActive`, and `isOverflow`. The types are `QUEEN`, `KING`, `FULL`, `TWIN`, `BUNK_TOP`, `BUNK_BOTTOM`, `COUCH`, and `FLOOR`. Overflow beds are hidden from the member sheet. Admins edit beds in Admin → House (`components/admin/RoomEditor.tsx`).
- `ShareType.nightAllowance` holds the nights that a share includes. The app does not enforce it. The integration test "legacy allowances do not limit nights" makes sure of that, so registration does not enforce it either.
- Tests use vitest (`npm test`). CI also runs integration tests against PostgreSQL 18 (`.github/workflows/ci.yml`).

## Flow with the flag on

1. The member window opens as now. Members tick nights on the sheet, not beds. Each partner of a couple registers for their own nights and keeps or clears "Book with partner". Members can change registrations until the lock.
2. At the lock time, a solver run reads the registrations, the beds, the couples, the stays that already exist, and the priority balances. It writes one `Stay` for each person (or couple) on each night.
3. The sheet shows the result. A member who got no bed sees that on the sheet and in an email. Members can still cancel a night. After the run, free beds are first come, first served, as now.
4. The guest window opens on Thursday as now and offers the beds that are left, with the empty overflow beds.
5. The run stores the new priority balances for the next weekend.

In `shadow` mode, step 2 runs and stores its plan, but writes no `Stay` rows. Members keep the old race. An admin page compares the optimizer plan with the real first-come result for the same weekend. This is how the house tests the solver with real people.

## Bed architecture: what the model needs and what is missing

The model describes a bed with an id, a room, a type, and a value. It decides three things from the type. Can a couple share the bed? Is the bed a queen for the couple-first rule? Is the bed a floor spot for the couch cap? tahoe-house has more detail (`sleeps`, `isOverflow`), so the type alone is not sufficient. The table gives each gap and its fix.

| Need of the model | tahoe-house now | Fix |
|---|---|---|
| A value for each bed | No field | `Bed.value Int` (migration), with a default for each type |
| Can a couple share the bed | Only the type, and `sleeps` (information only) | Model change: each bed gets a `shared` attribute. The adapter sets it from the type and `sleeps` |
| Is the bed a queen | `QUEEN` or `KING` | Model change: a `queen` attribute. The adapter sets it from the type |
| Is the bed a floor spot | `COUCH`, `FLOOR`, or `isOverflow` | Model change: a `floor` attribute. The adapter sets it from the type and `isOverflow` |
| Two twins in one room for a couple | `TWIN` beds with the same `roomId` | No change. The run writes two stays, one for each partner |
| A note that tells a member what the bed is | Only `label` (100 characters) and the room description | `Bed.note String?` (migration) |
| Common rooms (living room) | No field | No change. If all active beds of a room are floor spots, the adapter marks the room as common. Only the outcome measures use it |
| Beds that are already taken on a night | `Stay` rows | Model change: `input.taken` for each night |
| A member who already has a stay on a night | `Stay` rows | Adapter: remove that night from the registration of the member, and mark the bed taken |
| A record of a member with no bed | Nothing. A `Stay` needs a bed | `NightRegistration.outcome` (migration) |
| The nights of a run | The covered range of the window, any length | Model change: `input.nights` |

Adapter rules for the three bed attributes:

| tahoe-house bed | `shared` | `queen` | `floor` |
|---|---|---|---|
| `QUEEN`, `KING` | yes | yes | if `isOverflow` |
| `FULL` | yes | no | if `isOverflow` |
| `TWIN`, `BUNK_TOP`, `BUNK_BOTTOM` | no | no | if `isOverflow` |
| `COUCH` | if `sleeps` is 2 or more | no | yes |
| `FLOOR` (air mattress) | if `sleeps` is 2 or more | no | yes |

Default values for `Bed.value`, from the demo: `KING` 10, `QUEEN` 8, `FULL` 7, `TWIN` 6, `BUNK_BOTTOM` 4, `BUNK_TOP` 3, `COUCH` 2, and `FLOOR` 1. The migration fills existing beds with these values. Admins then change them in the room editor.

## Backend changes (flagged for review)

These items change the database, the server, or the deployment. Each one needs Theo's agreement.

### Migration

One migration adds the items below. Every new column is nullable or has a default, so the old code keeps working on the new schema.

```prisma
enum RegistrationOutcome {
  PENDING
  ASSIGNED
  NO_BED
  CANCELLED
}

enum AssignmentRunMode {
  SHADOW
  LIVE
}

enum AssignmentRunStatus {
  PLANNED
  APPLIED
  FAILED
  UNDONE
}

/// One member asks for a bed on one night of a member window.
model NightRegistration {
  id              String              @id @default(uuid())
  seasonId        String
  membershipId    String
  releaseWindowId String
  date            DateTime            @db.Date
  bookTogether    Boolean             @default(true)
  outcome         RegistrationOutcome @default(PENDING)
  stayId          String?
  assignmentRunId String?
  createdAt       DateTime            @default(now())
  cancelledAt     DateTime?
  /// Set to "membershipId:date" while active, and null after a cancel. The same pattern as Stay.activeKey.
  activeKey       String?             @unique

  season        Season         @relation(fields: [seasonId], references: [id], onDelete: Cascade)
  membership    Membership     @relation(fields: [membershipId], references: [id], onDelete: Cascade)
  releaseWindow ReleaseWindow  @relation(fields: [releaseWindowId], references: [id], onDelete: Cascade)
  assignmentRun AssignmentRun? @relation(fields: [assignmentRunId], references: [id], onDelete: SetNull)

  @@index([seasonId, releaseWindowId])
  @@index([membershipId])
}

/// One solver run for one member window. It is the audit trail and the store of priority balances.
model AssignmentRun {
  id              String              @id @default(uuid())
  seasonId        String
  releaseWindowId String
  mode            AssignmentRunMode
  status          AssignmentRunStatus @default(PLANNED)
  seed            Int
  modelVersion    String
  input           Json
  result          Json
  balancesBefore  Json
  balancesAfter   Json
  createdAt       DateTime            @default(now())
  createdById     String?
  appliedAt       DateTime?
  undoneAt        DateTime?

  season        Season              @relation(fields: [seasonId], references: [id], onDelete: Cascade)
  releaseWindow ReleaseWindow       @relation(fields: [releaseWindowId], references: [id], onDelete: Cascade)
  registrations NightRegistration[]
  stays         Stay[]

  @@index([seasonId, createdAt])
  @@index([releaseWindowId])
}
```

Changes to existing models in the same migration:

- `Bed.value Int @default(5)`, then an update that sets the value for each type from the defaults above.
- `Bed.note String?` with 500 characters at most (zod limit in `lib/room-editor.ts`).
- `Stay.assignmentRunId String?` with a relation to `AssignmentRun` and an index.
- Back-relations on `Season`, `Membership`, and `ReleaseWindow`.

The priority balances for a run come from `balancesAfter` of the last `APPLIED` live run of the season. In `shadow` mode, they come from the last `PLANNED` shadow run. If no such run exists, every member starts at 0. A run with the status `UNDONE` does not count.

### Server and deployment

1. A change to `claimBed`. If the flag is `on`, a member claim on a night in a member window fails. It fails until a run for that window is `APPLIED`. Use the new code `ASSIGNMENT_PENDING`. Admin claims (`bypassRelease`) keep working.
2. Registration actions (`app/actions/registrations.ts`). Register, change, and cancel nights until the lock. Reject a member who is not `ACTIVE`, and a night outside the window.
3. The run (`lib/room-assignment/run.ts`). Read all inputs in one transaction, solve, and store an `AssignmentRun`. In `on` mode, write all stays in one serializable transaction through `runClaimBed` with `bypassRelease`. Set `releaseWindowId` and `assignmentRunId` on each stay. Set `outcome` and `stayId` on each registration. If a bed became taken after the read, stop and mark the run `FAILED`. The run never overwrites a stay.
4. Undo. An admin action cancels the stays of one run (the same `activeKey` null pattern as `cancelStay`) and sets the run to `UNDONE`. The admin can then run the solver again.
5. Cron route `/api/cron/assign-rooms` and a new entry in `vercel.json`. The route finds member windows whose lock time passed and that have no run, then runs the solver. It is idempotent: a second call finds the run and does nothing. Set `maxDuration` to 60 seconds. Vercel Hobby plans run cron one time a day at an imprecise time. On Hobby, the admin "Run now" button is the main trigger.
6. Email to each member after a live run: the beds of the member, the `Bed.note` for each bed, and a line for each night with no bed. Use the existing Resend path in `lib/email`.
7. Server dependency `highs` (WebAssembly MIP solver, MIT license). Add it to `serverExternalPackages` in `next.config`. Make sure that the `.wasm` file is in the Vercel function output. The route uses the Node runtime, not Edge.
8. New season configuration keys (no migration), with zod defaults: `roomAssignment.lockOffsetHours`, `strength` (2), `noise` (1.5), `couchCap` (null), `movePenalty` (30), and the default bed value for each type.

## Model changes in this repo (ski-lease-rooms)

Make these changes here first, with tests, before the copy into tahoe-house.

- Nights. Today `model.js` uses three fixed nights (`NIGHTS = ['Thu', 'Fri', 'Sat']`). `simulate.js`, `outcomes.js`, and `app.js` repeat that assumption in about 26 places. The changes are below.
  - The caller gives `input.nights`, a sorted list of date keys, for example `['2027-01-07', '2027-01-08', '2027-01-09', '2027-01-10']`. The model uses the index of each date inside the run.
  - The list has from 1 to 31 dates. It can start on any day of the week. It can skip a date.
  - A stay is a run of consecutive dates. A member who registers for Thursday and Saturday gets two stays. Each stay keeps one bed, and the two beds can be different.
  - `updateBalances`, the outcome measures, and the plan for each night use `input.nights`.
  - A configuration with no `nights` field keeps Thursday to Saturday, so the demo page still works.
- Bed attributes. Replace the type sets (`SHARED_TYPES`, `QUEEN_TYPES`, `FLOOR_TYPES`) with the bed attributes `shared`, `queen`, and `floor`. A bed with no attributes takes them from its type, so the demo data still works.
- Taken beds. Add `input.taken`: for each night, the bed ids that hold a stay before the run. The model removes those beds on that night.
- Gender. The adapter sends no gender and sets `genderPenalty: 0`. The model keeps the code for the demo.
- Guests. The run assigns members only (stage S1, with the move stage S1m). Guests keep the Thursday flow.
- Planning ahead (stage S2). tahoe-house has no calendar of future plans. Set `planning: false`.
- Packaging. Copy `model.js` into tahoe-house as `lib/room-assignment/model.js` with a `.d.ts` type file, or port it to TypeScript. Keep one source of truth, and copy the model tests.

## Admin and member screens

- Room editor. Show the `Bed.value` field next to "Sleeps", with the help line "A higher number is a better bed." Show `Bed.note` under each bed. Show `FLOOR` as "Floor / air mattress". If the flag is not `off`, rename "Guest overflow" to "Overflow (members and guests)". Also add the line "The solver can put a member here when the real beds are full."
- Season page. A three-way control for the flag, and the `roomAssignment` configuration keys.
- Admin assignment page (`app/(app)/admin/assignment/page.tsx`). The registrations for the current window, the priority of each member, "Run now", "Undo run", and the run history. In `shadow` mode, it shows the optimizer plan next to the real stays, with the outcome measures from `outcomes.js`.
- Member sheet. While the window is open and the flag is `on`, the sheet shows nights to tick and the "Book with partner" toggle. After the run, it shows the beds, with overflow beds that hold a member and the `Bed.note` of each bed.

## Inputs the solver needs

| Solver input | tahoe-house source | Status |
|---|---|---|
| `nights` | Covered dates of the member `ReleaseWindow` | Model change |
| `rooms` and beds | `Room` and `Bed`, active and not archived, with overflow beds | Exists |
| Bed `value` | `Bed.value` | New column |
| Bed `shared`, `queen`, `floor` | Adapter rules from `type`, `sleeps`, and `isOverflow` | Model change |
| `people` with `partnerId` | Active `Membership` rows. If both partners kept `bookTogether` for the window, an active `CoupleLink` gives a partner | Exists, and a new column |
| `registrations` | Active `NightRegistration` rows for the window | New table |
| `balances` | `balancesAfter` of the last run that counts, or 0 for each member | New table |
| `floorNights` (couch cap) | Count of the earlier member stays of the season on floor beds | A query |
| `taken` | `CONFIRMED` `Stay` rows on the nights of the window before the run | Model change and a query |
| `settings` | `roomAssignment` keys in the season configuration | New keys |
| `rng` | A seeded generator. The run stores the seed, so a second run gives the same plan | Adapter code |
| `highs` | The `highs` package on the server | New dependency |

## Feature flag

Add the flag to `features` in `lib/season-config.ts`:

```ts
roomAssignment: z.enum(["off", "shadow", "on"]).default("off"),
```

`parseSeasonConfig` fills `off` for old seasons, so the flag needs no migration. Every new route, action, and sheet branch reads `season.config.features.roomAssignment` first.

## Pull requests

1. ski-lease-rooms (this repo). The model changes: nights, bed attributes, and taken beds, with tests. The demo page keeps working.
2. tahoe-house PR 1, shadow mode. The flag, the migration, and the copied model with its tests. The adapter, the registration actions, and the room editor fields. The admin assignment page with a dry run. It writes no stays. It is safe to merge with the flag `off`.
3. tahoe-house PR 2, live mode. The `claimBed` rule, the write step, undo, the cron route, the email, and the member sheet change.
4. Later. Guests in the run, and planning ahead.

All tahoe-house work goes on a feature branch with a PR to `main`. Nobody pushes to `main` directly.

## Testing

- Model unit tests (this repo, `npm test`). The existing rules: no bed holds two parties on a night, a person keeps one bed for a stay, couples stay together, and balances add up to zero. New cases for nights: a four-night run (Thursday to Sunday), a one-night run, a run that starts on a Monday, and a run with a gap. Other new cases: a member with a gap between two nights, taken beds, and a couch that sleeps 2.
- Adapter unit tests (tahoe-house, vitest, no database). Build solver input from fixture rows that copy the Prisma shapes. Cases: one partner clears `bookTogether` (two singles), and a couple on a `FLOOR` bed that sleeps 2. A full house sends a member to an overflow bed. A member already has a stay. 
- Integration tests (tahoe-house, PostgreSQL, the existing CI job). Seed a season, register members, run the assignment, and examine the `Stay` and `NightRegistration` rows. Run the cron two times, and make sure that the second call changes nothing. Put a stay in a bed between the read and the write, and make sure that the run fails and overwrites nothing. Undo a run, and make sure that the beds are free.
- Replay. The 2025 and 2026 history files in `private/` hold real attendance and beds. A local script loads them into a disposable database and runs the shadow comparison. Keep the script out of Git, because the files hold real names.
- Live shadow test. Set the flag to `shadow` for two or three weekends. The house signs up as now, and the admin page shows the optimizer plan for the same weekends. Set the flag to `on` only after the house agrees with the comparison.
- Preview deployments. A Vercel preview needs its own database, for example a Neon branch. Do not point a preview at the live database.

## Open questions for Theo

- Which Vercel plan does the project use? The answer sets the cron precision.
- What is the lock time: a fixed number of hours after the window opens, or only the admin button?
- Copy `model.js`, or port it to TypeScript?
- The migrations and `schema.prisma` do not agree now: `prisma migrate diff` wants to drop `StockLog` and five `StockItem` columns. The room assignment migration leaves them out. Which side is correct?
