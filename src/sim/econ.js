/*
 * VOXELPOLIS — economy: taxes, budget, policies, loans, monthly finances, history.
 * STUB — the econ agent replaces this file. Contract: docs/ARCHITECTURE.md §VC.econ.
 */
VC.econ = {
  init() {},
  reset(S) {},
  setTax(zone, wealth, pct) { const t = VC.state.tax[zone]; if (wealth == null) t.fill(pct); else t[wealth] = pct; VC.bus.emit('budgetChanged'); },
  getTax(zone, wealth = 1) { return VC.state.tax[zone][wealth]; },
  setFunding(dept, f) { VC.state.budget[dept] = f; VC.bus.emit('budgetChanged'); },
  effectiveness(dept) { const f = VC.state ? VC.state.budget[dept] : 1; return f == null ? 1 : f; },
  setPolicy(key, on) { VC.state.policies[key] = !!on; if (!on) delete VC.state.policies[key]; VC.bus.emit('policyChanged', key); return true; },
  policyCost(key) { return 0; },
  loanOptions() { return []; },
  takeLoan(amount) { return false; },
  repayLoan(i) { return false; },
  deptUpkeep(dept) { return 0; },
  forecast() { return { income: {}, expenses: {}, totalIncome: 0, totalExpenses: 0, net: 0 }; },
  computeMods() {},
  taxEffect(zone) { return 0; },
};
