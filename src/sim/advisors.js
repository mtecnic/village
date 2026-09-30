/*
 * VOXELPOLIS — advisors, news ticker, milestones, achievements. STUB — replaced by the econ/events agent.
 * Contract: docs/ARCHITECTURE.md §VC.advisors.
 */
VC.advisors = {
  inbox: [],
  news: [],
  init() {},
  reset(S) { this.inbox = []; this.news = []; },
  messages() { return this.inbox; },
  markRead(id) {},
  advice(key) { return ''; },
  achievements() { return []; },
};
