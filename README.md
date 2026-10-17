# Ski Lease Rooms

A demo of fair weekly room assignment for a ski lease. Members register for Thursday, Friday, or Saturday night. A mixed-integer program assigns the beds. It gives priority to people who got worse beds in earlier weekends, and a small random term breaks ties.

The page also simulates the 2027 season (7 January to 2 May) and compares the optimizer with first come, first served on the same attendance.

## Use

Open the page on GitHub Pages, or serve the folder with any static web server:

```
python3 -m http.server 8000
```

The page uses the HiGHS solver (WebAssembly, from jsDelivr) and Chart.js (from cdnjs). It has no build step and no server. The configuration is kept in the browser. Use Export JSON in the Setup tab to share a configuration.

## Tests

```
npm install
npm test
```

The design is in `docs/specs/2026-10-17-ski-lease-room-allocation-design.md`.
