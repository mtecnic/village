/*
 * VOXELPOLIS — simulation core. STUB — the sim agent replaces this file.
 * Contract: see docs/ARCHITECTURE.md §VC.sim.
 */
const C = VC.C;
VC.sim = {
  _acc: 0,
  init() {},
  reset(S) { this._acc = 0; },
  update(dt, rdt) {
    const S = VC.state;
    if (!S || !S.time.speed) return;
    this._acc += (rdt * C.SPEEDS[S.time.speed]) / C.DAY_SEC;
    let n = 0;
    while (this._acc >= 1 && n++ < 8) { this._acc -= 1; this.tickDay(); }
  },
  tickDay() {
    const S = VC.state;
    S.time.day++;
    VC.bus.emit('day', S.time.day);
    if (S.time.day % C.DAYS_PER_MONTH === 0) {
      const m = Math.floor(S.time.day / C.DAYS_PER_MONTH) % 12;
      VC.bus.emit('month', { month: m, year: C.START_YEAR + Math.floor(S.time.day / (C.DAYS_PER_MONTH * 12)) });
      if (m === 0) VC.bus.emit('year', C.START_YEAR + Math.floor(S.time.day / (C.DAYS_PER_MONTH * 12)));
    }
  },
  ignite(b) { b.fire = 1; VC.world.changed(b); },
  extinguish(b) { b.fire = 0; VC.world.changed(b); },
  recalcNetworks() {},
  tileInfo(x, z) { return {}; },
  buildingInfo(b) { return { name: this.buildingName(b), lines: [], problems: [] }; },
  buildingName(b) { return b.key === 'grow' ? VC.ZONES[b.zt].name + ' building' : (VC.BLD[b.key] || {}).name || b.key; },
  demandFactors() { return { R: [], C: [], I: [] }; },
  powerInfo() { return { supply: 0, demand: 0, plants: [] }; },
  waterInfo() { return { supply: 0, demand: 0, sources: [] }; },
  serviceStats() { return {}; },
};
