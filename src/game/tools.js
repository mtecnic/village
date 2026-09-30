/*
 * VOXELPOLIS — tool state & previews. STUB — replaced by the tools agent.
 * Contract: docs/ARCHITECTURE.md §VC.tools.
 */
VC.tools = {
  current: 'select',
  hover: null,
  selectedId: 0,
  rotation: 0,
  init() {},
  reset(S) { this.current = 'select'; this.selectedId = 0; },
  update(dt, rdt) {},
  select(key) { this.current = key; VC.bus.emit('tool', { key }); },
  gridAlpha() { return 0; },
  list(group) { return []; },
  info(key) { return null; },
};
