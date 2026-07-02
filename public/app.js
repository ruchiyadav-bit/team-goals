/* Team Goals & Performance CRM — frontend SPA (vanilla JS + Chart.js) */
(() => {
  'use strict';

  // ---------- state ----------
  const S = {
    me: null,
    month: defaultMonth(),
    reasonCodes: [],
    users: [],          // visible users cache
    verticals: [],      // approved vertical names
    charts: {},         // chart instances by canvas id
  };

  function defaultMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // ---------- utils ----------
  const $app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmt2 = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const pct = (n) => `${Number(n || 0).toFixed(1)}%`;

  const STATUS = {
    achieved: ['Target achieved', 'green'],
    on_track: ['On track', 'blue'],
    behind: ['Behind', 'amber'],
    missed: ['Missed', 'red'],
    not_started: ['Not started', 'gray'],
    no_goals: ['No goals', 'gray'],
  };
  const GOAL_STATUS = {
    draft: ['Draft', 'gray'],
    pending_leader: ['Pending leader approval', 'amber'],
    pending_admin: ['Pending admin approval', 'amber'],
    approved: ['Approved', 'green'],
    rejected: ['Rejected', 'red'],
  };

  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401) { S.me = null; renderLogin(); throw new Error(data.error || 'Not authenticated'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function destroyCharts() {
    for (const k of Object.keys(S.charts)) { try { S.charts[k].destroy(); } catch { /* noop */ } delete S.charts[k]; }
  }

  function makeChart(canvasId, config) {
    const el = document.getElementById(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    S.charts[canvasId] = new Chart(el, config);
  }

  function badge(map, key) {
    const [label, color] = map[key] || [key, 'gray'];
    return `<span class="badge ${color}">${esc(label)}</span>`;
  }

  function stars(n) {
    const full = Math.round(Number(n) || 0);
    return `<span class="stars">${'★'.repeat(full)}${'☆'.repeat(Math.max(0, 5 - full))}</span>`;
  }

  // ---------- boot / router ----------
  window.addEventListener('hashchange', route);

  async function boot() {
    try {
      const d = await api('/me');
      S.me = d.user;
      S.reasonCodes = d.reasonCodes || [];
      await refreshShared();
      route();
    } catch {
      /* renderLogin already shown by api() on 401 */
    }
  }

  async function refreshShared() {
    try {
      const [u, v] = await Promise.all([api('/users'), api('/verticals')]);
      S.users = u.users;
      S.verticals = v.approved;
      S.pendingVerticals = v.pending || [];
    } catch { /* noop */ }
  }

  function nav(hash) { location.hash = hash; }

  function route() {
    if (!S.me) return renderLogin();
    destroyCharts();
    const parts = (location.hash || '#/dashboard').slice(2).split('/');
    const page = parts[0] || 'dashboard';
    const arg = parts[1];
    const map = {
      dashboard: () => renderDashboard(arg ? Number(arg) : S.me.id),
      overview: renderOverview,
      team: renderTeam,
      approvals: renderApprovals,
      reports: renderReports,
      appraisal: () => renderAppraisal(arg ? Number(arg) : null),
      coupons: renderCoupons,
      verticals: renderVerticals,
      audit: renderAudit,
      settings: renderSettings,
    };
    (map[page] || map.dashboard)();
  }

  // ---------- shell ----------
  function navItems() {
    const r = S.me.role;
    const items = [['dashboard', 'My Dashboard']];
    if (r !== 'member') items.push(['overview', 'Overview Board']);
    if (r === 'leader' || r === 'admin') items.push(['approvals', 'Approvals']);
    items.push(['reports', 'Reports']);
    if (r !== 'member') items.push(['team', 'Team & Users']);
    if (r === 'admin') items.push(['appraisal', 'Appraisal']);
    items.push(['coupons', 'Coupons']);
    if (r !== 'member') items.push(['verticals', 'Verticals']);
    if (r !== 'member') items.push(['audit', 'Audit Log']);
    items.push(['settings', 'Settings']);
    return items;
  }

  function shell(title, contentHtml, { showMonth = true } = {}) {
    const active = (location.hash || '#/dashboard').slice(2).split('/')[0] || 'dashboard';
    $app.innerHTML = `
      <div class="shell">
        <aside class="sidebar">
          <div class="brand">Team Goals CRM</div>
          <nav>
            ${navItems().map(([k, label]) =>
              `<a class="nav-item ${active === k ? 'active' : ''}" href="#/${k}">${esc(label)}</a>`).join('')}
          </nav>
          <div class="whoami">
            <b>${esc(S.me.name)}</b>
            ${esc(S.me.role)}${S.me.vertical ? ' · ' + esc(S.me.vertical) : ''}
            <br /><button id="logoutBtn">Log out</button>
          </div>
        </aside>
        <main class="main">
          <div class="topbar">
            <h1>${esc(title)}</h1>
            ${showMonth ? `
              <div class="month-picker no-print">
                <label class="muted">Month</label>
                <input type="month" id="monthPick" value="${esc(S.month)}" />
              </div>` : ''}
          </div>
          <div id="content">${contentHtml}</div>
        </main>
      </div>`;
    document.getElementById('logoutBtn').onclick = async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      S.me = null; renderLogin();
    };
    const mp = document.getElementById('monthPick');
    if (mp) mp.onchange = () => { S.month = mp.value || defaultMonth(); route(); };
  }

  // ---------- login ----------
  function renderLogin() {
    destroyCharts();
    $app.innerHTML = `
      <div class="login-wrap">
        <div class="login-box">
          <h1>Team Goals CRM</h1>
          <div class="sub">Monthly goals · weekly performance · approvals</div>
          <form id="loginForm">
            <div class="field"><label>Username</label><input id="lu" autocomplete="username" required /></div>
            <div class="field"><label>Password</label><input id="lp" type="password" autocomplete="current-password" required /></div>
            <button class="btn" style="width:100%" type="submit">Sign in</button>
            <div id="loginErr" style="color:var(--red); margin-top:10px; font-size:13px;"></div>
          </form>
        </div>
      </div>`;
    document.getElementById('loginForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const d = await api('/login', {
          method: 'POST',
          body: { username: document.getElementById('lu').value, password: document.getElementById('lp').value },
        });
        S.me = d.user;
        const me = await api('/me');
        S.reasonCodes = me.reasonCodes || [];
        await refreshShared();
        location.hash = '#/dashboard';
        route();
      } catch (err) {
        document.getElementById('loginErr').textContent = err.message;
      }
    };
  }

  // ---------- dashboard ----------
  async function renderDashboard(userId) {
    let d;
    try {
      d = await api(`/month/${userId}/${S.month}`);
    } catch (err) {
      return shell('Dashboard', `<div class="panel">${esc(err.message)}</div>`);
    }
    const u = d.user; const row = d.row; const m = d.metrics;
    const me = S.me;
    const isSelf = me.id === u.id;
    const isLeaderOf = me.role === 'leader' && u.leader_id === me.id;
    const isAdmin = me.role === 'admin';
    const canEditGoal = isAdmin || isLeaderOf ||
      (isSelf && me.role !== 'manager' && (!row || ['draft', 'rejected'].includes(row.goal_status)));
    const canEditWeeks = (isSelf || isLeaderOf || isAdmin) && (!row || !row.locked || isAdmin);
    const locked = row && row.locked;
    const gs = row ? row.goal_status : 'draft';
    const weeks = row ? row.weeks : 4;

    const comments = (await api(`/comments/${u.id}/${S.month}`).catch(() => ({ comments: [] }))).comments;

    const weeklyRows = [];
    for (let i = 0; i < weeks; i++) {
      const w = row && row.weekly[i] ? row.weekly[i] : {};
      weeklyRows.push(`
        <tr data-week="${i}">
          <td>W${i + 1}</td>
          <td><input type="number" step="any" min="0" class="w-spend" value="${w.spend != null ? esc(w.spend) : ''}" ${canEditWeeks ? '' : 'disabled'} /></td>
          <td><input type="number" step="any" min="0" class="w-rev" value="${w.revenue != null ? esc(w.revenue) : ''}" ${canEditWeeks ? '' : 'disabled'} /></td>
          <td><input type="number" step="any" class="w-profit" value="${w.profit != null ? esc(w.profit) : ''}" ${canEditWeeks ? '' : 'disabled'} /></td>
          <td>
            <select class="w-reason" ${canEditWeeks ? '' : 'disabled'}>
              <option value="">— reason —</option>
              ${S.reasonCodes.map((rc) => `<option ${w.reason === rc ? 'selected' : ''}>${esc(rc)}</option>`).join('')}
            </select>
          </td>
          <td><input class="w-note" placeholder="note" value="${esc(w.note || '')}" ${canEditWeeks ? '' : 'disabled'} /></td>
          <td>${canEditWeeks ? `<button class="btn small w-save">Save</button>` : ''}</td>
        </tr>`);
    }

    const approver = (me.role === 'leader' && u.leader_id === me.id && gs === 'pending_leader') ||
      (isAdmin && ['pending_leader', 'pending_admin'].includes(gs));

    const canRate = ['admin', 'manager', 'leader'].includes(me.role) && !isSelf;

    shell(isSelf ? 'My Dashboard' : `Dashboard — ${u.name}`, `
      ${!isSelf ? `<div class="muted" style="margin-bottom:10px">${esc(u.role)} · ${esc(u.vertical || 'no vertical')}</div>` : ''}
      ${locked ? `<div class="panel" style="border-left:4px solid var(--red)"><b>Month locked.</b> Numbers can no longer be edited${isAdmin ? ' (admin override active)' : ''}.</div>` : ''}

      <div class="metrics">
        <div class="metric"><div class="label">Spend</div><div class="value">${fmt(m.spend)}</div><div class="sub">goal ${fmt(row ? row.goal_spend : 0)}</div></div>
        <div class="metric"><div class="label">Revenue</div><div class="value">${fmt(m.revenue)}</div><div class="sub">goal ${fmt(row ? row.goal_revenue : 0)} · ${pct(m.revPct)}</div></div>
        <div class="metric"><div class="label">Profit</div><div class="value">${fmt(m.profit)}</div><div class="sub">goal ${fmt(row ? row.goal_profit : 0)} · ${pct(m.profitPct)}</div></div>
        <div class="metric"><div class="label">ROAS</div><div class="value">${fmt2(m.roas)}</div><div class="sub">margin ${pct(m.marginPct)}</div></div>
        <div class="metric"><div class="label">Pacing</div><div class="value">${pct(m.pacingPct)}</div><div class="sub">weekly target ${fmt(m.weeklySpendTarget)}</div></div>
        <div class="metric"><div class="label">Forecast (rev)</div><div class="value">${fmt(m.forecast.revenue)}</div><div class="sub">profit ${fmt(m.forecast.profit)}</div></div>
        <div class="metric"><div class="label">Status</div><div class="value" style="font-size:14px">${badge(STATUS, m.status)}</div><div class="sub">${m.weeksFilled}/${weeks} weeks filled</div></div>
      </div>

      <div class="grid cols-2">
        <div class="panel">
          <div class="flex"><h2>Monthly goal</h2><div class="spacer"></div>${badge(GOAL_STATUS, gs)}</div>
          ${row && row.goal_remark ? `<div style="color:var(--red); font-size:13px; margin-bottom:8px">Remark: ${esc(row.goal_remark)}</div>` : ''}
          <div class="inline-fields">
            <div class="field"><label>Spend goal (budget)</label><input id="g-spend" type="number" step="any" min="0" value="${row ? esc(row.goal_spend) : 0}" ${canEditGoal ? '' : 'disabled'} /></div>
            <div class="field"><label>Expected revenue</label><input id="g-rev" type="number" step="any" min="0" value="${row ? esc(row.goal_revenue) : 0}" ${canEditGoal ? '' : 'disabled'} /></div>
            <div class="field"><label>Expected profit</label><input id="g-profit" type="number" step="any" value="${row ? esc(row.goal_profit) : 0}" ${canEditGoal ? '' : 'disabled'} /></div>
            <div class="field"><label>Weeks</label><input id="g-weeks" type="number" min="1" max="6" value="${weeks}" ${canEditGoal ? '' : 'disabled'} /></div>
          </div>
          <div class="flex no-print">
            ${canEditGoal ? `<button class="btn" id="saveGoal">Save goal</button>` : ''}
            ${isSelf && me.role !== 'manager' && (!row || ['draft', 'rejected'].includes(gs)) ? `<button class="btn secondary" id="submitGoal">Submit for approval</button>` : ''}
            ${approver ? `<button class="btn" id="approveGoal">Approve</button><button class="btn danger" id="rejectGoal">Reject…</button>` : ''}
            <div class="spacer"></div>
            ${isAdmin ? `<button class="btn ${locked ? 'secondary' : 'danger'}" id="lockBtn">${locked ? 'Unlock month' : 'Lock month'}</button>` : ''}
          </div>
        </div>

        <div class="panel"><h2>Weekly performance chart</h2><canvas id="weekChart" height="170"></canvas></div>
      </div>

      <div class="panel">
        <h2>Weekly actuals</h2>
        <div class="tbl-wrap"><table class="tbl week-grid">
          <thead><tr><th>Week</th><th>Spend</th><th>Revenue</th><th>Profit</th><th>Reason (if missed)</th><th>Note</th><th></th></tr></thead>
          <tbody>${weeklyRows.join('')}</tbody>
        </table></div>
      </div>

      <div class="grid cols-2">
        <div class="panel">
          <h2>Feedback thread</h2>
          <div id="commentsBox">
            ${comments.length ? comments.map((c) => `
              <div class="comment">
                <div class="meta"><b>${esc(c.author_name)}</b> (${esc(c.author_role)})
                ${c.week_index != null ? `· W${c.week_index + 1}` : ''} · ${esc((c.created_at || '').slice(0, 16).replace('T', ' '))}</div>
                <div>${esc(c.text)}</div>
              </div>`).join('') : '<div class="muted">No feedback yet.</div>'}
          </div>
          <div class="mt no-print">
            <div class="inline-fields">
              <div class="field" style="flex:3"><input id="c-text" placeholder="Write a comment…" /></div>
              <div class="field" style="flex:1">
                <select id="c-week"><option value="">whole month</option>
                  ${Array.from({ length: weeks }, (_, i) => `<option value="${i}">W${i + 1}</option>`).join('')}
                </select>
              </div>
            </div>
            <button class="btn small" id="c-send">Post comment</button>
          </div>
        </div>

        <div class="panel">
          <h2>Reviews & rating</h2>
          ${d.reviews.length ? d.reviews.map((rv) => `
            <div class="comment">
              <div class="meta"><b>${esc(rv.author_name)}</b> · ${esc(rv.month)} ${rv.rating ? '· ' + stars(rv.rating) : ''}</div>
              <div>${esc(rv.text || '')}</div>
            </div>`).join('') : '<div class="muted">No reviews for this month yet.</div>'}
          ${canRate ? `
            <div class="mt no-print">
              <div class="inline-fields">
                <div class="field" style="flex:1"><label>Rating</label>
                  <select id="r-rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n} ★</option>`).join('')}</select>
                </div>
                <div class="field" style="flex:3"><label>Feedback</label><input id="r-text" placeholder="Written feedback" /></div>
              </div>
              <button class="btn small" id="r-send">Save rating</button>
            </div>` : ''}

          <h3 class="mt">Self-review</h3>
          ${isSelf
            ? `<div class="field no-print"><textarea id="sr-text">${esc(row ? row.self_review || '' : '')}</textarea></div>
               <button class="btn small no-print" id="sr-save">Save self-review</button>`
            : `<div>${row && row.self_review ? esc(row.self_review) : '<span class="muted">Not written yet.</span>'}</div>`}

          <h3 class="mt">Meeting notes</h3>
          ${(row && row.meetings.length) ? row.meetings.map((mt) => `
            <div class="comment"><div class="meta">${esc(mt.date)} · ${esc(mt.author || '')}</div><div>${esc(mt.text)}</div></div>`).join('')
            : '<div class="muted">None.</div>'}
          ${['admin', 'manager', 'leader'].includes(me.role) ? `
            <div class="mt no-print flex">
              <input id="mt-text" placeholder="Add meeting note…" style="flex:1; padding:8px 10px; border:1px solid var(--border); border-radius:8px;" />
              <button class="btn small" id="mt-add">Add</button>
            </div>` : ''}
        </div>
      </div>
    `);

    // chart
    if (row) {
      const labels = Array.from({ length: weeks }, (_, i) => `W${i + 1}`);
      const val = (k) => row.weekly.map((w) => (w ? Number(w[k]) || 0 : null));
      makeChart('weekChart', {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Spend', data: val('spend'), backgroundColor: '#93b4f7' },
            { label: 'Revenue', data: val('revenue'), backgroundColor: '#2f6fed' },
            { label: 'Profit', data: val('profit'), backgroundColor: '#16a34a' },
          ],
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } },
      });
    }

    // handlers
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

    on('saveGoal', async () => {
      try {
        await api(`/month/${u.id}/${S.month}/goal`, {
          method: 'PUT',
          body: {
            goal_spend: Number(document.getElementById('g-spend').value) || 0,
            goal_revenue: Number(document.getElementById('g-rev').value) || 0,
            goal_profit: Number(document.getElementById('g-profit').value) || 0,
            weeks: Number(document.getElementById('g-weeks').value) || 4,
          },
        });
        toast('Goal saved'); route();
      } catch (e) { toast(e.message, true); }
    });

    on('submitGoal', async () => {
      try { await api(`/month/${u.id}/${S.month}/submit`, { method: 'POST' }); toast('Submitted for approval'); route(); }
      catch (e) { toast(e.message, true); }
    });

    on('approveGoal', async () => {
      try { const r2 = await api(`/month/${u.id}/${S.month}/approve`, { method: 'POST' }); toast(`Approved → ${r2.goal_status}`); route(); }
      catch (e) { toast(e.message, true); }
    });

    on('rejectGoal', async () => {
      const remark = prompt('Rejection remark (required):');
      if (!remark) return;
      try { await api(`/month/${u.id}/${S.month}/reject`, { method: 'POST', body: { remark } }); toast('Rejected'); route(); }
      catch (e) { toast(e.message, true); }
    });

    on('lockBtn', async () => {
      try { await api(`/month/${u.id}/${S.month}/lock`, { method: 'POST', body: { locked: !locked } }); toast(locked ? 'Unlocked' : 'Locked'); route(); }
      catch (e) { toast(e.message, true); }
    });

    document.querySelectorAll('.w-save').forEach((btn) => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        const i = Number(tr.dataset.week);
        try {
          await api(`/month/${u.id}/${S.month}/week/${i}`, {
            method: 'PUT',
            body: {
              spend: Number(tr.querySelector('.w-spend').value) || 0,
              revenue: Number(tr.querySelector('.w-rev').value) || 0,
              profit: Number(tr.querySelector('.w-profit').value) || 0,
              reason: tr.querySelector('.w-reason').value || null,
              note: tr.querySelector('.w-note').value || null,
            },
          });
          toast(`Week ${i + 1} saved`); route();
        } catch (e) { toast(e.message, true); }
      };
    });

    on('c-send', async () => {
      const text = document.getElementById('c-text').value.trim();
      if (!text) return;
      const wv = document.getElementById('c-week').value;
      try {
        await api(`/comments/${u.id}/${S.month}`, { method: 'POST', body: { text, week_index: wv === '' ? null : Number(wv) } });
        route();
      } catch (e) { toast(e.message, true); }
    });

    on('r-send', async () => {
      try {
        await api(`/reviews/${u.id}/${S.month}`, {
          method: 'POST',
          body: { rating: Number(document.getElementById('r-rating').value), text: document.getElementById('r-text').value },
        });
        toast('Rating saved'); route();
      } catch (e) { toast(e.message, true); }
    });

    on('sr-save', async () => {
      try {
        await api(`/month/${u.id}/${S.month}/self-review`, { method: 'PUT', body: { text: document.getElementById('sr-text').value } });
        toast('Self-review saved');
      } catch (e) { toast(e.message, true); }
    });

    on('mt-add', async () => {
      const text = document.getElementById('mt-text').value.trim();
      if (!text) return;
      try { await api(`/month/${u.id}/${S.month}/meeting`, { method: 'POST', body: { text } }); route(); }
      catch (e) { toast(e.message, true); }
    });
  }

  // ---------- overview board ----------
  async function renderOverview() {
    let d;
    try { d = await api(`/overview?month=${S.month}`); }
    catch (err) { return shell('Overview Board', `<div class="panel">${esc(err.message)}</div>`); }

    const verts = [...new Set(d.cards.map((c) => c.leader.vertical).filter(Boolean))];
    let pendingHtml = '';
    try {
      const pf = await api(`/pending-fills?month=${S.month}`);
      if (pf.pending.length) {
        pendingHtml = `
          <div class="panel">
            <h2>Pending weekly fills</h2>
            <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Person</th><th>Vertical</th><th class="num">Filled</th><th class="num">Expected</th></tr></thead>
            <tbody>${pf.pending.map((p) => `<tr><td><a href="#/dashboard/${p.user_id}">${esc(p.name)}</a></td><td>${esc(p.vertical || '')}</td><td class="num">${p.filled}</td><td class="num">${p.expected}</td></tr>`).join('')}</tbody></table></div>
          </div>`;
      }
    } catch { /* noop */ }

    shell('Overview Board', `
      <div class="flex no-print" style="margin-bottom:12px">
        <label class="muted">Vertical</label>
        <select id="vertFilter">
          <option value="">All verticals</option>
          ${verts.map((v) => `<option>${esc(v)}</option>`).join('')}
        </select>
      </div>
      <div class="grid cards" id="cards">
        ${d.cards.map(cardHtml).join('') || '<div class="muted">No teams found.</div>'}
      </div>
      ${pendingHtml}
    `);

    function cardHtml(c) {
      return `
        <div class="card status-${c.status}" data-vert="${esc(c.leader.vertical || '')}" onclick="location.hash='#/dashboard/${c.leader.id}'">
          <div class="name">${esc(c.leader.name)}</div>
          <div class="sub">${esc(c.leader.vertical || 'no vertical')} · ${c.members} member${c.members === 1 ? '' : 's'}</div>
          <div style="margin-bottom:6px">${badge(STATUS, c.status)}</div>
          <div class="row"><span class="muted">Revenue vs target</span><b>${pct(c.revPct)}</b></div>
          <div class="row"><span class="muted">Revenue</span><span>${fmt(c.revenue)} / ${fmt(c.goal_revenue)}</span></div>
          <div class="row"><span class="muted">Spend</span><span>${fmt(c.spend)}</span></div>
          <div class="row"><span class="muted">Profit</span><span>${fmt(c.profit)}</span></div>
          <div class="row"><span class="muted">Weeks filled</span><span>${c.weeksFilled}</span></div>
        </div>`;
    }

    document.getElementById('vertFilter').onchange = (e) => {
      const v = e.target.value;
      document.querySelectorAll('#cards .card').forEach((el) => {
        el.style.display = !v || el.dataset.vert === v ? '' : 'none';
      });
    };
  }

  // ---------- team & users ----------
  async function renderTeam() {
    await refreshShared();
    const me = S.me;
    const users = S.users;
    const leaders = users.filter((u) => u.role === 'leader');
    const roleOptions = me.role === 'admin'
      ? ['member', 'leader', 'manager', 'admin']
      : me.role === 'manager' ? ['member', 'leader'] : ['member'];

    const distributeHtml = me.role === 'leader' ? `
      <div class="panel">
        <h2>Distribute targets — ${esc(S.month)}</h2>
        <p class="muted">Set each member's monthly goal. Distributed goals go straight to admin approval.</p>
        <div class="tbl-wrap"><table class="tbl" id="distTbl">
          <thead><tr><th>Member</th><th>Spend goal</th><th>Expected revenue</th><th>Expected profit</th><th>Weeks</th></tr></thead>
          <tbody>
            ${users.filter((u) => u.role === 'member').map((u2) => `
              <tr data-uid="${u2.id}">
                <td>${esc(u2.name)}</td>
                <td><input type="number" step="any" min="0" class="d-spend" style="width:110px" /></td>
                <td><input type="number" step="any" min="0" class="d-rev" style="width:110px" /></td>
                <td><input type="number" step="any" class="d-profit" style="width:110px" /></td>
                <td><input type="number" min="1" max="6" value="4" class="d-weeks" style="width:60px" /></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
        <div class="flex mt">
          <button class="btn" id="distSend">Distribute</button>
          <div id="distTally" class="muted"></div>
        </div>
      </div>` : '';

    shell('Team & Users', `
      ${distributeHtml}
      <div class="grid cols-2">
        <div class="panel">
          <h2>People you can see</h2>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Vertical</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${users.map((u) => `
                <tr>
                  <td><a href="#/dashboard/${u.id}">${esc(u.name)}</a></td>
                  <td class="muted">${esc(u.username)}</td>
                  <td>${esc(u.role)}</td>
                  <td>${esc(u.vertical || '')}</td>
                  <td>${u.active ? '<span class="badge green">active</span>' : '<span class="badge red">disabled</span>'}</td>
                  <td class="no-print">
                    ${(me.role === 'admin' || (u.id !== me.id && ['manager', 'leader'].includes(me.role)))
                      ? `<button class="btn small secondary u-reset" data-uid="${u.id}">Reset PW</button>
                         ${u.id !== me.id ? `<button class="btn small ${u.active ? 'danger' : ''}" data-uid="${u.id}" data-active="${u.active}" data-act="toggle">${u.active ? 'Disable' : 'Enable'}</button>` : ''}`
                      : ''}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table></div>
        </div>

        <div class="panel">
          <h2>Create user</h2>
          <form id="newUser">
            <div class="inline-fields">
              <div class="field"><label>Full name</label><input id="nu-name" required /></div>
              <div class="field"><label>Username</label><input id="nu-username" required /></div>
            </div>
            <div class="inline-fields">
              <div class="field"><label>Password</label><input id="nu-password" type="text" required minlength="6" /></div>
              <div class="field"><label>Role</label>
                <select id="nu-role">${roleOptions.map((r) => `<option>${r}</option>`).join('')}</select>
              </div>
            </div>
            <div class="inline-fields">
              <div class="field"><label>Vertical</label>
                <select id="nu-vertical"><option value="">—</option>${S.verticals.map((v) => `<option>${esc(v)}</option>`).join('')}</select>
              </div>
              <div class="field" id="nu-leader-wrap" style="display:none"><label>Assign to leader</label>
                <select id="nu-leader">${leaders.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
              </div>
            </div>
            <button class="btn" type="submit">Create user</button>
          </form>
          <p class="muted mt">
            ${me.role === 'leader' ? 'New members are automatically assigned to your team.' : ''}
            ${me.role === 'manager' ? 'New leaders are automatically assigned under you. For members, pick one of your leaders.' : ''}
          </p>
        </div>
      </div>
    `);

    // show/hide leader picker
    const roleSel = document.getElementById('nu-role');
    const leaderWrap = document.getElementById('nu-leader-wrap');
    const syncLeaderPick = () => {
      leaderWrap.style.display =
        roleSel.value === 'member' && (me.role === 'admin' || me.role === 'manager') && leaders.length ? '' : 'none';
    };
    roleSel.onchange = syncLeaderPick; syncLeaderPick();

    document.getElementById('newUser').onsubmit = async (e) => {
      e.preventDefault();
      const role = roleSel.value;
      const body = {
        name: document.getElementById('nu-name').value,
        username: document.getElementById('nu-username').value,
        password: document.getElementById('nu-password').value,
        role,
        vertical: document.getElementById('nu-vertical').value || null,
      };
      if (role === 'member' && leaderWrap.style.display !== 'none') {
        body.leader_id = Number(document.getElementById('nu-leader').value);
      }
      try { await api('/users', { method: 'POST', body }); toast('User created'); route(); }
      catch (err) { toast(err.message, true); }
    };

    document.querySelectorAll('.u-reset').forEach((b) => {
      b.onclick = async () => {
        const pw = prompt('New password (min 6 chars):');
        if (!pw) return;
        try { await api(`/users/${b.dataset.uid}`, { method: 'PATCH', body: { password: pw } }); toast('Password reset'); }
        catch (err) { toast(err.message, true); }
      };
    });
    document.querySelectorAll('[data-act="toggle"]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/users/${b.dataset.uid}`, { method: 'PATCH', body: { active: b.dataset.active !== '1' } });
          toast('Updated'); route();
        } catch (err) { toast(err.message, true); }
      };
    });

    const distBtn = document.getElementById('distSend');
    if (distBtn) {
      distBtn.onclick = async () => {
        const rows = [];
        document.querySelectorAll('#distTbl tbody tr').forEach((tr) => {
          const spend = Number(tr.querySelector('.d-spend').value) || 0;
          const rev = Number(tr.querySelector('.d-rev').value) || 0;
          const profit = Number(tr.querySelector('.d-profit').value) || 0;
          if (spend || rev || profit) {
            rows.push({
              user_id: Number(tr.dataset.uid), goal_spend: spend, goal_revenue: rev,
              goal_profit: profit, weeks: Number(tr.querySelector('.d-weeks').value) || 4,
            });
          }
        });
        if (!rows.length) return toast('Enter at least one allocation', true);
        try {
          const d = await api('/distribute', { method: 'POST', body: { month: S.month, rows } });
          const t = document.getElementById('distTally');
          t.textContent = `Allocated: spend ${fmt(d.allocated.spend)}, revenue ${fmt(d.allocated.revenue)}, profit ${fmt(d.allocated.profit)}`
            + (d.leaderGoal ? ` — your team goal: spend ${fmt(d.leaderGoal.spend)}, revenue ${fmt(d.leaderGoal.revenue)}, profit ${fmt(d.leaderGoal.profit)}` : '');
          toast('Targets distributed (pending admin approval)');
        } catch (err) { toast(err.message, true); }
      };
    }
  }

  // ---------- approvals ----------
  async function renderApprovals() {
    let d;
    try { d = await api('/approvals'); }
    catch (err) { return shell('Approvals', `<div class="panel">${esc(err.message)}</div>`); }

    shell('Approvals', `
      <div class="panel">
        <h2>Pending goal approvals</h2>
        ${d.items.length ? `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Person</th><th>Month</th><th>Status</th><th class="num">Spend</th><th class="num">Revenue</th><th class="num">Profit</th><th class="num">Weeks</th><th></th></tr></thead>
            <tbody>
              ${d.items.map((it) => `
                <tr>
                  <td><a href="#/dashboard/${it.user_id}">${esc(it.name)}</a></td>
                  <td>${esc(it.month)}</td>
                  <td>${badge(GOAL_STATUS, it.goal_status)}</td>
                  <td class="num">${fmt(it.goal_spend)}</td>
                  <td class="num">${fmt(it.goal_revenue)}</td>
                  <td class="num">${fmt(it.goal_profit)}</td>
                  <td class="num">${it.weeks}</td>
                  <td class="no-print">
                    <button class="btn small a-ok" data-uid="${it.user_id}" data-m="${esc(it.month)}">Approve</button>
                    <button class="btn small danger a-no" data-uid="${it.user_id}" data-m="${esc(it.month)}">Reject</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table></div>` : '<div class="muted">Nothing pending. 🎉</div>'}
      </div>
    `, { showMonth: false });

    document.querySelectorAll('.a-ok').forEach((b) => {
      b.onclick = async () => {
        try { await api(`/month/${b.dataset.uid}/${b.dataset.m}/approve`, { method: 'POST' }); toast('Approved'); route(); }
        catch (err) { toast(err.message, true); }
      };
    });
    document.querySelectorAll('.a-no').forEach((b) => {
      b.onclick = async () => {
        const remark = prompt('Rejection remark (required):');
        if (!remark) return;
        try { await api(`/month/${b.dataset.uid}/${b.dataset.m}/reject`, { method: 'POST', body: { remark } }); toast('Rejected'); route(); }
        catch (err) { toast(err.message, true); }
      };
    });
  }

  // ---------- reports ----------
  async function renderReports() {
    const me = S.me;
    const tabs = ['Trend', 'Verticals', 'Leaderboard'];
    if (me.role !== 'member') tabs.push('Reasons');
    if (me.role === 'admin') tabs.push('Company');
    S.reportTab = S.reportTab && tabs.includes(S.reportTab) ? S.reportTab : 'Trend';

    shell('Reports', `
      <div class="tabs no-print">
        ${tabs.map((t) => `<button data-tab="${t}" class="${S.reportTab === t ? 'active' : ''}">${t}</button>`).join('')}
      </div>
      <div id="reportBody"><div class="muted">Loading…</div></div>
    `);

    document.querySelectorAll('.tabs button').forEach((b) => {
      b.onclick = () => { S.reportTab = b.dataset.tab; renderReports(); };
    });

    const body = document.getElementById('reportBody');
    try {
      if (S.reportTab === 'Trend') await tabTrend(body);
      else if (S.reportTab === 'Verticals') await tabVerticals(body);
      else if (S.reportTab === 'Leaderboard') await tabLeaderboard(body);
      else if (S.reportTab === 'Reasons') await tabReasons(body);
      else if (S.reportTab === 'Company') await tabCompany(body);
    } catch (err) {
      body.innerHTML = `<div class="panel">${esc(err.message)}</div>`;
    }
  }

  async function tabTrend(body) {
    const canPick = S.me.role !== 'member' && S.users.length > 1;
    S.trendUser = S.trendUser || S.me.id;
    body.innerHTML = `
      <div class="panel">
        <div class="flex no-print" style="margin-bottom:10px">
          ${canPick ? `<label class="muted">Person</label>
            <select id="trendUser">${S.users.map((u) => `<option value="${u.id}" ${u.id === S.trendUser ? 'selected' : ''}>${esc(u.name)} (${esc(u.role)})</option>`).join('')}</select>` : ''}
          <label class="muted">Months</label>
          <select id="trendN">${[3, 6, 12].map((n) => `<option ${n === (S.trendN || 6) ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </div>
        <canvas id="trendChart" height="120"></canvas>
      </div>`;
    const d = await api(`/reports/trend?user_id=${S.trendUser}&n=${S.trendN || 6}&month=${S.month}`);
    makeChart('trendChart', {
      type: 'line',
      data: {
        labels: d.data.map((x) => x.month),
        datasets: [
          { label: 'Revenue', data: d.data.map((x) => x.revenue), borderColor: '#2f6fed', tension: 0.25 },
          { label: 'Spend', data: d.data.map((x) => x.spend), borderColor: '#93b4f7', tension: 0.25 },
          { label: 'Profit', data: d.data.map((x) => x.profit), borderColor: '#16a34a', tension: 0.25 },
          { label: 'Revenue goal', data: d.data.map((x) => x.goal_revenue), borderColor: '#9aa5b5', borderDash: [6, 4], pointRadius: 0 },
        ],
      },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } },
    });
    const tu = document.getElementById('trendUser');
    if (tu) tu.onchange = () => { S.trendUser = Number(tu.value); renderReports(); };
    document.getElementById('trendN').onchange = (e) => { S.trendN = Number(e.target.value); renderReports(); };
  }

  async function tabVerticals(body) {
    const d = await api(`/reports/vertical?month=${S.month}`);
    body.innerHTML = `
      <div class="panel">
        <h2>Vertical roll-up — ${esc(d.month)}</h2>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Vertical</th><th class="num">People</th><th class="num">Spend</th><th class="num">Revenue</th><th class="num">Profit</th><th class="num">ROAS</th><th class="num">Rev vs target</th></tr></thead>
          <tbody>
            ${d.verticals.map((v) => `
              <tr><td><b>${esc(v.vertical)}</b></td><td class="num">${v.people}</td>
              <td class="num">${fmt(v.spend)}</td><td class="num">${fmt(v.revenue)}</td>
              <td class="num">${fmt(v.profit)}</td><td class="num">${fmt2(v.roas)}</td>
              <td class="num">${pct(v.revPct)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No data.</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
  }

  async function tabLeaderboard(body) {
    const d = await api(`/reports/leaderboard?month=${S.month}`);
    const limited = S.me.role === 'member';
    body.innerHTML = `
      <div class="panel">
        <h2>Leaderboard — ${esc(d.month)}</h2>
        <p class="muted">Composite score = average of revenue %, profit % and budget delivery %.</p>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th class="num">#</th><th>Name</th><th>Role</th><th>Vertical</th><th class="num">Score</th>
            ${limited ? '' : '<th class="num">Rev %</th><th class="num">Profit %</th><th class="num">Budget %</th><th class="num">Revenue</th><th class="num">Profit</th>'}</tr></thead>
          <tbody>
            ${d.rows.map((r) => `
              <tr ${r.user_id === S.me.id ? 'style="background:#f0f6ff"' : ''}>
                <td class="num">${r.rank}</td><td>${esc(r.name)}</td><td>${esc(r.role)}</td><td>${esc(r.vertical || '')}</td>
                <td class="num"><b>${r.score.toFixed(1)}</b></td>
                ${limited ? '' : `<td class="num">${pct(r.revPct)}</td><td class="num">${pct(r.profitPct)}</td><td class="num">${pct(r.budgetPct)}</td><td class="num">${fmt(r.revenue)}</td><td class="num">${fmt(r.profit)}</td>`}
              </tr>`).join('') || '<tr><td colspan="10" class="muted">No data.</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
  }

  async function tabReasons(body) {
    const d = await api(`/reports/reasons?month=${S.month}`);
    const total = d.reasons.reduce((s, x) => s + x.count, 0);
    body.innerHTML = `
      <div class="panel">
        <h2>Miss-reason analysis — ${esc(d.month)}</h2>
        ${d.reasons.length ? `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Reason</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
            <tbody>${d.reasons.map((x) => `<tr><td>${esc(x.reason)}</td><td class="num">${x.count}</td><td class="num">${pct((x.count / total) * 100)}</td></tr>`).join('')}</tbody>
          </table></div>` : '<div class="muted">No reason codes recorded this month.</div>'}
      </div>`;
  }

  async function tabCompany(body) {
    const d = await api(`/reports/company?month=${S.month}`);
    body.innerHTML = `
      <div class="metrics">
        <div class="metric"><div class="label">Total spend</div><div class="value">${fmt(d.totals.spend)}</div><div class="sub">${pct(d.targetVsActual.spendPct)} of target</div></div>
        <div class="metric"><div class="label">Total revenue</div><div class="value">${fmt(d.totals.revenue)}</div><div class="sub">${pct(d.targetVsActual.revenuePct)} of target</div></div>
        <div class="metric"><div class="label">Total profit</div><div class="value">${fmt(d.totals.profit)}</div><div class="sub">${pct(d.targetVsActual.profitPct)} of target</div></div>
        <div class="metric"><div class="label">Blended ROAS</div><div class="value">${fmt2(d.blendedRoas)}</div></div>
        <div class="metric"><div class="label">MoM revenue</div><div class="value">${pct(d.mom.revenuePct)}</div><div class="sub">vs ${esc(d.mom.prevMonth)}</div></div>
        <div class="metric"><div class="label">MoM profit</div><div class="value">${pct(d.mom.profitPct)}</div><div class="sub">vs ${esc(d.mom.prevMonth)}</div></div>
      </div>
      <div class="panel">
        <h2>Profit by vertical — ${esc(d.month)}</h2>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Vertical</th><th class="num">Spend</th><th class="num">Revenue</th><th class="num">Profit</th><th class="num">ROAS</th></tr></thead>
          <tbody>
            ${d.profitByVertical.map((v) => `
              <tr ${v.vertical === 'All verticals' ? 'style="font-weight:700; border-top:2px solid var(--border)"' : ''}>
                <td>${esc(v.vertical)}</td><td class="num">${fmt(v.spend)}</td><td class="num">${fmt(v.revenue)}</td>
                <td class="num">${fmt(v.profit)}</td><td class="num">${v.spend > 0 ? fmt2(v.revenue / v.spend) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
  }

  // ---------- appraisal (admin) ----------
  async function renderAppraisal(userId) {
    if (S.me.role !== 'admin') return shell('Appraisal', '<div class="panel">Admin only.</div>');
    await refreshShared();
    const people = S.users.filter((u) => u.role !== 'admin');
    userId = userId || (people[0] && people[0].id);

    if (!userId) return shell('Appraisal', '<div class="panel">No users yet.</div>', { showMonth: false });

    let d;
    try { d = await api(`/appraisal/${userId}`); }
    catch (err) { return shell('Appraisal', `<div class="panel">${esc(err.message)}</div>`, { showMonth: false }); }

    shell(`Appraisal — ${d.user.name}`, `
      <div class="flex no-print" style="margin-bottom:12px">
        <select id="apUser">${people.map((u) => `<option value="${u.id}" ${u.id === userId ? 'selected' : ''}>${esc(u.name)} (${esc(u.role)})</option>`).join('')}</select>
        <button class="btn secondary" onclick="window.print()">Print</button>
      </div>

      <div class="metrics">
        <div class="metric"><div class="label">Overall score</div><div class="value">${d.overallScore.toFixed(1)}</div></div>
        <div class="metric"><div class="label">Target hit-rate</div><div class="value">${pct(d.targetHitRate)}</div></div>
        <div class="metric"><div class="label">Total profit contributed</div><div class="value">${fmt(d.totalProfit)}</div></div>
        <div class="metric"><div class="label">Average rating</div><div class="value">${d.avgRating ? d.avgRating.toFixed(1) + ' / 5' : '—'}</div><div class="sub">${d.avgRating ? stars(d.avgRating) : ''}</div></div>
        ${d.team ? `<div class="metric"><div class="label">Team (as leader)</div><div class="value">${d.team.members}</div><div class="sub">team profit ${fmt(d.team.totalProfit)}</div></div>` : ''}
      </div>

      <div class="panel"><h2>Performance trend</h2><canvas id="apChart" height="110"></canvas></div>

      <div class="panel">
        <h2>Month by month</h2>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Month</th><th class="num">Spend</th><th class="num">Revenue</th><th class="num">Profit</th>
            <th class="num">Rev %</th><th class="num">ROAS</th><th class="num">Margin</th><th class="num">Score</th><th>Goal</th><th>Self-review</th></tr></thead>
          <tbody>
            ${d.months.map((m) => `
              <tr>
                <td>${esc(m.month)}</td><td class="num">${fmt(m.spend)}</td><td class="num">${fmt(m.revenue)}</td>
                <td class="num">${fmt(m.profit)}</td><td class="num">${pct(m.revPct)}</td><td class="num">${fmt2(m.roas)}</td>
                <td class="num">${pct(m.marginPct)}</td><td class="num">${m.score.toFixed(1)}</td>
                <td>${badge(GOAL_STATUS, m.goal_status)}${m.locked ? ' <span class="badge gray">locked</span>' : ''}</td>
                <td class="muted" style="max-width:220px">${esc((m.self_review || '').slice(0, 120))}</td>
              </tr>`).join('') || '<tr><td colspan="10" class="muted">No months recorded.</td></tr>'}
          </tbody>
        </table></div>
      </div>

      <div class="panel">
        <h2>Manager & leader feedback</h2>
        ${d.reviews.length ? d.reviews.map((rv) => `
          <div class="comment">
            <div class="meta"><b>${esc(rv.author_name)}</b> · ${esc(rv.month)} ${rv.rating ? '· ' + stars(rv.rating) : ''}</div>
            <div>${esc(rv.text || '')}</div>
          </div>`).join('') : '<div class="muted">No feedback recorded.</div>'}
      </div>
    `, { showMonth: false });

    makeChart('apChart', {
      type: 'line',
      data: {
        labels: d.months.map((m) => m.month),
        datasets: [
          { label: 'Revenue', data: d.months.map((m) => m.revenue), borderColor: '#2f6fed', tension: 0.25 },
          { label: 'Profit', data: d.months.map((m) => m.profit), borderColor: '#16a34a', tension: 0.25 },
          { label: 'Score', data: d.months.map((m) => m.score), borderColor: '#d97706', yAxisID: 'y2', tension: 0.25 },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } },
        scales: { y2: { position: 'right', grid: { drawOnChartArea: false } } },
      },
    });

    document.getElementById('apUser').onchange = (e) => nav(`#/appraisal/${e.target.value}`);
  }

  // ---------- coupons ----------
  async function renderCoupons() {
    let d;
    try { d = await api('/coupons'); }
    catch (err) { return shell('Coupons', `<div class="panel">${esc(err.message)}</div>`); }
    const canManage = ['admin', 'manager', 'leader'].includes(S.me.role);
    const assignable = S.users.filter((u) => u.role === 'member' || u.role === 'leader');

    shell('Coupons', `
      <div class="grid ${canManage ? 'cols-2' : ''}">
        <div class="panel">
          <h2>Coupons</h2>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Code</th><th>Brand</th><th>Vertical</th><th>Discount</th><th>Valid</th><th>Assigned</th><th>Status</th>${canManage ? '<th></th>' : ''}</tr></thead>
            <tbody>
              ${d.coupons.map((c) => `
                <tr>
                  <td><b>${esc(c.code)}</b></td><td>${esc(c.brand || '')}</td><td>${esc(c.vertical || '')}</td>
                  <td>${esc(c.discount || '')}</td>
                  <td class="muted">${esc(c.valid_from || '?')} → ${esc(c.expiry || '?')}</td>
                  <td>${esc(c.assigned_name || '—')}</td>
                  <td>${badge({ active: ['active', 'green'], paused: ['paused', 'amber'], expired: ['expired', 'red'], used: ['used', 'gray'] }, c.status)}</td>
                  ${canManage ? `<td class="no-print">
                    <select class="cp-status" data-id="${c.id}">
                      ${['active', 'paused', 'expired', 'used'].map((s) => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                  </td>` : ''}
                </tr>`).join('') || `<tr><td colspan="8" class="muted">No coupons visible to you.</td></tr>`}
            </tbody>
          </table></div>
        </div>

        ${canManage ? `
        <div class="panel">
          <h2>New coupon</h2>
          <form id="newCoupon">
            <div class="inline-fields">
              <div class="field"><label>Code</label><input id="cp-code" required /></div>
              <div class="field"><label>Brand / offer</label><input id="cp-brand" /></div>
            </div>
            <div class="inline-fields">
              <div class="field"><label>Vertical</label>
                <select id="cp-vertical"><option value="">—</option>${S.verticals.map((v) => `<option>${esc(v)}</option>`).join('')}</select></div>
              <div class="field"><label>Discount</label><input id="cp-discount" placeholder="e.g. 20% off" /></div>
            </div>
            <div class="inline-fields">
              <div class="field"><label>Valid from</label><input id="cp-from" type="date" /></div>
              <div class="field"><label>Expiry</label><input id="cp-exp" type="date" /></div>
            </div>
            <div class="inline-fields">
              <div class="field"><label>Assign to</label>
                <select id="cp-assign"><option value="">—</option>${assignable.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
              <div class="field"><label>Note</label><input id="cp-note" /></div>
            </div>
            <button class="btn" type="submit">Create coupon</button>
          </form>
        </div>` : ''}
      </div>
    `, { showMonth: false });

    if (canManage) {
      document.getElementById('newCoupon').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/coupons', {
            method: 'POST',
            body: {
              code: document.getElementById('cp-code').value,
              brand: document.getElementById('cp-brand').value,
              vertical: document.getElementById('cp-vertical').value || null,
              discount: document.getElementById('cp-discount').value,
              valid_from: document.getElementById('cp-from').value || null,
              expiry: document.getElementById('cp-exp').value || null,
              assigned_to: document.getElementById('cp-assign').value || null,
              note: document.getElementById('cp-note').value,
            },
          });
          toast('Coupon created'); route();
        } catch (err) { toast(err.message, true); }
      };
      document.querySelectorAll('.cp-status').forEach((sel) => {
        sel.onchange = async () => {
          try { await api(`/coupons/${sel.dataset.id}`, { method: 'PATCH', body: { status: sel.value } }); toast('Status updated'); }
          catch (err) { toast(err.message, true); route(); }
        };
      });
    }
  }

  // ---------- verticals ----------
  async function renderVerticals() {
    const v = await api('/verticals').catch(() => ({ approved: [], pending: [] }));
    const isAdmin = S.me.role === 'admin';
    shell('Verticals', `
      <div class="grid cols-2">
        <div class="panel">
          <h2>Approved verticals</h2>
          ${v.approved.map((n) => `<span class="badge blue" style="margin:3px">${esc(n)}</span>`).join('') || '<div class="muted">None.</div>'}
          <div class="mt no-print flex">
            <input id="nv-name" placeholder="New vertical name" style="flex:1; padding:8px 10px; border:1px solid var(--border); border-radius:8px;" />
            <button class="btn" id="nv-add">${isAdmin ? 'Add' : 'Propose'}</button>
          </div>
          ${!isAdmin ? '<p class="muted mt">Proposals need admin approval before the vertical becomes usable.</p>' : ''}
        </div>
        <div class="panel">
          <h2>Pending proposals</h2>
          ${(v.pending || []).length ? (v.pending || []).map((p) => `
            <div class="flex" style="padding:6px 0; border-bottom:1px solid var(--border)">
              <b>${esc(p.name)}</b>
              <span class="muted">${esc(p.requested_by_name || '')}</span>
              <div class="spacer"></div>
              ${isAdmin ? `
                <button class="btn small nv-ok" data-name="${esc(p.name)}">Approve</button>
                <button class="btn small danger nv-no" data-name="${esc(p.name)}">Reject</button>` : '<span class="badge amber">pending</span>'}
            </div>`).join('') : '<div class="muted">No pending proposals.</div>'}
        </div>
      </div>
    `, { showMonth: false });

    document.getElementById('nv-add').onclick = async () => {
      const name = document.getElementById('nv-name').value.trim();
      if (!name) return;
      try {
        const r2 = await api('/verticals', { method: 'POST', body: { name } });
        toast(r2.status === 'approved' ? 'Vertical added' : 'Proposed — waiting for admin approval');
        await refreshShared(); route();
      } catch (err) { toast(err.message, true); }
    };
    document.querySelectorAll('.nv-ok').forEach((b) => {
      b.onclick = async () => {
        try { await api('/verticals/decide', { method: 'POST', body: { name: b.dataset.name, approve: true } }); await refreshShared(); route(); }
        catch (err) { toast(err.message, true); }
      };
    });
    document.querySelectorAll('.nv-no').forEach((b) => {
      b.onclick = async () => {
        try { await api('/verticals/decide', { method: 'POST', body: { name: b.dataset.name, approve: false } }); await refreshShared(); route(); }
        catch (err) { toast(err.message, true); }
      };
    });
  }

  // ---------- audit ----------
  async function renderAudit() {
    let d;
    try { d = await api('/audit?limit=300'); }
    catch (err) { return shell('Audit Log', `<div class="panel">${esc(err.message)}</div>`, { showMonth: false }); }
    const names = {}; S.users.forEach((u) => { names[u.id] = u.name; });
    shell('Audit Log', `
      <div class="panel">
        <p class="muted">Append-only record of key actions. Newest first.</p>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Month</th><th>Detail</th></tr></thead>
          <tbody>
            ${d.audit.map((a) => `
              <tr>
                <td class="muted">${esc((a.ts || '').slice(0, 19).replace('T', ' '))}</td>
                <td>${esc(a.actor_name || '')}</td>
                <td><span class="badge gray">${esc(a.action)}</span></td>
                <td>${esc(a.target_user ? names[a.target_user] || `#${a.target_user}` : '')}</td>
                <td>${esc(a.month || '')}</td>
                <td class="muted">${esc(a.detail || '')}</td>
              </tr>`).join('') || '<tr><td colspan="6" class="muted">Empty.</td></tr>'}
          </tbody>
        </table></div>
      </div>
    `, { showMonth: false });
  }

  // ---------- settings ----------
  function renderSettings() {
    shell('Settings', `
      <div class="panel" style="max-width:420px">
        <h2>Change password</h2>
        <form id="pwForm">
          <div class="field"><label>Current password</label><input id="pw-old" type="password" required /></div>
          <div class="field"><label>New password (min 6 chars)</label><input id="pw-new" type="password" required minlength="6" /></div>
          <div class="field"><label>Repeat new password</label><input id="pw-new2" type="password" required /></div>
          <button class="btn" type="submit">Update password</button>
        </form>
      </div>
      <div class="panel" style="max-width:420px">
        <h2>Account</h2>
        <p><b>${esc(S.me.name)}</b> · @${esc(S.me.username)}<br />
        Role: ${esc(S.me.role)}${S.me.vertical ? ' · Vertical: ' + esc(S.me.vertical) : ''}</p>
      </div>
    `, { showMonth: false });

    document.getElementById('pwForm').onsubmit = async (e) => {
      e.preventDefault();
      const n1 = document.getElementById('pw-new').value;
      const n2 = document.getElementById('pw-new2').value;
      if (n1 !== n2) return toast('New passwords do not match', true);
      try {
        await api('/password', { method: 'POST', body: { old_password: document.getElementById('pw-old').value, new_password: n1 } });
        toast('Password updated');
        document.getElementById('pwForm').reset();
      } catch (err) { toast(err.message, true); }
    };
  }

  boot();
})();
