// Shared helpers: scoping (data isolation), month math, audit logging.

const REASON_CODES = [
  'Creative fatigue', 'Budget delay', 'Account ban', 'Landing page issue',
  'Offer paused', 'Compliance/Policy', 'Tracking issue', 'Low bids', 'Other',
];

function nowIso() { return new Date().toISOString(); }

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function validMonth(m) { return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m); }

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---- Scoping: the ONLY source of truth for who can see whom. ----
function subtreeIds(db, user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT id FROM users').all().map((r) => r.id);
  }
  if (user.role === 'manager') {
    const leaders = db.prepare('SELECT id FROM users WHERE manager_id = ?').all(user.id).map((r) => r.id);
    let members = [];
    if (leaders.length) {
      const ph = leaders.map(() => '?').join(',');
      members = db.prepare(`SELECT id FROM users WHERE leader_id IN (${ph})`).all(...leaders).map((r) => r.id);
    }
    return [user.id, ...leaders, ...members];
  }
  if (user.role === 'leader') {
    const members = db.prepare('SELECT id FROM users WHERE leader_id = ?').all(user.id).map((r) => r.id);
    return [user.id, ...members];
  }
  return [user.id];
}

function canView(db, actor, targetUserId) {
  return subtreeIds(db, actor).includes(Number(targetUserId));
}

function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ---- Months ----
function getMonthRow(db, userId, month, create = false) {
  let row = db.prepare('SELECT * FROM months WHERE user_id = ? AND month = ?').get(userId, month);
  if (!row && create) {
    db.prepare(
      'INSERT INTO months (user_id, month, weekly, meetings, updated_at) VALUES (?,?,?,?,?)'
    ).run(userId, month, '[]', '[]', nowIso());
    row = db.prepare('SELECT * FROM months WHERE user_id = ? AND month = ?').get(userId, month);
  }
  if (row) {
    row.weekly = safeJson(row.weekly, []);
    row.meetings = safeJson(row.meetings, []);
  }
  return row;
}

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch { return fallback; }
}

function saveMonthJson(db, row) {
  db.prepare('UPDATE months SET weekly = ?, meetings = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(row.weekly), JSON.stringify(row.meetings), nowIso(), row.id);
}

// Derived metrics for one user-month.
function computeMonth(row) {
  const empty = {
    spend: 0, revenue: 0, profit: 0, weeksFilled: 0, weeklySpendTarget: 0,
    pacingPct: 0, revPct: 0, profitPct: 0, budgetPct: 0, roas: 0, marginPct: 0,
    forecast: { spend: 0, revenue: 0, profit: 0 }, score: 0, status: 'no_goals',
  };
  if (!row) return empty;

  const weeks = Math.max(1, row.weeks || 4);
  const weekly = Array.isArray(row.weekly) ? row.weekly : [];
  const filled = weekly.filter((w) => w && typeof w === 'object');
  const weeksFilled = filled.length;
  const spend = filled.reduce((s, w) => s + num(w.spend), 0);
  const revenue = filled.reduce((s, w) => s + num(w.revenue), 0);
  const profit = filled.reduce((s, w) => s + num(w.profit), 0);

  const weeklySpendTarget = row.goal_spend > 0 ? row.goal_spend / weeks : 0;
  const pacingPct = weeklySpendTarget > 0 && weeksFilled > 0
    ? (spend / (weeklySpendTarget * weeksFilled)) * 100 : 0;
  const revPct = row.goal_revenue > 0 ? (revenue / row.goal_revenue) * 100 : 0;
  const profitPct = row.goal_profit > 0 ? (profit / row.goal_profit) * 100 : 0;
  const budgetPct = row.goal_spend > 0 ? Math.min((spend / row.goal_spend) * 100, 100) : 0;
  const roas = spend > 0 ? revenue / spend : 0;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  const forecast = weeksFilled > 0
    ? {
        spend: (spend / weeksFilled) * weeks,
        revenue: (revenue / weeksFilled) * weeks,
        profit: (profit / weeksFilled) * weeks,
      }
    : { spend: 0, revenue: 0, profit: 0 };

  // Composite score: avg of revenue %, profit %, budget delivery %.
  const score = (revPct + profitPct + budgetPct) / 3;

  // Status
  const hasGoal = row.goal_status === 'approved' && (row.goal_revenue > 0 || row.goal_spend > 0);
  let status;
  if (!hasGoal) status = 'no_goals';
  else if (weeksFilled === 0) status = 'not_started';
  else if (revPct >= 100) status = 'achieved';
  else if (row.month < currentMonth()) status = 'missed';
  else {
    const expectedToDate = row.goal_revenue * (weeksFilled / weeks);
    status = expectedToDate > 0 && revenue >= 0.9 * expectedToDate ? 'on_track' : 'behind';
  }

  return {
    spend, revenue, profit, weeksFilled, weeklySpendTarget,
    pacingPct, revPct, profitPct, budgetPct, roas, marginPct, forecast, score, status,
  };
}

// Aggregate several month rows into one card (used by overview board).
function aggregateRows(rows, month) {
  const agg = {
    goal_spend: 0, goal_revenue: 0, goal_profit: 0,
    spend: 0, revenue: 0, profit: 0, weeksFilled: 0, withGoals: 0, people: rows.length,
  };
  let maxWeeksFilled = 0;
  for (const row of rows) {
    if (!row) continue;
    const m = computeMonth(row);
    if (row.goal_status === 'approved') {
      agg.goal_spend += num(row.goal_spend);
      agg.goal_revenue += num(row.goal_revenue);
      agg.goal_profit += num(row.goal_profit);
      agg.withGoals += 1;
    }
    agg.spend += m.spend;
    agg.revenue += m.revenue;
    agg.profit += m.profit;
    maxWeeksFilled = Math.max(maxWeeksFilled, m.weeksFilled);
  }
  agg.weeksFilled = maxWeeksFilled;
  agg.revPct = agg.goal_revenue > 0 ? (agg.revenue / agg.goal_revenue) * 100 : 0;
  agg.roas = agg.spend > 0 ? agg.revenue / agg.spend : 0;

  if (agg.withGoals === 0) agg.status = 'no_goals';
  else if (agg.weeksFilled === 0) agg.status = 'not_started';
  else if (agg.revPct >= 100) agg.status = 'achieved';
  else if (month < currentMonth()) agg.status = 'missed';
  else agg.status = agg.revPct >= 90 * (agg.weeksFilled / 4) ? 'on_track' : 'behind';
  return agg;
}

function audit(db, actor, action, targetUser = null, month = null, detail = '') {
  db.prepare(
    'INSERT INTO audit (ts, actor_id, actor_name, action, target_user, month, detail) VALUES (?,?,?,?,?,?,?)'
  ).run(nowIso(), actor ? actor.id : null, actor ? actor.name : 'system', action, targetUser, month, String(detail || ''));
}

module.exports = {
  REASON_CODES, nowIso, currentMonth, validMonth, num,
  subtreeIds, canView, getUser, getMonthRow, saveMonthJson,
  computeMonth, aggregateRows, audit,
};
