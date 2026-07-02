// All authenticated API routes. Every endpoint enforces authorization server-side.
const express = require('express');
const bcrypt = require('bcryptjs');
const { publicUser } = require('./auth');
const H = require('./helpers');

module.exports = function apiRouter(db) {
  const r = express.Router();

  const forbidden = (res, msg = 'Forbidden') => res.status(403).json({ error: msg });
  const notFound = (res, msg = 'Not found') => res.status(404).json({ error: msg });
  const bad = (res, msg) => res.status(400).json({ error: msg });

  // Resolve + authorize a :userId/:month pair. Attaches req.target, req.month.
  function targetMonth(req, res, next) {
    const uid = Number(req.params.userId);
    const month = req.params.month;
    if (!Number.isInteger(uid) || !H.validMonth(month)) return bad(res, 'Invalid user or month');
    if (!H.canView(db, req.user, uid)) return forbidden(res);
    const target = H.getUser(db, uid);
    if (!target) return notFound(res, 'User not found');
    req.target = target;
    req.month = month;
    next();
  }

  // ---------- session ----------
  r.get('/me', (req, res) => res.json({ user: publicUser(req.user), reasonCodes: H.REASON_CODES }));

  r.post('/password', (req, res) => {
    const { old_password, new_password } = req.body || {};
    if (!new_password || String(new_password).length < 6) return bad(res, 'New password must be at least 6 characters');
    if (!bcrypt.compareSync(String(old_password || ''), req.user.password_hash)) {
      return bad(res, 'Current password is incorrect');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(bcrypt.hashSync(String(new_password), 10), req.user.id);
    H.audit(db, req.user, 'password_change', req.user.id);
    res.json({ ok: true });
  });

  // ---------- users ----------
  r.get('/users', (req, res) => {
    const ids = H.subtreeIds(db, req.user);
    const ph = ids.map(() => '?').join(',');
    const users = db.prepare(`SELECT * FROM users WHERE id IN (${ph}) ORDER BY role, name`).all(...ids);
    res.json({ users: users.map(publicUser) });
  });

  r.post('/users', (req, res) => {
    const actor = req.user;
    const { username, password, name, role, vertical } = req.body || {};
    let { leader_id, manager_id } = req.body || {};

    if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return bad(res, 'Username: 3-32 chars, letters/numbers/._-');
    if (!password || String(password).length < 6) return bad(res, 'Password must be at least 6 characters');
    if (!name || !String(name).trim()) return bad(res, 'Name required');
    if (!['admin', 'manager', 'leader', 'member'].includes(role)) return bad(res, 'Invalid role');

    // Delegated creation rules
    if (actor.role === 'member') return forbidden(res);
    if (actor.role === 'leader') {
      if (role !== 'member') return forbidden(res, 'Leaders can only create members');
      leader_id = actor.id; // auto-assign under this leader
      manager_id = null;
    } else if (actor.role === 'manager') {
      if (role === 'leader') {
        manager_id = actor.id; // auto-assign under this manager
        leader_id = null;
      } else if (role === 'member') {
        const lid = Number(leader_id);
        const myLeaders = db.prepare('SELECT id FROM users WHERE manager_id = ? AND role = ?').all(actor.id, 'leader').map((x) => x.id);
        if (!myLeaders.includes(lid)) return forbidden(res, 'Pick one of your own leaders for this member');
        leader_id = lid;
        manager_id = null;
      } else {
        return forbidden(res, 'Managers can only create leaders and members');
      }
    } else {
      // admin: validate optional links
      leader_id = leader_id ? Number(leader_id) : null;
      manager_id = manager_id ? Number(manager_id) : null;
      if (role === 'member' && leader_id) {
        const l = H.getUser(db, leader_id);
        if (!l || l.role !== 'leader') return bad(res, 'leader_id must be a leader');
      }
      if (role === 'leader' && manager_id) {
        const m = H.getUser(db, manager_id);
        if (!m || m.role !== 'manager') return bad(res, 'manager_id must be a manager');
      }
      if (role !== 'member') leader_id = role === 'member' ? leader_id : null;
      if (role !== 'leader') manager_id = role === 'leader' ? manager_id : null;
    }

    if (vertical) {
      const v = db.prepare("SELECT name FROM verticals WHERE name = ? AND status = 'approved'").get(vertical);
      if (!v) return bad(res, 'Unknown or unapproved vertical');
    }

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username).trim());
    if (exists) return bad(res, 'Username already taken');

    const info = db.prepare(
      'INSERT INTO users (username, password_hash, name, role, vertical, leader_id, manager_id, created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      String(username).trim(), bcrypt.hashSync(String(password), 10), String(name).trim(),
      role, vertical || null, role === 'member' ? leader_id || null : null,
      role === 'leader' ? manager_id || null : null, H.nowIso()
    );
    H.audit(db, actor, 'user_create', info.lastInsertRowid, null, `${role} ${username}`);
    res.json({ user: publicUser(H.getUser(db, info.lastInsertRowid)) });
  });

  r.patch('/users/:id', (req, res) => {
    const actor = req.user;
    const uid = Number(req.params.id);
    const target = H.getUser(db, uid);
    if (!target) return notFound(res);
    const inScope = H.canView(db, actor, uid);
    const isAdmin = actor.role === 'admin';
    // managers/leaders may manage people strictly below them (not themselves via this route, not peers)
    const managesTarget = inScope && uid !== actor.id && ['manager', 'leader'].includes(actor.role);
    if (!isAdmin && !managesTarget) return forbidden(res);

    const b = req.body || {};
    const updates = [];
    const vals = [];

    if (b.name != null && String(b.name).trim()) { updates.push('name = ?'); vals.push(String(b.name).trim()); }
    if (b.vertical !== undefined) {
      if (b.vertical) {
        const v = db.prepare("SELECT name FROM verticals WHERE name = ? AND status = 'approved'").get(b.vertical);
        if (!v) return bad(res, 'Unknown or unapproved vertical');
      }
      updates.push('vertical = ?'); vals.push(b.vertical || null);
    }
    if (b.active !== undefined) { updates.push('active = ?'); vals.push(b.active ? 1 : 0); }
    if (b.password) {
      if (String(b.password).length < 6) return bad(res, 'Password must be at least 6 characters');
      updates.push('password_hash = ?'); vals.push(bcrypt.hashSync(String(b.password), 10));
    }
    if (isAdmin) {
      if (b.leader_id !== undefined) { updates.push('leader_id = ?'); vals.push(b.leader_id ? Number(b.leader_id) : null); }
      if (b.manager_id !== undefined) { updates.push('manager_id = ?'); vals.push(b.manager_id ? Number(b.manager_id) : null); }
      if (b.role && ['admin', 'manager', 'leader', 'member'].includes(b.role)) { updates.push('role = ?'); vals.push(b.role); }
    }
    if (!updates.length) return bad(res, 'Nothing to update');
    vals.push(uid);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
    H.audit(db, actor, 'user_update', uid, null, Object.keys(b).filter((k) => k !== 'password').join(',') + (b.password ? ',password_reset' : ''));
    res.json({ user: publicUser(H.getUser(db, uid)) });
  });

  // ---------- verticals ----------
  r.get('/verticals', (req, res) => {
    const approved = db.prepare("SELECT name FROM verticals WHERE status = 'approved' ORDER BY name").all().map((v) => v.name);
    let pending = [];
    if (req.user.role === 'admin') {
      pending = db.prepare(
        `SELECT v.name, v.created_at, u.name AS requested_by_name
         FROM verticals v LEFT JOIN users u ON u.id = v.requested_by
         WHERE v.status = 'pending' ORDER BY v.created_at`
      ).all();
    } else {
      pending = db.prepare(
        "SELECT name, created_at FROM verticals WHERE status = 'pending' AND requested_by = ?"
      ).all(req.user.id);
    }
    res.json({ approved, pending });
  });

  r.post('/verticals', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name || name.length > 40) return bad(res, 'Vertical name required (max 40 chars)');
    if (req.user.role === 'member') return forbidden(res);
    const exists = db.prepare('SELECT name, status FROM verticals WHERE name = ? COLLATE NOCASE').get(name);
    if (exists) return bad(res, `Vertical already exists (${exists.status})`);
    const status = req.user.role === 'admin' ? 'approved' : 'pending';
    db.prepare('INSERT INTO verticals (name, status, requested_by, created_at) VALUES (?,?,?,?)')
      .run(name, status, req.user.id, H.nowIso());
    H.audit(db, req.user, status === 'approved' ? 'vertical_add' : 'vertical_propose', null, null, name);
    res.json({ name, status });
  });

  r.post('/verticals/decide', (req, res) => {
    if (req.user.role !== 'admin') return forbidden(res);
    const { name, approve } = req.body || {};
    const v = db.prepare("SELECT * FROM verticals WHERE name = ? AND status = 'pending'").get(String(name || ''));
    if (!v) return notFound(res, 'No such pending vertical');
    if (approve) {
      db.prepare("UPDATE verticals SET status = 'approved' WHERE name = ?").run(v.name);
      H.audit(db, req.user, 'vertical_approve', null, null, v.name);
    } else {
      db.prepare("DELETE FROM verticals WHERE name = ? AND status = 'pending'").run(v.name);
      H.audit(db, req.user, 'vertical_reject', null, null, v.name);
    }
    res.json({ ok: true });
  });

  // ---------- month: read ----------
  r.get('/month/:userId/:month', targetMonth, (req, res) => {
    const row = H.getMonthRow(db, req.target.id, req.month) || null;
    const metrics = H.computeMonth(row);
    const reviews = db.prepare(
      `SELECT rv.*, u.name AS author_name FROM reviews rv JOIN users u ON u.id = rv.author_id
       WHERE rv.user_id = ? AND rv.month = ? ORDER BY rv.created_at`
    ).all(req.target.id, req.month);
    res.json({ user: publicUser(req.target), row, metrics, reviews });
  });

  // ---------- month: goal set / submit / approve / reject ----------
  r.put('/month/:userId/:month/goal', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    const isSelf = actor.id === target.id;
    const isLeaderOf = actor.role === 'leader' && target.leader_id === actor.id;
    const isAdmin = actor.role === 'admin';
    if (!isSelf && !isLeaderOf && !isAdmin) return forbidden(res);

    const row = H.getMonthRow(db, target.id, req.month, true);
    if (row.locked && !isAdmin) return forbidden(res, 'Month is locked');
    if (isSelf && !isAdmin && !['draft', 'rejected'].includes(row.goal_status)) {
      return bad(res, 'Goal already submitted — ask an approver to reject it first');
    }

    const b = req.body || {};
    const goal_spend = H.num(b.goal_spend); const goal_revenue = H.num(b.goal_revenue);
    const goal_profit = H.num(b.goal_profit);
    let weeks = Math.round(H.num(b.weeks, row.weeks || 4));
    if (weeks < 1 || weeks > 6) return bad(res, 'Weeks must be 1-6');
    if (goal_spend < 0 || goal_revenue < 0) return bad(res, 'Goals must be >= 0');

    // resize weekly array without losing entered data
    const weekly = row.weekly.slice(0, weeks);
    while (weekly.length < weeks) weekly.push(null);

    // Leader-set or admin-set goals skip earlier steps
    let goal_status = 'draft';
    if (isAdmin) goal_status = 'approved';
    else if (isLeaderOf && !isSelf) goal_status = 'pending_admin';

    db.prepare(
      `UPDATE months SET goal_spend=?, goal_revenue=?, goal_profit=?, weeks=?, weekly=?,
       goal_status=?, goal_remark=NULL, updated_at=? WHERE id=?`
    ).run(goal_spend, goal_revenue, goal_profit, weeks, JSON.stringify(weekly), goal_status, H.nowIso(), row.id);
    H.audit(db, actor, 'goal_set', target.id, req.month,
      `spend=${goal_spend} rev=${goal_revenue} profit=${goal_profit} weeks=${weeks} -> ${goal_status}`);
    res.json({ ok: true, goal_status });
  });

  r.post('/month/:userId/:month/submit', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    if (actor.id !== target.id) return forbidden(res, 'You can only submit your own goals');
    if (actor.role === 'manager') return forbidden(res, 'Managers do not carry personal goals');
    const row = H.getMonthRow(db, target.id, req.month);
    if (!row) return bad(res, 'Set a goal first');
    if (row.locked) return forbidden(res, 'Month is locked');
    if (!['draft', 'rejected'].includes(row.goal_status)) return bad(res, 'Already submitted');
    if (!(row.goal_spend > 0 || row.goal_revenue > 0)) return bad(res, 'Set goal amounts before submitting');

    let next;
    if (actor.role === 'admin') next = 'approved';
    else if (actor.role === 'leader') next = 'pending_admin';
    else next = target.leader_id ? 'pending_leader' : 'pending_admin';

    db.prepare('UPDATE months SET goal_status=?, goal_remark=NULL, updated_at=? WHERE id=?')
      .run(next, H.nowIso(), row.id);
    H.audit(db, actor, 'goal_submit', target.id, req.month, `-> ${next}`);
    res.json({ ok: true, goal_status: next });
  });

  r.post('/month/:userId/:month/approve', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    const row = H.getMonthRow(db, target.id, req.month);
    if (!row) return notFound(res);
    let next = null;
    if (actor.role === 'leader' && target.leader_id === actor.id && row.goal_status === 'pending_leader') {
      next = 'pending_admin';
    } else if (actor.role === 'admin' && ['pending_leader', 'pending_admin'].includes(row.goal_status)) {
      next = 'approved';
    }
    if (!next) return forbidden(res, 'Nothing you can approve here');
    db.prepare('UPDATE months SET goal_status=?, goal_remark=NULL, updated_at=? WHERE id=?')
      .run(next, H.nowIso(), row.id);
    H.audit(db, actor, 'goal_approve', target.id, req.month, `-> ${next}`);
    res.json({ ok: true, goal_status: next });
  });

  r.post('/month/:userId/:month/reject', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    const remark = String((req.body || {}).remark || '').trim();
    if (!remark) return bad(res, 'A remark is required when rejecting');
    const row = H.getMonthRow(db, target.id, req.month);
    if (!row) return notFound(res);
    const leaderCan = actor.role === 'leader' && target.leader_id === actor.id && row.goal_status === 'pending_leader';
    const adminCan = actor.role === 'admin' && ['pending_leader', 'pending_admin'].includes(row.goal_status);
    if (!leaderCan && !adminCan) return forbidden(res);
    db.prepare("UPDATE months SET goal_status='rejected', goal_remark=?, updated_at=? WHERE id=?")
      .run(remark, H.nowIso(), row.id);
    H.audit(db, actor, 'goal_reject', target.id, req.month, remark);
    res.json({ ok: true });
  });

  // ---------- weekly actuals ----------
  r.put('/month/:userId/:month/week/:index', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    const isSelf = actor.id === target.id;
    const isLeaderOf = actor.role === 'leader' && target.leader_id === actor.id;
    const isAdmin = actor.role === 'admin';
    if (!isSelf && !isLeaderOf && !isAdmin) return forbidden(res);

    const row = H.getMonthRow(db, target.id, req.month, true);
    if (row.locked && !isAdmin) return forbidden(res, 'Month is locked');

    const idx = Number(req.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= (row.weeks || 4)) return bad(res, 'Invalid week index');

    const b = req.body || {};
    const reason = b.reason ? String(b.reason) : null;
    if (reason && !H.REASON_CODES.includes(reason)) return bad(res, 'Unknown reason code');
    const entry = {
      spend: Math.max(0, H.num(b.spend)),
      revenue: Math.max(0, H.num(b.revenue)),
      profit: H.num(b.profit), // can be negative
      reason,
      note: b.note ? String(b.note).slice(0, 500) : null,
    };
    while (row.weekly.length < (row.weeks || 4)) row.weekly.push(null);
    row.weekly[idx] = entry;
    H.saveMonthJson(db, row);
    H.audit(db, actor, 'week_update', target.id, req.month,
      `w${idx + 1} spend=${entry.spend} rev=${entry.revenue} profit=${entry.profit}${reason ? ' reason=' + reason : ''}`);
    const fresh = H.getMonthRow(db, target.id, req.month);
    res.json({ ok: true, metrics: H.computeMonth(fresh) });
  });

  // ---------- lock / self-review / meetings ----------
  r.post('/month/:userId/:month/lock', targetMonth, (req, res) => {
    if (req.user.role !== 'admin') return forbidden(res, 'Only admin can lock/unlock a month');
    const locked = (req.body || {}).locked ? 1 : 0;
    const row = H.getMonthRow(db, req.target.id, req.month, true);
    db.prepare('UPDATE months SET locked=?, updated_at=? WHERE id=?').run(locked, H.nowIso(), row.id);
    H.audit(db, req.user, locked ? 'month_lock' : 'month_unlock', req.target.id, req.month);
    res.json({ ok: true, locked: !!locked });
  });

  r.put('/month/:userId/:month/self-review', targetMonth, (req, res) => {
    if (req.user.id !== req.target.id) return forbidden(res, 'Self-review is personal');
    const text = String((req.body || {}).text || '').slice(0, 5000);
    const row = H.getMonthRow(db, req.target.id, req.month, true);
    if (row.locked) return forbidden(res, 'Month is locked');
    db.prepare('UPDATE months SET self_review=?, updated_at=? WHERE id=?').run(text, H.nowIso(), row.id);
    H.audit(db, req.user, 'self_review', req.target.id, req.month);
    res.json({ ok: true });
  });

  r.post('/month/:userId/:month/meeting', targetMonth, (req, res) => {
    if (!['admin', 'manager', 'leader'].includes(req.user.role)) return forbidden(res);
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return bad(res, 'Meeting note text required');
    const row = H.getMonthRow(db, req.target.id, req.month, true);
    row.meetings.push({ date: b.date || H.nowIso().slice(0, 10), text: text.slice(0, 2000), author: req.user.name });
    H.saveMonthJson(db, row);
    H.audit(db, req.user, 'meeting_note', req.target.id, req.month);
    res.json({ ok: true, meetings: row.meetings });
  });

  // ---------- distribute targets (leader) ----------
  r.post('/distribute', (req, res) => {
    const actor = req.user;
    if (actor.role !== 'leader') return forbidden(res, 'Only leaders distribute targets');
    const { month, rows } = req.body || {};
    if (!H.validMonth(month)) return bad(res, 'Invalid month');
    if (!Array.isArray(rows) || !rows.length) return bad(res, 'No allocations given');

    const memberIds = db.prepare("SELECT id FROM users WHERE leader_id = ? AND role='member'").all(actor.id).map((x) => x.id);
    for (const a of rows) {
      if (!memberIds.includes(Number(a.user_id))) return forbidden(res, 'You can only distribute to your own team');
    }

    const tx = db.transaction(() => {
      for (const a of rows) {
        const uid = Number(a.user_id);
        const row = H.getMonthRow(db, uid, month, true);
        if (row.locked) throw new Error(`Month locked for user ${uid}`);
        const weeks = Math.min(6, Math.max(1, Math.round(H.num(a.weeks, row.weeks || 4))));
        const weekly = row.weekly.slice(0, weeks);
        while (weekly.length < weeks) weekly.push(null);
        db.prepare(
          `UPDATE months SET goal_spend=?, goal_revenue=?, goal_profit=?, weeks=?, weekly=?,
           goal_status='pending_admin', goal_remark=NULL, updated_at=? WHERE id=?`
        ).run(H.num(a.goal_spend), H.num(a.goal_revenue), H.num(a.goal_profit), weeks,
          JSON.stringify(weekly), H.nowIso(), row.id);
        H.audit(db, actor, 'goal_distribute', uid, month,
          `spend=${H.num(a.goal_spend)} rev=${H.num(a.goal_revenue)} profit=${H.num(a.goal_profit)}`);
      }
    });
    try { tx(); } catch (e) { return forbidden(res, e.message); }

    // tally: allocated vs leader's own goal
    const own = H.getMonthRow(db, actor.id, month);
    const allocated = rows.reduce((s, a) => ({
      spend: s.spend + H.num(a.goal_spend), revenue: s.revenue + H.num(a.goal_revenue), profit: s.profit + H.num(a.goal_profit),
    }), { spend: 0, revenue: 0, profit: 0 });
    res.json({
      ok: true, allocated,
      leaderGoal: own ? { spend: own.goal_spend, revenue: own.goal_revenue, profit: own.goal_profit } : null,
    });
  });

  // ---------- approvals inbox ----------
  r.get('/approvals', (req, res) => {
    const actor = req.user;
    let items = [];
    if (actor.role === 'leader') {
      items = db.prepare(
        `SELECT m.user_id, u.name, m.month, m.goal_status, m.goal_spend, m.goal_revenue, m.goal_profit, m.weeks
         FROM months m JOIN users u ON u.id = m.user_id
         WHERE u.leader_id = ? AND m.goal_status = 'pending_leader' ORDER BY m.month DESC, u.name`
      ).all(actor.id);
    } else if (actor.role === 'admin') {
      items = db.prepare(
        `SELECT m.user_id, u.name, m.month, m.goal_status, m.goal_spend, m.goal_revenue, m.goal_profit, m.weeks
         FROM months m JOIN users u ON u.id = m.user_id
         WHERE m.goal_status IN ('pending_admin','pending_leader') ORDER BY m.month DESC, u.name`
      ).all();
    } else {
      return res.json({ items: [] });
    }
    res.json({ items });
  });

  // ---------- overview board ----------
  r.get('/overview', (req, res) => {
    const actor = req.user;
    if (actor.role === 'member') return forbidden(res);
    const month = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const verticalFilter = req.query.vertical || null;

    let leaders;
    if (actor.role === 'admin') {
      leaders = db.prepare("SELECT * FROM users WHERE role='leader' AND active=1 ORDER BY name").all();
    } else if (actor.role === 'manager') {
      leaders = db.prepare("SELECT * FROM users WHERE role='leader' AND manager_id=? AND active=1 ORDER BY name").all(actor.id);
    } else {
      leaders = [actor];
    }
    if (verticalFilter) leaders = leaders.filter((l) => l.vertical === verticalFilter);

    const cards = leaders.map((l) => {
      const teamIds = [l.id, ...db.prepare("SELECT id FROM users WHERE leader_id=? AND active=1").all(l.id).map((x) => x.id)];
      const rows = teamIds.map((id) => H.getMonthRow(db, id, month)).filter(Boolean);
      const agg = H.aggregateRows(rows, month);
      return {
        leader: { id: l.id, name: l.name, vertical: l.vertical },
        members: teamIds.length - 1,
        ...agg,
      };
    });
    res.json({ month, cards });
  });

  // ---------- reports ----------
  function lastMonths(n, endMonth) {
    const [y, m] = endMonth.split('-').map(Number);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(y, m - 1 - i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }

  r.get('/reports/trend', (req, res) => {
    const uid = req.query.user_id ? Number(req.query.user_id) : req.user.id;
    if (!H.canView(db, req.user, uid)) return forbidden(res);
    const n = Math.min(24, Math.max(2, Number(req.query.n) || 6));
    const end = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const months = lastMonths(n, end);
    const data = months.map((mo) => {
      const row = H.getMonthRow(db, uid, mo);
      const m = H.computeMonth(row);
      return {
        month: mo, spend: m.spend, revenue: m.revenue, profit: m.profit,
        goal_revenue: row ? row.goal_revenue : 0, goal_profit: row ? row.goal_profit : 0,
      };
    });
    res.json({ user_id: uid, data });
  });

  r.get('/reports/vertical', (req, res) => {
    const month = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const actor = req.user;
    let userRows;
    if (actor.role === 'member') {
      // member: own-vertical aggregate only
      userRows = actor.vertical
        ? db.prepare("SELECT * FROM users WHERE vertical=? AND active=1").all(actor.vertical)
        : [actor];
    } else {
      const ids = H.subtreeIds(db, actor);
      const ph = ids.map(() => '?').join(',');
      userRows = db.prepare(`SELECT * FROM users WHERE id IN (${ph}) AND active=1`).all(...ids);
    }
    const byVert = {};
    for (const u of userRows) {
      const key = u.vertical || '(none)';
      byVert[key] = byVert[key] || { vertical: key, people: 0, spend: 0, revenue: 0, profit: 0, goal_revenue: 0, goal_profit: 0 };
      const row = H.getMonthRow(db, u.id, month);
      const m = H.computeMonth(row);
      byVert[key].people += 1;
      byVert[key].spend += m.spend; byVert[key].revenue += m.revenue; byVert[key].profit += m.profit;
      if (row && row.goal_status === 'approved') {
        byVert[key].goal_revenue += row.goal_revenue; byVert[key].goal_profit += row.goal_profit;
      }
    }
    const out = Object.values(byVert).map((v) => ({
      ...v, roas: v.spend > 0 ? v.revenue / v.spend : 0,
      revPct: v.goal_revenue > 0 ? (v.revenue / v.goal_revenue) * 100 : 0,
    })).sort((a, b) => b.revenue - a.revenue);
    res.json({ month, verticals: out });
  });

  r.get('/reports/leaderboard', (req, res) => {
    const month = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const actor = req.user;
    let people;
    if (actor.role === 'admin') {
      people = db.prepare("SELECT * FROM users WHERE role IN ('leader','member') AND active=1").all();
    } else if (actor.role === 'manager') {
      const ids = H.subtreeIds(db, actor);
      const ph = ids.map(() => '?').join(',');
      people = db.prepare(`SELECT * FROM users WHERE id IN (${ph}) AND role IN ('leader','member') AND active=1`).all(...ids);
    } else if (actor.role === 'leader') {
      // leaders see other leaders + their own team
      const own = db.prepare("SELECT * FROM users WHERE leader_id=? AND active=1").all(actor.id);
      const leaders = db.prepare("SELECT * FROM users WHERE role='leader' AND active=1").all();
      const seen = new Set();
      people = [...leaders, ...own, actor].filter((u) => (seen.has(u.id) ? false : seen.add(u.id)));
    } else {
      // member: peers in own vertical (names + scores only)
      people = actor.vertical
        ? db.prepare("SELECT * FROM users WHERE vertical=? AND role='member' AND active=1").all(actor.vertical)
        : [actor];
    }
    const rows = people.map((u) => {
      const row = H.getMonthRow(db, u.id, month);
      const m = H.computeMonth(row);
      const base = { user_id: u.id, name: u.name, role: u.role, vertical: u.vertical, score: m.score };
      if (actor.role === 'member') return base; // limited detail for members
      return { ...base, revPct: m.revPct, profitPct: m.profitPct, budgetPct: m.budgetPct, revenue: m.revenue, profit: m.profit };
    }).sort((a, b) => b.score - a.score)
      .map((x, i) => ({ rank: i + 1, ...x }));
    res.json({ month, rows });
  });

  r.get('/reports/company', (req, res) => {
    if (req.user.role !== 'admin') return forbidden(res, 'Company view is admin-only');
    const month = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const [y, m] = month.split('-').map(Number);
    const prevD = new Date(y, m - 2, 1);
    const prev = `${prevD.getFullYear()}-${String(prevD.getMonth() + 1).padStart(2, '0')}`;

    function totalsFor(mo) {
      const users = db.prepare('SELECT * FROM users WHERE active=1').all();
      const t = { spend: 0, revenue: 0, profit: 0, goal_spend: 0, goal_revenue: 0, goal_profit: 0 };
      const byVert = {};
      for (const u of users) {
        const row = H.getMonthRow(db, u.id, mo);
        const mm = H.computeMonth(row);
        t.spend += mm.spend; t.revenue += mm.revenue; t.profit += mm.profit;
        if (row && row.goal_status === 'approved') {
          t.goal_spend += row.goal_spend; t.goal_revenue += row.goal_revenue; t.goal_profit += row.goal_profit;
        }
        const key = u.vertical || '(none)';
        byVert[key] = byVert[key] || { vertical: key, spend: 0, revenue: 0, profit: 0 };
        byVert[key].spend += mm.spend; byVert[key].revenue += mm.revenue; byVert[key].profit += mm.profit;
      }
      return { totals: t, byVert: Object.values(byVert).sort((a, b) => b.profit - a.profit) };
    }

    const cur = totalsFor(month);
    const prv = totalsFor(prev);
    const momPct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : 0);

    res.json({
      month,
      totals: cur.totals,
      blendedRoas: cur.totals.spend > 0 ? cur.totals.revenue / cur.totals.spend : 0,
      targetVsActual: {
        revenuePct: cur.totals.goal_revenue > 0 ? (cur.totals.revenue / cur.totals.goal_revenue) * 100 : 0,
        profitPct: cur.totals.goal_profit > 0 ? (cur.totals.profit / cur.totals.goal_profit) * 100 : 0,
        spendPct: cur.totals.goal_spend > 0 ? (cur.totals.spend / cur.totals.goal_spend) * 100 : 0,
      },
      mom: {
        prevMonth: prev,
        revenuePct: momPct(cur.totals.revenue, prv.totals.revenue),
        profitPct: momPct(cur.totals.profit, prv.totals.profit),
        spendPct: momPct(cur.totals.spend, prv.totals.spend),
      },
      profitByVertical: [
        ...cur.byVert,
        { vertical: 'All verticals', spend: cur.totals.spend, revenue: cur.totals.revenue, profit: cur.totals.profit },
      ],
    });
  });

  r.get('/reports/reasons', (req, res) => {
    const actor = req.user;
    if (actor.role === 'member') return forbidden(res);
    const month = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const ids = H.subtreeIds(db, actor);
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT weekly FROM months WHERE month = ? AND user_id IN (${ph})`).all(month, ...ids);
    const counts = {};
    for (const r2 of rows) {
      let weekly; try { weekly = JSON.parse(r2.weekly); } catch { weekly = []; }
      for (const w of weekly || []) {
        if (w && w.reason) counts[w.reason] = (counts[w.reason] || 0) + 1;
      }
    }
    const out = Object.entries(counts).map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);
    res.json({ month, reasons: out });
  });

  // ---------- appraisal (admin only) ----------
  r.get('/appraisal/:userId', (req, res) => {
    if (req.user.role !== 'admin') return forbidden(res, 'Appraisal is admin-only');
    const uid = Number(req.params.userId);
    const target = H.getUser(db, uid);
    if (!target) return notFound(res);

    const monthRows = db.prepare('SELECT * FROM months WHERE user_id = ? ORDER BY month').all(uid);
    const perMonth = monthRows.map((raw) => {
      raw.weekly = JSON.parse(raw.weekly || '[]');
      raw.meetings = JSON.parse(raw.meetings || '[]');
      const m = H.computeMonth(raw);
      return {
        month: raw.month, goal_revenue: raw.goal_revenue, goal_profit: raw.goal_profit,
        goal_status: raw.goal_status, locked: !!raw.locked, self_review: raw.self_review,
        spend: m.spend, revenue: m.revenue, profit: m.profit,
        revPct: m.revPct, profitPct: m.profitPct, roas: m.roas, marginPct: m.marginPct, score: m.score,
      };
    });
    const withGoals = perMonth.filter((p) => p.goal_status === 'approved' && (p.goal_revenue > 0));
    const hit = withGoals.filter((p) => p.revPct >= 100).length;
    const reviews = db.prepare(
      `SELECT rv.*, u.name AS author_name FROM reviews rv JOIN users u ON u.id = rv.author_id
       WHERE rv.user_id = ? ORDER BY rv.month, rv.created_at`
    ).all(uid);
    const ratings = reviews.filter((x) => !x.is_self && x.rating);
    const avgRating = ratings.length ? ratings.reduce((s, x) => s + x.rating, 0) / ratings.length : 0;

    // Team performance for leaders
    let team = null;
    if (target.role === 'leader') {
      const memberIds = db.prepare("SELECT id FROM users WHERE leader_id=?").all(uid).map((x) => x.id);
      let teamProfit = 0;
      for (const mid of memberIds) {
        for (const mr of db.prepare('SELECT * FROM months WHERE user_id=?').all(mid)) {
          mr.weekly = JSON.parse(mr.weekly || '[]');
          teamProfit += H.computeMonth(mr).profit;
        }
      }
      team = { members: memberIds.length, totalProfit: teamProfit };
    }

    res.json({
      user: publicUser(target),
      overallScore: perMonth.length ? perMonth.reduce((s, p) => s + p.score, 0) / perMonth.length : 0,
      targetHitRate: withGoals.length ? (hit / withGoals.length) * 100 : 0,
      totalProfit: perMonth.reduce((s, p) => s + p.profit, 0),
      avgRating,
      months: perMonth,
      reviews,
      team,
    });
  });

  // ---------- comments (threaded feedback) ----------
  r.get('/comments/:userId/:month', targetMonth, (req, res) => {
    const rows = db.prepare(
      `SELECT c.*, u.name AS author_name, u.role AS author_role FROM comments c
       JOIN users u ON u.id = c.author_id
       WHERE c.user_id = ? AND c.month = ? ORDER BY c.created_at`
    ).all(req.target.id, req.month);
    res.json({ comments: rows });
  });

  r.post('/comments/:userId/:month', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    // members may only comment (reply) on their own month
    if (actor.role === 'member' && actor.id !== target.id) return forbidden(res);
    const text = String((req.body || {}).text || '').trim();
    if (!text) return bad(res, 'Comment text required');
    let week_index = (req.body || {}).week_index;
    week_index = Number.isInteger(Number(week_index)) && week_index !== null && week_index !== ''
      ? Number(week_index) : null;
    db.prepare(
      'INSERT INTO comments (user_id, month, week_index, author_id, text, created_at) VALUES (?,?,?,?,?,?)'
    ).run(target.id, req.month, week_index, actor.id, text.slice(0, 2000), H.nowIso());
    H.audit(db, actor, 'comment', target.id, req.month, week_index != null ? `week ${week_index + 1}` : '');
    res.json({ ok: true });
  });

  // ---------- ratings / reviews ----------
  r.post('/reviews/:userId/:month', targetMonth, (req, res) => {
    const actor = req.user; const target = req.target;
    if (!['admin', 'manager', 'leader'].includes(actor.role)) return forbidden(res);
    if (actor.id === target.id) return bad(res, 'Use self-review for your own month');
    const rating = Number((req.body || {}).rating);
    const text = String((req.body || {}).text || '').trim();
    if (!(rating >= 1 && rating <= 5)) return bad(res, 'Rating must be 1-5');
    db.prepare(
      'INSERT INTO reviews (user_id, month, author_id, rating, text, is_self, created_at) VALUES (?,?,?,?,?,0,?)'
    ).run(target.id, req.month, actor.id, rating, text.slice(0, 3000), H.nowIso());
    H.audit(db, actor, 'rating', target.id, req.month, `rating=${rating}`);
    res.json({ ok: true });
  });

  r.get('/reviews/:userId', (req, res) => {
    const uid = Number(req.params.userId);
    if (!H.canView(db, req.user, uid)) return forbidden(res);
    const rows = db.prepare(
      `SELECT rv.*, u.name AS author_name FROM reviews rv JOIN users u ON u.id = rv.author_id
       WHERE rv.user_id = ? ORDER BY rv.month DESC, rv.created_at DESC`
    ).all(uid);
    res.json({ reviews: rows });
  });

  // ---------- coupons ----------
  function couponScopeIds(actor) {
    if (actor.role === 'admin') return null; // all
    return H.subtreeIds(db, actor);
  }

  r.get('/coupons', (req, res) => {
    const actor = req.user;
    let rows;
    if (actor.role === 'admin') {
      rows = db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
    } else if (actor.role === 'member') {
      rows = db.prepare(
        'SELECT * FROM coupons WHERE assigned_to = ? OR (vertical IS NOT NULL AND vertical = ?) ORDER BY created_at DESC'
      ).all(actor.id, actor.vertical || '__none__');
    } else {
      const ids = couponScopeIds(actor);
      const ph = ids.map(() => '?').join(',');
      rows = db.prepare(
        `SELECT * FROM coupons WHERE assigned_to IN (${ph}) OR created_by IN (${ph}) ORDER BY created_at DESC`
      ).all(...ids, ...ids);
    }
    const names = {};
    for (const u of db.prepare('SELECT id, name FROM users').all()) names[u.id] = u.name;
    res.json({
      coupons: rows.map((c) => ({
        ...c, assigned_name: c.assigned_to ? names[c.assigned_to] : null, created_name: names[c.created_by],
      })),
    });
  });

  r.post('/coupons', (req, res) => {
    const actor = req.user;
    if (!['admin', 'manager', 'leader'].includes(actor.role)) return forbidden(res);
    const b = req.body || {};
    if (!b.code || !String(b.code).trim()) return bad(res, 'Coupon code required');
    let assigned_to = b.assigned_to ? Number(b.assigned_to) : null;
    if (assigned_to && actor.role !== 'admin' && !H.canView(db, actor, assigned_to)) {
      return forbidden(res, 'Assignee outside your team');
    }
    const status = ['active', 'paused', 'expired', 'used'].includes(b.status) ? b.status : 'active';
    const info = db.prepare(
      `INSERT INTO coupons (code, brand, vertical, discount, valid_from, expiry, assigned_to, status, note, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      String(b.code).trim(), b.brand || null, b.vertical || null, b.discount || null,
      b.valid_from || null, b.expiry || null, assigned_to, status,
      b.note ? String(b.note).slice(0, 500) : null, actor.id, H.nowIso()
    );
    H.audit(db, actor, 'coupon_create', assigned_to, null, String(b.code).trim());
    res.json({ id: info.lastInsertRowid });
  });

  r.patch('/coupons/:id', (req, res) => {
    const actor = req.user;
    if (!['admin', 'manager', 'leader'].includes(actor.role)) return forbidden(res);
    const c = db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(req.params.id));
    if (!c) return notFound(res);
    if (actor.role !== 'admin') {
      const ids = H.subtreeIds(db, actor);
      if (!ids.includes(c.created_by) && !(c.assigned_to && ids.includes(c.assigned_to))) return forbidden(res);
    }
    const b = req.body || {};
    const fields = ['code', 'brand', 'vertical', 'discount', 'valid_from', 'expiry', 'note'];
    const updates = []; const vals = [];
    for (const f of fields) if (b[f] !== undefined) { updates.push(`${f} = ?`); vals.push(b[f] || null); }
    if (b.status !== undefined) {
      if (!['active', 'paused', 'expired', 'used'].includes(b.status)) return bad(res, 'Bad status');
      updates.push('status = ?'); vals.push(b.status);
    }
    if (b.assigned_to !== undefined) {
      const at = b.assigned_to ? Number(b.assigned_to) : null;
      if (at && actor.role !== 'admin' && !H.canView(db, actor, at)) return forbidden(res, 'Assignee outside your team');
      updates.push('assigned_to = ?'); vals.push(at);
    }
    if (!updates.length) return bad(res, 'Nothing to update');
    vals.push(c.id);
    db.prepare(`UPDATE coupons SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
    H.audit(db, actor, 'coupon_update', c.assigned_to, null, c.code);
    res.json({ ok: true });
  });

  // ---------- audit log ----------
  r.get('/audit', (req, res) => {
    const actor = req.user;
    if (actor.role === 'member') return forbidden(res);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    let rows;
    if (actor.role === 'admin') {
      rows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit);
    } else {
      const ids = H.subtreeIds(db, actor);
      const ph = ids.map(() => '?').join(',');
      rows = db.prepare(
        `SELECT * FROM audit WHERE actor_id IN (${ph}) OR target_user IN (${ph}) ORDER BY id DESC LIMIT ?`
      ).all(...ids, ...ids, limit);
    }
    res.json({ audit: rows });
  });

  // ---------- pending fills ----------
  r.get('/pending-fills', (req, res) => {
    const actor = req.user;
    const month = H.validMonth(req.query.month) ? req.query.month : H.currentMonth();
    const ids = H.subtreeIds(db, actor);
    const ph = ids.map(() => '?').join(',');
    const users = db.prepare(`SELECT * FROM users WHERE id IN (${ph}) AND active=1 AND role IN ('leader','member')`).all(...ids);
    // expected week number: for the current month, based on day-of-month; past months expect all weeks
    const now = new Date();
    const isCurrent = month === H.currentMonth();
    const out = [];
    for (const u of users) {
      const row = H.getMonthRow(db, u.id, month);
      if (!row || row.goal_status !== 'approved') continue;
      const weeks = row.weeks || 4;
      const expected = isCurrent ? Math.min(weeks, Math.ceil(now.getDate() / 7)) : weeks;
      const filled = H.computeMonth(row).weeksFilled;
      if (filled < expected) out.push({ user_id: u.id, name: u.name, vertical: u.vertical, filled, expected, weeks });
    }
    res.json({ month, pending: out });
  });

  return r;
};
