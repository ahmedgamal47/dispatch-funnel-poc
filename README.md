# Dispatch Pipeline Playground

Interactive proof of concept demonstrating a geo-pooled dispatch service. New trip requests enter their configured pools, flow through a customizable filter funnel, gather weights from pluggable strategies, then get solved with the Hungarian algorithm before either completing or returning to the pool.

## Getting Started

1. Install dependencies (already done once):
   ```bash
   npm install
   ```
2. Run the development server:
   ```bash
   npm run dev
   ```
   Vite will print a local URL (usually <http://localhost:5173>). Open it in a browser to watch the simulation.
3. Build for production (optional):
   ```bash
   npm run build && npm run preview
   ```

## How the Simulation Works

- **Trip Pools** – Two geo-fenced pools release queued trips on their own cadence (Downtown every 6s, Uptown every 9s).
- **Filter Funnel** – Toggle the pre-configured filters (on-shift, proximity, vehicle specialization, quality bar) to see how they shrink or adjust the candidate set.
- **Strategy Stack** – Enable/disable strategies to change how the solver scores matches. When no strategies are active the system falls back to a proximity/rating blend.
- **Solver** – The Hungarian algorithm runs on the weighted cost matrix and proposes a global optimum assignment. Driver acceptance is simulated so trips can bounce back into the pool when rejected.
- **Timeline** – Recent dispatch runs show quick summaries of matches vs retries.
- **Playback Controls** – Use the pause/resume toggle in the hero to freeze queues, countdowns, and dispatch releases while you experiment.
- **Trip Intake Mode** – The floating switch flips between automatic generation and manual-only intake so you can fully stage scenarios.
- **Manual Trips** – The manual console lets you handcraft trips (pool, rider name, pickup, vehicle, rating) and enqueue them on demand.
- **Driver Availability** – Configure which drivers start on shift per pool to model different supply scenarios before pressing play.

## Extending the POC

- Add new filter/strategy definitions in `src/App.tsx` by pushing objects into `FILTER_LIBRARY` or `STRATEGY_LIBRARY`.
- Adjust pool release timings or add extra pools via the `POOLS` array.
- Swap visual styling in `src/styles.css` without touching the simulation logic.

Enjoy experimenting with the dispatch funnel!
