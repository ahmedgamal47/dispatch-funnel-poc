import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

type Stage = 'pool' | 'filters' | 'strategy' | 'solver' | 'outcome';
type VehicleType = 'Sedan' | 'SUV' | 'EV';
type TripStatus = 'queued' | 'assigned' | 'returned';

type Trip = {
  id: string;
  poolId: string;
  riderName: string;
  pickup: string;
  riderRating: number;
  vehiclePreference: VehicleType;
  createdAt: number;
  status: TripStatus;
};

type Pool = {
  id: string;
  name: string;
  releaseIntervalMs: number;
  color: string;
};

type Driver = {
  id: string;
  name: string;
  rating: number;
  vehicleType: VehicleType;
  distanceKm: number;
  idleMinutes: number;
  onShift: boolean;
  geofences: string[];
};

type DispatchStep = {
  id: string;
  stage: Stage;
  title: string;
  detail: string;
  meta?: Record<string, unknown>;
};

type DispatchRun = {
  id: string;
  pool: Pool;
  timestamp: number;
  steps: DispatchStep[];
  assignments: Assignment[];
  unmatchedTrips: Trip[];
  headline: string;
};

type Assignment = {
  trip: Trip;
  driver?: Driver;
  score?: number;
  accepted?: boolean;
  rejection?: boolean;
};

type PairEligibility = Record<string, Set<string>>;

type FilterInput = {
  trips: Trip[];
  drivers: Driver[];
  pool: Pool;
  pairEligibility: PairEligibility;
};

type FilterResult = {
  drivers: Driver[];
  pairEligibility: PairEligibility;
  summary: string;
  droppedDriverIds?: string[];
  blockedPairs?: number;
};

type FilterDefinition = {
  id: string;
  name: string;
  description: string;
  apply: (input: FilterInput) => FilterResult;
};

type StrategyDefinition = {
  id: string;
  name: string;
  description: string;
  weight: (trip: Trip, driver: Driver) => number;
};

type DispatchOutcome = {
  run: DispatchRun;
  updatedDrivers: Driver[];
  unmatchedTrips: Trip[];
};
const STAGES: { id: Stage; label: string; description: string }[] = [
  { id: 'pool', label: 'Pool Release', description: 'Trips exit their geo pool in batches.' },
  { id: 'filters', label: 'Filter Funnel', description: 'Domain-driven filters trim or prioritize candidates.' },
  { id: 'strategy', label: 'Strategy Weights', description: 'Pluggable strategies score trip-driver pairs.' },
  { id: 'solver', label: 'Hungarian Solver', description: 'Global optimizer locks in the best assignment.' },
  { id: 'outcome', label: 'Dispatch Result', description: 'Trips confirm matches or return for another cycle.' },
];

const POOLS: Pool[] = [
  { id: 'downtown', name: 'Downtown Loop', releaseIntervalMs: 6000, color: '#FFB200' },
  { id: 'uptown', name: 'Uptown Hills', releaseIntervalMs: 9000, color: '#7A5FFF' },
];

const INITIAL_DRIVERS: Driver[] = [
  { id: 'd1', name: 'Leah M.', rating: 4.92, vehicleType: 'Sedan', distanceKm: 1.2, idleMinutes: 3, onShift: true, geofences: ['downtown'] },
  { id: 'd2', name: 'Jun S.', rating: 4.5, vehicleType: 'SUV', distanceKm: 3.8, idleMinutes: 7, onShift: true, geofences: ['downtown', 'uptown'] },
  { id: 'd3', name: 'Amara M.', rating: 4.78, vehicleType: 'EV', distanceKm: 2.3, idleMinutes: 2, onShift: true, geofences: ['downtown'] },
  { id: 'd4', name: 'Luis G.', rating: 4.3, vehicleType: 'Sedan', distanceKm: 6.4, idleMinutes: 11, onShift: true, geofences: ['uptown'] },
  { id: 'd5', name: 'Priya R.', rating: 4.87, vehicleType: 'SUV', distanceKm: 4.9, idleMinutes: 5, onShift: true, geofences: ['uptown'] },
  { id: 'd6', name: 'Noah B.', rating: 4.99, vehicleType: 'EV', distanceKm: 1.5, idleMinutes: 9, onShift: false, geofences: ['downtown', 'uptown'] },
];
const FILTER_LIBRARY: FilterDefinition[] = [
  {
    id: 'on-shift',
    name: 'On Shift Only',
    description: 'Skip drivers who are not on an active shift.',
    apply: ({ drivers, pairEligibility, trips, pool }) => {
      const active = drivers.filter((driver) => driver.onShift);
      const dropped = drivers.filter((driver) => !driver.onShift).map((driver) => driver.id);
      const nextEligibility = cloneEligibility(pairEligibility);
      if (dropped.length) {
        for (const trip of trips) {
          const set = nextEligibility[trip.id];
          if (!set) continue;
          for (const id of dropped) {
            set.delete(id);
          }
        }
      }
      const summary = dropped.length
        ? `Removed ${dropped.length} driver${dropped.length > 1 ? 's' : ''} off shift for ${pool.name}.`
        : 'Every candidate is currently on shift.';
      return { drivers: active, pairEligibility: nextEligibility, summary, droppedDriverIds: dropped };
    },
  },
  {
    id: 'proximity-cap',
    name: 'Proximity Cap',
    description: 'Drivers beyond 6km are temporarily skipped.',
    apply: ({ drivers, pairEligibility, trips }) => {
      const threshold = 6;
      const within = drivers.filter((driver) => driver.distanceKm <= threshold);
      const dropped = drivers.filter((driver) => driver.distanceKm > threshold).map((driver) => driver.id);
      const nextEligibility = cloneEligibility(pairEligibility);
      if (dropped.length) {
        for (const trip of trips) {
          const set = nextEligibility[trip.id];
          if (!set) continue;
          for (const id of dropped) {
            set.delete(id);
          }
        }
      }
      const summary = dropped.length
        ? `Trimmed ${dropped.length} distant driver${dropped.length > 1 ? 's' : ''} (> ${threshold}km).`
        : 'All remaining drivers are within the proximity band.';
      return { drivers: within, pairEligibility: nextEligibility, summary, droppedDriverIds: dropped };
    },
  },
  {
    id: 'vehicle-specialist',
    name: 'Vehicle Specialist',
    description: 'Respect each trip\'s requested vehicle type.',
    apply: ({ trips, drivers, pairEligibility }) => {
      let blocked = 0;
      const nextEligibility = cloneEligibility(pairEligibility);
      for (const trip of trips) {
        const set = nextEligibility[trip.id] ?? new Set<string>();
        for (const driver of drivers) {
          if (!set.has(driver.id)) continue;
          if (trip.vehiclePreference !== driver.vehicleType) {
            set.delete(driver.id);
            blocked += 1;
          }
        }
        nextEligibility[trip.id] = set;
      }
      const stillEligibleDrivers = drivers.filter((driver) =>
        trips.some((trip) => nextEligibility[trip.id]?.has(driver.id)),
      );
      const summary = blocked
        ? `Blocked ${blocked} pairing${blocked > 1 ? 's' : ''} due to vehicle mismatches.`
        : 'Every driver can satisfy at least one vehicle preference.';
      return {
        drivers: stillEligibleDrivers,
        pairEligibility: nextEligibility,
        summary,
        blockedPairs: blocked,
      };
    },
  },
  {
    id: 'quality-bar',
    name: 'Quality Bar',
    description: 'Keep drivers with rating 4.5 or higher.',
    apply: ({ drivers, pairEligibility, trips }) => {
      const kept = drivers.filter((driver) => driver.rating >= 4.5);
      const dropped = drivers.filter((driver) => driver.rating < 4.5).map((driver) => driver.id);
      const nextEligibility = cloneEligibility(pairEligibility);
      if (dropped.length) {
        for (const trip of trips) {
          const set = nextEligibility[trip.id];
          if (!set) continue;
          for (const id of dropped) {
            set.delete(id);
          }
        }
      }
      const summary = dropped.length
        ? `Filtered ${dropped.length} driver${dropped.length > 1 ? 's' : ''} under the quality bar.`
        : 'All candidates meet the quality threshold.';
      return { drivers: kept, pairEligibility: nextEligibility, summary, droppedDriverIds: dropped };
    },
  },
];
const STRATEGY_LIBRARY: StrategyDefinition[] = [
  {
    id: 'proximity-priority',
    name: 'Proximity Priority',
    description: 'Reward drivers closest to the pickup.',
    weight: (_trip, driver) => 12 - driver.distanceKm * 1.4,
  },
  {
    id: 'rating-bonus',
    name: 'Rating Bonus',
    description: 'Favor consistently high rated drivers.',
    weight: (_trip, driver) => driver.rating * 2,
  },
  {
    id: 'idle-time-balance',
    name: 'Idle Time Balance',
    description: 'Give extra weight to drivers waiting the longest.',
    weight: (_trip, driver) => driver.idleMinutes * 0.8,
  },
  {
    id: 'rider-loyalty',
    name: 'Rider Loyalty',
    description: 'Reward drivers for higher rated riders.',
    weight: (trip, _driver) => trip.riderRating * 1.5,
  },
];

const LARGE_COST = 1_000_000;
function App() {
  const [filtersEnabled, setFiltersEnabled] = useState<Record<string, boolean>>(() => {
    const record: Record<string, boolean> = {};
    for (const filter of FILTER_LIBRARY) {
      record[filter.id] = true;
    }
    return record;
  });

  const [isRunning, setIsRunning] = useState<boolean>(true);

  const [autoMode, setAutoMode] = useState<'auto' | 'manual'>('auto');

  const [strategiesEnabled, setStrategiesEnabled] = useState<Record<string, boolean>>(() => {
    const record: Record<string, boolean> = {};
    for (const strategy of STRATEGY_LIBRARY) {
      record[strategy.id] = true;
    }
    return record;
  });

  const [drivers, setDrivers] = useState<Driver[]>(INITIAL_DRIVERS);
  const [tripQueues, setTripQueues] = useState<Record<string, Trip[]>>(() => {
    const initial: Record<string, Trip[]> = {};
    for (const pool of POOLS) {
      initial[pool.id] = [];
    }
    return initial;
  });
  const [dispatchRuns, setDispatchRuns] = useState<DispatchRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [poolTimers, setPoolTimers] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    const now = Date.now();
    for (const pool of POOLS) {
      initial[pool.id] = now + pool.releaseIntervalMs;
    }
    return initial;
  });
  const [now, setNow] = useState<number>(Date.now());
  const createManualTripDefaults = (poolId: string = POOLS[0].id) => ({
    poolId,
    riderName: randomRiderName(),
    pickup: randomPickupSpot(poolId),
    vehiclePreference: randomVehiclePreference(),
    riderRating: parseFloat((3.6 + Math.random() * 1.3).toFixed(1)),
  });

  const [manualTripForm, setManualTripForm] = useState(() => createManualTripDefaults());

  const manualTripIsValid =
    manualTripForm.riderName.trim().length > 0 && manualTripForm.pickup.trim().length > 0;


  const nextTripId = useRef<number>(1);
  const driversRef = useRef(drivers);
  const filterEnabledRef = useRef(filtersEnabled);
  const strategyEnabledRef = useRef(strategiesEnabled);
  const tripQueuesRef = useRef(tripQueues);
  const isRunningRef = useRef(isRunning);
  useEffect(() => {
    driversRef.current = drivers;
  }, [drivers]);

  useEffect(() => {
    filterEnabledRef.current = filtersEnabled;
  }, [filtersEnabled]);

  useEffect(() => {
    strategyEnabledRef.current = strategiesEnabled;
  }, [strategiesEnabled]);

  useEffect(() => {
    tripQueuesRef.current = tripQueues;
  }, [tripQueues]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const nowStamp = Date.now();
    setNow(nowStamp);
    setPoolTimers(() => {
      const next: Record<string, number> = {};
      for (const pool of POOLS) {
        next[pool.id] = nowStamp + pool.releaseIntervalMs;
      }
      return next;
    });
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(id);
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning || autoMode === 'manual') {
      return;
    }
    const generator = setInterval(() => {
      const pool = weightedPoolPick();
      const newTrip: Trip = {
        id: `t${nextTripId.current++}`,
        poolId: pool.id,
        riderName: randomRiderName(),
        pickup: randomPickupSpot(pool.id),
        riderRating: parseFloat((3.6 + Math.random() * 1.3).toFixed(2)),
        vehiclePreference: randomVehiclePreference(),
        createdAt: Date.now(),
        status: 'queued' as TripStatus,
      };
      setTripQueues((prev) => ({
        ...prev,
        [pool.id]: [...prev[pool.id], newTrip],
      }));
    }, 3600);
    return () => clearInterval(generator);
  }, [isRunning, autoMode]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const timers = POOLS.map((pool) =>
      setInterval(() => {
        releasePool(pool);
      }, pool.releaseIntervalMs),
    );
    return () => {
      for (const timer of timers) {
        clearInterval(timer);
      }
    };
  }, [isRunning]);

  useEffect(() => {
    if (!activeRunId) return;
    const run = dispatchRuns.find((item) => item.id === activeRunId);
    if (!run) return;
    setActiveStepIndex(0);
    const stepCount = run.steps.length;
    if (stepCount <= 1) return;
    let current = 0;
    const timer = setInterval(() => {
      current += 1;
      if (current >= stepCount) {
        clearInterval(timer);
        return;
      }
      setActiveStepIndex(current);
    }, 2400);
    return () => clearInterval(timer);
  }, [activeRunId, dispatchRuns]);
  const releasePool = (pool: Pool) => {
    if (!isRunningRef.current) {
      return;
    }
    const queue = tripQueuesRef.current[pool.id] ?? [];
    if (!queue.length) {
      return;
    }

    const trips = queue.map((trip) => ({ ...trip, status: 'queued' as TripStatus }));
    const filteredDrivers = driversRef.current.filter((driver) => driver.geofences.includes(pool.id));
    const filters = FILTER_LIBRARY.filter((filter) => filterEnabledRef.current[filter.id]);
    const strategies = STRATEGY_LIBRARY.filter((strategy) => strategyEnabledRef.current[strategy.id]);

    const outcome = executeDispatch({
      pool,
      trips,
      drivers: filteredDrivers,
      filters,
      strategies,
      allDrivers: driversRef.current,
    });

    setDrivers(outcome.updatedDrivers);
    setTripQueues((prev) => ({
      ...prev,
      [pool.id]: outcome.unmatchedTrips.map((trip) => ({ ...trip, status: 'returned' as TripStatus })),
    }));
    setDispatchRuns((prev) => [outcome.run, ...prev].slice(0, 6));
    setActiveRunId(outcome.run.id);
    setPoolTimers((prev) => ({
      ...prev,
      [pool.id]: Date.now() + pool.releaseIntervalMs,
    }));
  };

  const activeRun = activeRunId ? dispatchRuns.find((run) => run.id === activeRunId) : dispatchRuns[0];
  const currentStep = activeRun ? activeRun.steps[Math.min(activeStepIndex, activeRun.steps.length - 1)] : undefined;
  const activeStage = currentStep?.stage;

  const toggleSimulation = () => {
    setIsRunning((prev) => !prev);
  };

  const handleManualPoolChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextPoolId = event.target.value;
    setManualTripForm((prev) => ({
      ...prev,
      poolId: nextPoolId,
      pickup: randomPickupSpot(nextPoolId),
    }));
  };

  const handleManualRiderChange = (event: ChangeEvent<HTMLInputElement>) => {
    setManualTripForm((prev) => ({ ...prev, riderName: event.target.value }));
  };

  const handleManualPickupChange = (event: ChangeEvent<HTMLInputElement>) => {
    setManualTripForm((prev) => ({ ...prev, pickup: event.target.value }));
  };

  const handleManualVehicleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setManualTripForm((prev) => ({ ...prev, vehiclePreference: event.target.value as VehicleType }));
  };

  const handleManualRatingChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rating = Number(event.target.value);
    setManualTripForm((prev) => ({ ...prev, riderRating: Number.isNaN(rating) ? prev.riderRating : rating }));
  };

  const randomizeManualTrip = () => {
    setManualTripForm((prev) => createManualTripDefaults(prev.poolId));
  };

  const handleManualTripSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!manualTripIsValid) {
      return;
    }
    const sanitizedRating = Math.min(5, Math.max(1, Number(manualTripForm.riderRating.toFixed(2))));
    const newTrip: Trip = {
      id: `t${nextTripId.current++}`,
      poolId: manualTripForm.poolId,
      riderName: manualTripForm.riderName.trim(),
      pickup: manualTripForm.pickup.trim(),
      riderRating: sanitizedRating,
      vehiclePreference: manualTripForm.vehiclePreference,
      createdAt: Date.now(),
      status: 'queued' as TripStatus,
    };
    setTripQueues((prev) => {
      const existing = prev[manualTripForm.poolId] ?? [];
      return {
        ...prev,
        [manualTripForm.poolId]: [...existing, newTrip],
      };
    });
    setManualTripForm((prev) => createManualTripDefaults(prev.poolId));
  };

  const handleDriverToggle = (driverId: string, onShift: boolean) => {
    setDrivers((prev) =>
      prev.map((driver) => (driver.id === driverId ? { ...driver, onShift } : driver)),
    );
  };

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-content">
          <h1>Dispatch Pipeline Playground</h1>
          <p>
            Watch trips queue inside geo pools, flow through configurable filter funnels, collect strategy weights,
            and get solved with the Hungarian algorithm. Toggle modules to explore different behaviours.
          </p>
          <span className={`hero-state ${isRunning ? 'running' : 'paused'}`}>
            {isRunning ? 'Running' : 'Paused'}
          </span>
        </div>
        <div className="hero-badge">
          <span>Live Simulation</span>
          <span className="dot" />
        </div>
      </header>

      <section className="controls">
        <div className="control-card">
          <h2>Filters</h2>
          <p className="control-caption">Switch filters on/off to simulate domain-specific rules.</p>
          <ul className="toggle-list">
            {FILTER_LIBRARY.map((filter) => (
              <li key={filter.id} className="toggle-item">
                <label>
                  <input
                    type="checkbox"
                    checked={filtersEnabled[filter.id]}
                    onChange={(event) =>
                      setFiltersEnabled((prev) => ({
                        ...prev,
                        [filter.id]: event.target.checked,
                      }))
                    }
                  />
                  <span className="toggle-switch" data-enabled={filtersEnabled[filter.id]} />
                  <div>
                    <span className="toggle-title">{filter.name}</span>
                    <span className="toggle-description">{filter.description}</span>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="control-card">
          <h2>Strategies</h2>
          <p className="control-caption">Combine strategies to change how the solver scores matches.</p>
          <ul className="toggle-list">
            {STRATEGY_LIBRARY.map((strategy) => (
              <li key={strategy.id} className="toggle-item">
                <label>
                  <input
                    type="checkbox"
                    checked={strategiesEnabled[strategy.id]}
                    onChange={(event) =>
                      setStrategiesEnabled((prev) => ({
                        ...prev,
                        [strategy.id]: event.target.checked,
                      }))
                    }
                  />
                  <span className="toggle-switch" data-enabled={strategiesEnabled[strategy.id]} />
                  <div>
                    <span className="toggle-title">{strategy.name}</span>
                    <span className="toggle-description">{strategy.description}</span>
                  </div>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="control-card manual-card">
          <h2>Manual Trips</h2>
          <p className="control-caption">Queue a trip directly into any pool.</p>
          <form className="manual-form" onSubmit={handleManualTripSubmit}>
            <label className="input-field">
              <span>Pool</span>
              <select value={manualTripForm.poolId} onChange={handleManualPoolChange}>
                {POOLS.map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {pool.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="input-field">
              <span>Rider name</span>
              <input value={manualTripForm.riderName} onChange={handleManualRiderChange} placeholder="e.g. Amira" />
            </label>
            <label className="input-field">
              <span>Pickup spot</span>
              <input value={manualTripForm.pickup} onChange={handleManualPickupChange} placeholder="Cross streets or landmark" />
            </label>
            <div className="manual-form-row">
              <label className="input-field">
                <span>Vehicle</span>
                <select value={manualTripForm.vehiclePreference} onChange={handleManualVehicleChange}>
                  <option value="Sedan">Sedan</option>
                  <option value="SUV">SUV</option>
                  <option value="EV">EV</option>
                </select>
              </label>
              <label className="input-field">
                <span>Rider rating</span>
                <input
                  type="number"
                  min="1"
                  max="5"
                  step="0.1"
                  value={manualTripForm.riderRating}
                  onChange={handleManualRatingChange}
                />
              </label>
            </div>
            <div className="manual-actions">
              <button type="submit" className="primary" disabled={!manualTripIsValid}>
                Add Trip
              </button>
              <button type="button" className="secondary" onClick={randomizeManualTrip}>
                Randomise
              </button>
            </div>
          </form>
        </div>
        <div className="control-card driver-card">
          <h2>Driver Availability</h2>
          <p className="control-caption">Toggle who begins on shift in each pool.</p>
          <div className="driver-grid">
            {POOLS.map((pool) => {
              const poolDrivers = drivers.filter((driver) => driver.geofences.includes(pool.id));
              return (
                <div key={pool.id} className="driver-group">
                  <header>
                    <h3>{pool.name}</h3>
                    <span className="driver-count">
                      {poolDrivers.length} driver{poolDrivers.length === 1 ? '' : 's'}
                    </span>
                  </header>
                  <ul>
                    {poolDrivers.map((driver) => (
                      <li key={`${pool.id}-${driver.id}`}>
                        <label>
                          <input
                            type="checkbox"
                            checked={driver.onShift}
                            onChange={(event) => handleDriverToggle(driver.id, event.target.checked)}
                          />
                          <span className="driver-name">{driver.name}</span>
                          <span className="driver-meta">{driver.vehicleType} | {driver.rating.toFixed(2)}</span>
                        </label>
                      </li>
                    ))}
                    {poolDrivers.length === 0 && <li className="driver-empty">No drivers configured.</li>}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      </section>
      <main className="content-grid">
        <section className="pools-panel">
          <h2>Trip Pools</h2>
          <div className="pool-grid">
            {POOLS.map((pool) => {
              const queue = tripQueues[pool.id] ?? [];
              const countdownMs = Math.max(0, (poolTimers[pool.id] ?? 0) - now);
              return (
                <article key={pool.id} className="pool-card" style={{ borderColor: pool.color }}>
                  <header>
                    <h3>{pool.name}</h3>
                    <div className="pool-meta">
                      <span>{queue.length} trip{queue.length === 1 ? '' : 's'} waiting</span>
                      <span>Release in {formatCountdown(countdownMs)}</span>
                    </div>
                  </header>
                  <ul className="trip-list">
                    {queue.length === 0 && <li className="trip-placeholder">Queue is quiet...</li>}
                    {queue.map((trip) => (
                      <li key={trip.id} className={`trip-chip status-${trip.status}`}>
                        <div>
                          <span className="trip-id">{trip.id.toUpperCase()}</span>
                          <span className="trip-rider">{trip.riderName}</span>
                        </div>
                        <div>
                          <span className="trip-meta">{trip.pickup}</span>
                          <span className="trip-meta">{trip.vehiclePreference}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </section>
        <section className="pipeline-panel">
          <h2>Dispatch Pipeline</h2>
          <div className="stage-row">
            {STAGES.map((stage) => (
              <div
                key={stage.id}
                className={`stage-card${activeStage === stage.id ? ' active' : ''}`}
                data-stage={stage.id}
              >
                <span className="stage-label">{stage.label}</span>
                <span className="stage-description">{stage.description}</span>
              </div>
            ))}
          </div>
          <div className="step-explainer">
            {currentStep ? (
              <>
                <h3>{currentStep.title}</h3>
                <p>{currentStep.detail}</p>
                {renderStepMeta(currentStep)}
              </>
            ) : (
              <p className="step-placeholder">The system is warming up...</p>
            )}
          </div>
        </section>
        <section className="timeline-panel">
          <h2>Recent Dispatches</h2>
          <ul className="timeline-list">
            {dispatchRuns.length === 0 && <li className="timeline-placeholder">No dispatch cycles yet.</li>}
            {dispatchRuns.map((run) => (
              <li key={run.id} className={`timeline-item${run.id === activeRunId ? ' active' : ''}`}>
                <header>
                  <span className="timeline-title">{run.pool.name}</span>
                  <span className="timeline-time">{timeAgo(run.timestamp)}</span>
                </header>
                <p className="timeline-headline">{run.headline}</p>
                <div className="timeline-metrics">
                  <span>
                    ✓ {run.assignments.filter((assignment) => assignment.accepted).length} matched
                  </span>
                  <span>
                    ↺ {run.unmatchedTrips.length}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <div
        className={`floating-toggle ${isRunning ? 'running' : 'paused'}`}
        aria-live="polite"
      >
        <div className="floating-mode">
          <span className="floating-label">Trip intake</span>
          <div className="floating-segment">
            <button
              type="button"
              className={`segment${autoMode === 'auto' ? ' active' : ''}`}
              onClick={() => setAutoMode('auto')}
              aria-pressed={autoMode === 'auto'}
            >
              Auto
            </button>
            <button
              type="button"
              className={`segment${autoMode === 'manual' ? ' active' : ''}`}
              onClick={() => setAutoMode('manual')}
              aria-pressed={autoMode === 'manual'}
            >
              Manual
            </button>
          </div>
        </div>
        <button
          type="button"
          className="hero-toggle"
          onClick={toggleSimulation}
          aria-pressed={!isRunning}
        >
          {isRunning ? 'Pause Simulation' : 'Resume Simulation'}
        </button>
        <span className="floating-status">
          {isRunning ? 'Pipeline running' : 'Pipeline paused'} - {autoMode === 'auto' ? 'auto intake' : 'manual intake'}
        </span>
      </div>

    </div>
  );
}
function executeDispatch(args: {
  pool: Pool;
  trips: Trip[];
  drivers: Driver[];
  filters: FilterDefinition[];
  strategies: StrategyDefinition[];
  allDrivers: Driver[];
}): DispatchOutcome {
  const { pool, trips, drivers, filters, strategies, allDrivers } = args;
  const runId = `run-${pool.id}-${Date.now()}`;
  const steps: DispatchStep[] = [];

  steps.push({
    id: 'release',
    stage: 'pool',
    title: `${pool.name} released ${trips.length} trip${trips.length === 1 ? '' : 's'}.`,
    detail: 'Trips exit the holding pool and enter orchestration.',
    meta: { tripIds: trips.map((trip) => trip.id) },
  });

  const initialCandidates = [...drivers];
  steps.push({
    id: 'candidates',
    stage: 'filters',
    title: 'Initial candidate pool assembled.',
    detail: `Found ${initialCandidates.length} driver${initialCandidates.length === 1 ? '' : 's'} inside the geo fence.`,
    meta: { type: 'candidates', names: initialCandidates.map((driver) => driver.name) },
  });

  let candidateDrivers = initialCandidates;
  let pairEligibility = makeInitialEligibility(trips, candidateDrivers);

  for (const filter of filters) {
    const result = filter.apply({ trips, drivers: candidateDrivers, pool, pairEligibility });
    candidateDrivers = result.drivers;
    pairEligibility = result.pairEligibility;
    steps.push({
      id: `filter-${filter.id}`,
      stage: 'filters',
      title: filter.name,
      detail: result.summary,
      meta: {
        type: 'filter',
        removed: result.droppedDriverIds,
        blockedPairs: result.blockedPairs,
      },
    });
  }

  candidateDrivers = candidateDrivers.filter((driver) =>
    trips.some((trip) => pairEligibility[trip.id]?.has(driver.id)),
  );

  if (!candidateDrivers.length) {
    const fallbackRun = buildFallbackRun({
      pool,
      trips,
      runId,
      steps,
    });
    return {
      run: fallbackRun,
      updatedDrivers: bumpDriversIdle(allDrivers),
      unmatchedTrips: trips,
    };
  }

  const activeStrategies = strategies;
  steps.push({
    id: 'strategies',
    stage: 'strategy',
    title: activeStrategies.length ? 'Strategy stack loaded.' : 'Default strategy engaged.',
    detail: activeStrategies.length
      ? `Scoring powered by ${activeStrategies.length} active strateg${activeStrategies.length === 1 ? 'y' : 'ies'}.`
      : 'No custom strategies enabled, fallback to proximity + rating blend.',
    meta: {
      type: 'strategies',
      names: activeStrategies.map((strategy) => strategy.name),
    },
  });
  const scoreInfo = buildScoreMatrix(trips, candidateDrivers, pairEligibility, activeStrategies);
  steps.push({
    id: 'score-snapshot',
    stage: 'strategy',
    title: 'Scoring matrix ready.',
    detail: 'Top weighted pairs bubble to the top before solving.',
    meta: {
      type: 'scores',
      highlights: scoreInfo.highlights,
    },
  });

  const assignmentIndexes = hungarianAlgorithm(scoreInfo.costMatrix);
  const assignments: Assignment[] = [];
  const unmatchedTrips: Trip[] = [];

  for (let row = 0; row < trips.length; row += 1) {
    const driverIndex = assignmentIndexes[row];
    const trip = trips[row];
    if (driverIndex == null || driverIndex >= candidateDrivers.length) {
      unmatchedTrips.push(trip);
      assignments.push({ trip });
      continue;
    }
    const score = scoreInfo.scoreMatrix[row]?.[driverIndex];
    if (score === undefined || score === -Infinity) {
      unmatchedTrips.push(trip);
      assignments.push({ trip });
      continue;
    }
    const driver = candidateDrivers[driverIndex];
    assignments.push({ trip, driver, score });
  }

  const withAcceptance = assignments.map((assignment) => {
    if (!assignment.driver) {
      return { ...assignment, accepted: false };
    }
    const acceptanceChance = 0.78 + Math.random() * 0.18;
    const accepted = Math.random() < acceptanceChance;
    if (!accepted) {
      unmatchedTrips.push(assignment.trip);
    }
    return { ...assignment, accepted, rejection: !accepted };
  });

  steps.push({
    id: 'hungarian',
    stage: 'solver',
    title: 'Hungarian algorithm solved the matrix.',
    detail: 'Assignments chosen to minimize the global cost.',
    meta: {
      type: 'solver',
      assignments: withAcceptance,
    },
  });

  const successfulMatches = withAcceptance.filter((assignment) => assignment.accepted && assignment.driver);
  const rejectionCount = withAcceptance.filter((assignment) => assignment.rejection).length;

  steps.push({
    id: 'outcome',
    stage: 'outcome',
    title: `${successfulMatches.length} trip${successfulMatches.length === 1 ? '' : 's'} matched, ${unmatchedTrips.length} pending retry.`,
    detail: rejectionCount
      ? `${rejectionCount} driver${rejectionCount === 1 ? '' : 's'} declined, sending trips back to the pool.`
      : 'All accepted trips leave the pool while unmatched trips retry on the next release.',
    meta: {
      type: 'outcome',
      unmatched: unmatchedTrips.map((trip) => trip.id),
    },
  });

  const updatedDrivers = updateDriversAfterDispatch({
    allDrivers,
    assignments: withAcceptance,
  });

  const headline = successfulMatches.length
    ? `${successfulMatches.length} match${successfulMatches.length === 1 ? '' : 'es'} secured.`
    : 'No matches - everything returns to the pool.';

  const run: DispatchRun = {
    id: runId,
    pool,
    timestamp: Date.now(),
    steps,
    assignments: withAcceptance,
    unmatchedTrips,
    headline,
  };

  return { run, updatedDrivers, unmatchedTrips };
}
function buildFallbackRun(args: { pool: Pool; trips: Trip[]; runId: string; steps: DispatchStep[] }): DispatchRun {
  const { pool, trips, runId, steps } = args;
  steps.push({
    id: 'no-candidates',
    stage: 'outcome',
    title: 'No candidates left after filtering.',
    detail: 'Trips will wait for the next cycle while drivers become available.',
    meta: {
      type: 'outcome',
      unmatched: trips.map((trip) => trip.id),
    },
  });
  return {
    id: runId,
    pool,
    timestamp: Date.now(),
    steps,
    assignments: trips.map((trip) => ({ trip, accepted: false })),
    unmatchedTrips: trips,
    headline: 'Filters eliminated every candidate - nothing dispatched.',
  };
}
function buildScoreMatrix(
  trips: Trip[],
  drivers: Driver[],
  pairEligibility: PairEligibility,
  strategies: StrategyDefinition[],
): {
  scoreMatrix: number[][];
  costMatrix: number[][];
  highlights: { pair: string; score: number }[];
} {
  const scoreMatrix: number[][] = [];
  const highlights: { pair: string; score: number }[] = [];
  let maxScore = 0;

  for (const trip of trips) {
    const row: number[] = [];
    for (const driver of drivers) {
      const eligible = pairEligibility[trip.id]?.has(driver.id);
      if (!eligible) {
        row.push(-Infinity);
        continue;
      }
      let score = 0;
      if (strategies.length === 0) {
        score = 8 - driver.distanceKm + driver.rating;
      } else {
        for (const strategy of strategies) {
          score += strategy.weight(trip, driver);
        }
      }
      score = parseFloat(score.toFixed(2));
      highlights.push({ pair: `${trip.id.toUpperCase()} -> ${driver.name}`, score });
      maxScore = Math.max(maxScore, score);
      row.push(score);
    }
    scoreMatrix.push(row);
  }

  highlights.sort((a, b) => b.score - a.score);

  const effectiveMax = maxScore === 0 ? 1 : maxScore;
  const costMatrix = scoreMatrix.map((row) =>
    row.map((value) => {
      if (value === -Infinity) {
        return LARGE_COST;
      }
      return parseFloat((effectiveMax - value + 1).toFixed(4));
    }),
  );

  return {
    scoreMatrix,
    costMatrix,
    highlights: highlights.slice(0, 4),
  };
}
function hungarianAlgorithm(inputCostMatrix: number[][]): number[] {
  const rows = inputCostMatrix.length;
  const cols = inputCostMatrix[0]?.length ?? 0;
  if (rows === 0 || cols === 0) {
    return [];
  }
  const size = Math.max(rows, cols);
  const matrix = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => {
      if (row < rows && col < cols) {
        return inputCostMatrix[row][col];
      }
      return LARGE_COST;
    }),
  );

  const mask = Array.from({ length: size }, () => Array<number>(size).fill(0));
  const rowCover = Array<boolean>(size).fill(false);
  const colCover = Array<boolean>(size).fill(false);

  // Step 1: Subtract row minima
  for (let row = 0; row < size; row += 1) {
    const min = Math.min(...matrix[row]);
    for (let col = 0; col < size; col += 1) {
      matrix[row][col] -= min;
    }
  }

  // Step 2: Subtract column minima
  for (let col = 0; col < size; col += 1) {
    let min = Number.POSITIVE_INFINITY;
    for (let row = 0; row < size; row += 1) {
      min = Math.min(min, matrix[row][col]);
    }
    for (let row = 0; row < size; row += 1) {
      matrix[row][col] -= min;
    }
  }

  // Step 3: Star zeros
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (matrix[row][col] === 0 && !rowCover[row] && !colCover[col]) {
        mask[row][col] = 1; // Star
        rowCover[row] = true;
        colCover[col] = true;
      }
    }
  }
  rowCover.fill(false);
  colCover.fill(false);

  let step = 4;
  let done = false;

  while (!done) {
    switch (step) {
      case 4: {
        for (let row = 0; row < size; row += 1) {
          for (let col = 0; col < size; col += 1) {
            if (mask[row][col] === 1) {
              colCover[col] = true;
            }
          }
        }
        const coveredCols = colCover.filter(Boolean).length;
        if (coveredCols >= rows || coveredCols >= cols) {
          step = 7;
        } else {
          step = 5;
        }
        break;
      }
      case 5: {
        const zero = findUncoveredZero(matrix, rowCover, colCover);
        if (!zero) {
          step = 6;
          break;
        }
        const [row, col] = zero;
        mask[row][col] = 2; // Prime
        const starCol = mask[row].findIndex((value) => value === 1);
        if (starCol !== -1) {
          rowCover[row] = true;
          colCover[starCol] = false;
        } else {
          augmentPath(mask, row, col);
          rowCover.fill(false);
          colCover.fill(false);
          clearPrimes(mask);
          step = 4;
        }
        break;
      }
      case 6: {
        const min = findSmallestUncovered(matrix, rowCover, colCover);
        for (let row = 0; row < size; row += 1) {
          for (let col = 0; col < size; col += 1) {
            if (rowCover[row]) {
              matrix[row][col] += min;
            }
            if (!colCover[col]) {
              matrix[row][col] -= min;
            }
          }
        }
        step = 5;
        break;
      }
      case 7: {
        done = true;
        break;
      }
      default:
        done = true;
        break;
    }
  }

  const assignments: number[] = Array(rows).fill(-1);
  for (let row = 0; row < rows; row += 1) {
    const col = mask[row].findIndex((value) => value === 1);
    assignments[row] = col === -1 || col >= cols ? -1 : col;
  }

  return assignments;
}
function findUncoveredZero(
  matrix: number[][],
  rowCover: boolean[],
  colCover: boolean[],
): [number, number] | null {
  for (let row = 0; row < matrix.length; row += 1) {
    if (rowCover[row]) continue;
    for (let col = 0; col < matrix.length; col += 1) {
      if (colCover[col]) continue;
      if (matrix[row][col] === 0) {
        return [row, col];
      }
    }
  }
  return null;
}

function augmentPath(mask: number[][], row: number, col: number) {
  const path: Array<[number, number]> = [[row, col]];
  let done = false;
  while (!done) {
    const starRow = findStarInColumn(mask, path[path.length - 1][1]);
    if (starRow !== -1) {
      path.push([starRow, path[path.length - 1][1]]);
      const primeCol = findPrimeInRow(mask, starRow);
      path.push([starRow, primeCol]);
    } else {
      done = true;
    }
  }
  for (const [r, c] of path) {
    if (mask[r][c] === 1) {
      mask[r][c] = 0;
    } else if (mask[r][c] === 2) {
      mask[r][c] = 1;
    }
  }
}

function findStarInColumn(mask: number[][], col: number): number {
  for (let row = 0; row < mask.length; row += 1) {
    if (mask[row][col] === 1) {
      return row;
    }
  }
  return -1;
}

function findPrimeInRow(mask: number[][], row: number): number {
  for (let col = 0; col < mask.length; col += 1) {
    if (mask[row][col] === 2) {
      return col;
    }
  }
  return -1;
}

function clearPrimes(mask: number[][]) {
  for (let row = 0; row < mask.length; row += 1) {
    for (let col = 0; col < mask.length; col += 1) {
      if (mask[row][col] === 2) {
        mask[row][col] = 0;
      }
    }
  }
}

function findSmallestUncovered(
  matrix: number[][],
  rowCover: boolean[],
  colCover: boolean[],
): number {
  let min = Number.POSITIVE_INFINITY;
  for (let row = 0; row < matrix.length; row += 1) {
    if (rowCover[row]) continue;
    for (let col = 0; col < matrix.length; col += 1) {
      if (!colCover[col] && matrix[row][col] < min) {
        min = matrix[row][col];
      }
    }
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}
function updateDriversAfterDispatch(args: { allDrivers: Driver[]; assignments: Assignment[] }): Driver[] {
  const { allDrivers, assignments } = args;
  return allDrivers.map((driver) => {
    const match = assignments.find(
      (assignment) => assignment.accepted && assignment.driver && assignment.driver.id === driver.id,
    );
    if (match) {
      return {
        ...driver,
        idleMinutes: 0,
        distanceKm: parseFloat(randomBetween(0.6, 2.1).toFixed(1)),
        onShift: true,
      };
    }
    const delta = randomBetween(-0.4, 0.8);
    const distanceKm = Math.max(0.5, parseFloat((driver.distanceKm + delta).toFixed(1)));
    const idleMinutes = Math.min(16, parseFloat((driver.idleMinutes + randomBetween(0.8, 1.6)).toFixed(1)));
    let onShift = driver.onShift;
    if (driver.onShift && idleMinutes > 12 && Math.random() < 0.08) {
      onShift = false;
    } else if (!driver.onShift && Math.random() < 0.3) {
      onShift = true;
    }
    return {
      ...driver,
      distanceKm,
      idleMinutes,
      onShift,
    };
  });
}

function bumpDriversIdle(drivers: Driver[]): Driver[] {
  return drivers.map((driver) => ({
    ...driver,
    idleMinutes: Math.min(16, parseFloat((driver.idleMinutes + randomBetween(0.8, 1.6)).toFixed(1))),
  }));
}

function makeInitialEligibility(trips: Trip[], drivers: Driver[]): PairEligibility {
  const eligibility: PairEligibility = {};
  for (const trip of trips) {
    eligibility[trip.id] = new Set(drivers.map((driver) => driver.id));
  }
  return eligibility;
}

function cloneEligibility(source: PairEligibility): PairEligibility {
  const clone: PairEligibility = {};
  for (const [tripId, set] of Object.entries(source)) {
    clone[tripId] = new Set(set);
  }
  return clone;
}
function renderStepMeta(step: DispatchStep) {
  if (!step.meta) return null;
  switch (step.meta.type) {
    case 'candidates': {
      const names = step.meta.names as string[];
      return (
        <ul className="meta-list">
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      );
    }
    case 'filter': {
      const removed = (step.meta.removed as string[] | undefined)?.length ?? 0;
      const blockedPairs = (step.meta.blockedPairs as number | undefined) ?? 0;
      return (
        <div className="meta-grid">
          <span>{removed} driver{removed === 1 ? '' : 's'} trimmed</span>
          <span>{blockedPairs} pair{blockedPairs === 1 ? '' : 's'} blocked</span>
        </div>
      );
    }
    case 'strategies': {
      const names = step.meta.names as string[];
      return (
        <ul className="meta-list">
          {names.length ? names.map((name) => <li key={name}>{name}</li>) : <li>Default weighting</li>}
        </ul>
      );
    }
    case 'scores': {
      const highlights = (step.meta.highlights as { pair: string; score: number }[]) ?? [];
      return (
        <ul className="meta-list">
          {highlights.map((item) => (
            <li key={item.pair}>
              {item.pair}
              <span className="meta-tag">{item.score.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      );
    }
    case 'solver': {
      const assignments = (step.meta.assignments as Assignment[]) ?? [];
      return (
        <ul className="meta-list">
          {assignments.map((assignment) => (
            <li key={assignment.trip.id}>
              {assignment.trip.id.toUpperCase()} {'-> '}
              {assignment.driver ? assignment.driver.name : '—'}
              {assignment.accepted === false ? <span className="meta-tag warning">retry</span> : null}
            </li>
          ))}
        </ul>
      );
    }
    case 'outcome': {
      const unmatched = (step.meta.unmatched as string[]) ?? [];
      return unmatched.length ? (
        <div className="meta-grid">
          <span>Back to pool:</span>
          <span>{unmatched.join(', ').toUpperCase()}</span>
        </div>
      ) : null;
    }
    default:
      return null;
  }
}
function weightedPoolPick(): Pool {
  const random = Math.random();
  return random < 0.55 ? POOLS[0] : POOLS[1];
}

function randomRiderName(): string {
  const names = ['Laila', 'Omar', 'Sofia', 'Jon', 'Noor', 'Zara', 'Malik', 'Emily', 'Kai', 'Hana'];
  return names[Math.floor(Math.random() * names.length)];
}

function randomPickupSpot(poolId: string): string {
  const downtown = ['5th & Pine', 'Union Square', 'Metro Hub', 'Harbor Gate'];
  const uptown = ['Hilltop Plaza', 'Ridge Ave', 'Aurora Mall', 'Lakeside'];
  const source = poolId === 'downtown' ? downtown : uptown;
  return source[Math.floor(Math.random() * source.length)];
}

function randomVehiclePreference(): VehicleType {
  const options: VehicleType[] = ['Sedan', 'SUV', 'EV'];
  return options[Math.floor(Math.random() * options.length)];
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${seconds}s`;
}

function timeAgo(timestamp: number): string {
  const deltaSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) {
    return `${deltaSeconds}s ago`;
  }
  const minutes = Math.floor(deltaSeconds / 60);
  return `${minutes}m ago`;
}

export default App;

