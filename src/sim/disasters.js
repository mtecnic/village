/*
 * VOXELPOLIS — disasters (logic). STUB — the econ/events agent replaces this file.
 * Contract: docs/ARCHITECTURE.md §VC.disasters.
 */
VC.disasters = {
  TYPES: [
    { key: 'fire', name: 'Fire', icon: '🔥' },
    { key: 'tornado', name: 'Tornado', icon: '🌪️' },
    { key: 'meteor', name: 'Meteor Strike', icon: '☄️' },
    { key: 'earthquake', name: 'Earthquake', icon: '🌋' },
    { key: 'ufo', name: 'UFO Invasion', icon: '🛸' },
    { key: 'monster', name: 'Cubezilla', icon: '🦖' },
  ],
  active: [],
  init() {},
  reset(S) { this.active = []; },
  update(dt, rdt) {},
  trigger(type, x, z) { return false; },
};
