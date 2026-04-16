// ─── APP ────────────────────────────────────────────────────────────────────
const App = (() => {
  const DB_NAME = 'bpsc_tracker';
  const DB_VER  = 1;
  const STORE   = 'state';
  const KEY     = 'main';

  let db = null;
  let STATE = {};          // { [dayId]: { studyDate: 'YYYY-MM-DD'|null, revisions: { r1:null, ... } } }
  let HISTORY = [];        // undo stack
  let FUTURE  = [];        // redo stack
  let currentView = 'today';
  let currentSection = 'all';
  let TODAY = new Date();
  TODAY.setHours(0,0,0,0);

  // ── INIT ────────────────────────────────────────────────────────────────
  async function init() {
    await openDB();
    const saved = await loadFromDB();
    STATE = saved || buildFreshState();
    renderDateDisplay();
    renderAll();
    updateUndoRedoBtns();
    setInterval(() => { TODAY = new Date(); TODAY.setHours(0,0,0,0); renderAll(); }, 60000);
  }

  function buildFreshState() {
    const s = {};
    DAYS_DATA.forEach(d => {
      s[d.id] = { studyDate: null, revisions: { r1:null,r2:null,r3:null,r4:null,r5:null,r6:null } };
    });
    // ── Pre-load user data ──
    [8,9,10,11,12].forEach(id => { s[id].studyDate = '2026-04-07'; });
    [13,14,15,16,17].forEach(id => { s[id].studyDate = '2026-04-15'; });
    [8,9].forEach(id => { s[id].revisions.r1 = '2026-04-14'; });
    s[22].studyDate = '2026-04-14';
    return s;
  }

  // ── INDEXEDDB ────────────────────────────────────────────────────────────
  function openDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => { e.target.result.createObjectStore(STORE); };
      req.onsuccess = e => { db = e.target.result; res(); };
      req.onerror   = () => rej();
    });
  }

  function loadFromDB() {
    return new Promise(res => {
      if (!db) { res(null); return; }
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    });
  }

  function saveToDB() {
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(deepClone(STATE), KEY);
    // Also localStorage as fallback
    try { localStorage.setItem('bpsc_state_backup', JSON.stringify(STATE)); } catch(_){}
  }

  // ── UNDO / REDO ──────────────────────────────────────────────────────────
  function snapshot() {
    HISTORY.push(deepClone(STATE));
    if (HISTORY.length > 50) HISTORY.shift();
    FUTURE = [];
    updateUndoRedoBtns();
  }

  function undo() {
    if (!HISTORY.length) return;
    FUTURE.push(deepClone(STATE));
    STATE = HISTORY.pop();
    saveToDB();
    renderAll();
    updateUndoRedoBtns();
    toast('↩ Undone');
  }

  function redo() {
    if (!FUTURE.length) return;
    HISTORY.push(deepClone(STATE));
    STATE = FUTURE.pop();
    saveToDB();
    renderAll();
    updateUndoRedoBtns();
    toast('↪ Redone');
  }

  function updateUndoRedoBtns() {
    document.getElementById('undoBtn').disabled = HISTORY.length === 0;
    document.getElementById('redoBtn').disabled = FUTURE.length === 0;
  }

  // ── DATE HELPERS ─────────────────────────────────────────────────────────
  function fmtISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function fmtDisplay(iso) {
    if (!iso) return '';
    const [y,m,d] = iso.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d} ${months[m-1]} ${String(y).slice(2)}`;
  }

  function fmtShort(iso) {
    if (!iso) return '—';
    const [,m,d] = iso.split('-').map(Number);
    return `${d}/${m}`;
  }

  function addDays(iso, n) {
    const d = new Date(iso);
    d.setDate(d.getDate() + n);
    return fmtISO(d);
  }

  function isToday(iso) {
    if (!iso) return false;
    return iso === fmtISO(TODAY);
  }

  function isPast(iso) {
    if (!iso) return false;
    return iso < fmtISO(TODAY);
  }

  function isFuture(iso) {
    if (!iso) return false;
    return iso > fmtISO(TODAY);
  }

  // ── STATE HELPERS ────────────────────────────────────────────────────────
  function getRevTarget(dayId, revKey) {
    const sd = STATE[dayId].studyDate;
    if (!sd) return null;
    const rv = REV_SCHEDULE.find(r => r.key === revKey);
    return addDays(sd, rv.days);
  }

  function getRevStatus(dayId, revKey) {
    const done = STATE[dayId].revisions[revKey];
    if (done) return 'done';
    const target = getRevTarget(dayId, revKey);
    if (!target) return 'no-study';
    if (isToday(target)) return 'due-today';
    if (isPast(target))  return 'overdue';
    return 'upcoming';
  }

  function isDayActionable(dayId) {
    return REV_SCHEDULE.some(r => {
      const s = getRevStatus(dayId, r.key);
      return s === 'due-today' || s === 'overdue';
    });
  }

  function calcStreak() {
    const todayISO = fmtISO(TODAY);
    let streak = 0;
    let date = new Date(TODAY);
    while (true) {
      const iso = fmtISO(date);
      const hasActivity = DAYS_DATA.some(d => {
        const st = STATE[d.id];
        if (st.studyDate === iso) return true;
        return REV_SCHEDULE.some(r => st.revisions[r.key] === iso);
      });
      if (!hasActivity) break;
      streak++;
      date.setDate(date.getDate() - 1);
    }
    return streak;
  }

  // ── ACTIONS ──────────────────────────────────────────────────────────────
  function markStudied(dayId, dateISO) {
    snapshot();
    STATE[dayId].studyDate = dateISO;
    saveToDB();
    renderAll();
    toast(`✓ Day ${dayId} marked as studied`);
  }

  function unmarkStudied(dayId) {
    snapshot();
    STATE[dayId].studyDate = null;
    STATE[dayId].revisions = { r1:null,r2:null,r3:null,r4:null,r5:null,r6:null };
    saveToDB();
    renderAll();
    toast(`↩ Day ${dayId} study removed`);
  }

  function markRevision(dayId, revKey, dateISO) {
    snapshot();
    STATE[dayId].revisions[revKey] = dateISO;
    saveToDB();
    renderAll();
    toast(`✓ ${revKey.toUpperCase()} done for Day ${dayId}`);
  }

  function unmarkRevision(dayId, revKey) {
    snapshot();
    STATE[dayId].revisions[revKey] = null;
    saveToDB();
    renderAll();
    toast(`↩ ${revKey.toUpperCase()} removed for Day ${dayId}`);
  }

  // ── VIEWS ────────────────────────────────────────────────────────────────
  function setView(v, btn) {
    currentView = v;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1)).classList.add('active');
    const titles = { today: 'Today', all: 'All Days', stats: 'Statistics' };
    document.getElementById('pageTitle').textContent = titles[v];
    renderCurrentView();
  }

  function filterSection(sec, btn) {
    currentSection = sec;
    document.querySelectorAll('.sec-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (currentView !== 'all') setView('all', document.querySelector('[data-view="all"]'));
    else renderAllView();
  }

  function renderAll() {
    renderTodayView();
    if (currentView === 'all')   renderAllView();
    if (currentView === 'stats') renderStatsView();
    renderDateDisplay();
    updateBadges();
  }

  function renderCurrentView() {
    if (currentView === 'today') renderTodayView();
    if (currentView === 'all')   renderAllView();
    if (currentView === 'stats') renderStatsView();
  }

  function renderDateDisplay() {
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    document.getElementById('dateDisplay').textContent =
      `${days[TODAY.getDay()]} ${TODAY.getDate()} ${months[TODAY.getMonth()]} ${TODAY.getFullYear()}`;
    document.getElementById('streakChip').textContent = `🔥 ${calcStreak()}`;
  }

  function updateBadges() {
    const due = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
    const badge = document.getElementById('badge-today');
    badge.textContent = due > 0 ? due : '';
    if (currentView === 'today') {
      document.getElementById('pageSub').textContent =
        due > 0 ? `${due} revision${due>1?'s':''} need attention` : 'All caught up!';
    }
  }

  // ── TODAY VIEW ───────────────────────────────────────────────────────────
  function renderTodayView() {
    const el = document.getElementById('viewToday');

    const studied = DAYS_DATA.filter(d => STATE[d.id].studyDate).length;
    const totalRevDone = DAYS_DATA.reduce((acc,d) => {
      return acc + REV_SCHEDULE.filter(r => STATE[d.id].revisions[r.key]).length;
    }, 0);
    const dueDays = DAYS_DATA.filter(d => isDayActionable(d.id));

    // Collect all due revisions
    const dueItems = [];
    DAYS_DATA.forEach(day => {
      REV_SCHEDULE.forEach(r => {
        const s = getRevStatus(day.id, r.key);
        if (s === 'due-today' || s === 'overdue') {
          dueItems.push({ day, revKey: r.key, label: r.label, desc: r.desc, status: s });
        }
      });
    });

    // Today's newly studied items
    const todayISO = fmtISO(TODAY);
    const studiedToday = DAYS_DATA.filter(d => STATE[d.id].studyDate === todayISO);

    el.innerHTML = `
      <div class="today-hero">
        <div class="hero-card accent">
          <div class="hero-num">${dueDays.length}</div>
          <div class="hero-label">Due Today</div>
        </div>
        <div class="hero-card">
          <div class="hero-num">${studied}</div>
          <div class="hero-label">Days Studied</div>
        </div>
        <div class="hero-card">
          <div class="hero-num">${totalRevDone}</div>
          <div class="hero-label">Revisions Done</div>
        </div>
        <div class="hero-card">
          <div class="hero-num">${120 - studied}</div>
          <div class="hero-label">Days Remaining</div>
        </div>
      </div>

      ${dueItems.length > 0 ? `
        <div class="section-title">
          Revisions Due
          <span class="count-chip">${dueItems.length}</span>
        </div>
        <div class="rev-due-list">
          ${dueItems.map(item => renderDueCard(item)).join('')}
        </div>
      ` : `
        <div class="section-title">Revisions Due</div>
        <div class="no-due">🎉 No revisions due today. Keep up the great work!</div>
      `}

      ${studiedToday.length > 0 ? `
        <div class="section-title" style="margin-top:28px">
          Studied Today
          <span class="count-chip green">${studiedToday.length}</span>
        </div>
        <div class="rev-due-list">
          ${studiedToday.map(day => `
            <div class="rev-due-card completed">
              <div class="rdc-day">D${String(day.id).padStart(3,'0')}</div>
              <div class="rdc-topic">${day.topic}<small>${SECTIONS_META[day.sec].label}</small></div>
              <div class="rdc-rev-label rev-r1">INITIAL READ</div>
              <div class="rdc-check done" onclick="App.promptUnmarkStudy(${day.id})">✓</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  }

  function renderDueCard(item) {
    const { day, revKey, label, status } = item;
    const isDone = !!STATE[day.id].revisions[revKey];
    const colorClass = `rev-${revKey}`;
    const overdueBadge = status === 'overdue' ? ' (overdue)' : '';
    const target = getRevTarget(day.id, revKey);

    return `
      <div class="rev-due-card ${isDone ? 'completed' : status === 'overdue' ? 'overdue' : ''}">
        <div class="rdc-day">D${String(day.id).padStart(3,'0')}</div>
        <div class="rdc-topic">
          ${day.topic}
          <small>${SECTIONS_META[day.sec].label} · Target: ${fmtDisplay(target)}${overdueBadge}</small>
        </div>
        <div class="rdc-rev-label ${isDone ? 'rev-r4' : 'rev-overdue'}">${label}</div>
        <div class="rdc-check ${isDone ? 'done' : ''}"
          onclick="App.handleRevCheck(${day.id}, '${revKey}', event)">
          ${isDone ? '✓' : ''}
        </div>
      </div>
    `;
  }

  // ── ALL DAYS VIEW ─────────────────────────────────────────────────────────
  function renderAllView() {
    const el = document.getElementById('viewAll');
    const sections = currentSection === 'all'
      ? Object.keys(SECTIONS_META)
      : [currentSection];

    let html = '';
    sections.forEach(sec => {
      const meta = SECTIONS_META[sec];
      const days = DAYS_DATA.filter(d => d.sec === sec);
      html += `
        <div class="days-section-header">
          <span>${meta.label} · Days ${meta.range}</span>
          <span style="font-size:11px;color:var(--text4)">${days.filter(d=>STATE[d.id].studyDate).length}/${days.length} read</span>
        </div>
        <div class="days-grid">
          ${days.map(day => renderDayCard(day)).join('')}
        </div>
      `;
    });

    el.innerHTML = html;
  }

  function renderDayCard(day) {
    const st = STATE[day.id];
    const hasDue = isDayActionable(day.id);
    const allDone = st.studyDate && REV_SCHEDULE.every(r => st.revisions[r.key]);
    const ns = !st.studyDate;

    let cardClass = 'day-card';
    if (hasDue) cardClass += ' has-due';
    else if (allDone) cardClass += ' all-complete';
    else if (ns) cardClass += ' not-started';

    const revHtml = REV_SCHEDULE.map(r => {
      const status = getRevStatus(day.id, r.key);
      const target = getRevTarget(day.id, r.key);
      const done = st.revisions[r.key];
      let chipClass = 'rev-chip';
      if (status === 'done') chipClass += ' chip-done';
      else if (status === 'due-today' || status === 'overdue') chipClass += ' chip-due';
      else chipClass += ' chip-future';

      return `
        <div class="${chipClass}" onclick="App.handleChipClick(${day.id}, '${r.key}', event)">
          <div class="rc-label">${r.label} <span style="font-weight:400;font-size:8px">${r.desc}</span></div>
          <div class="rc-target">${target ? fmtShort(target) : '—'}</div>
          <div class="rc-check-row">
            <div class="rc-box">${done ? '✓' : ''}</div>
            <div class="rc-done-date">${done ? fmtShort(done) : ''}</div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="${cardClass}" id="dc-${day.id}">
        <div class="dc-header" onclick="App.toggleCard(${day.id})">
          <div class="dc-day-num">D${String(day.id).padStart(3,'0')}</div>
          <div class="dc-topic">${day.topic}</div>
          <div class="dc-status-row">
            ${hasDue ? '<span class="pill pill-due">DUE</span>' : ''}
            ${st.studyDate ? '<span class="pill pill-read">READ</span>' : '<span class="pill pill-ns">—</span>'}
          </div>
          <span class="chevron">▶</span>
        </div>
        <div class="dc-body">
          <div class="study-row-card">
            <span class="sr-label">Initial Study</span>
            <div class="check-circle ${st.studyDate ? 'done' : ''}"
              onclick="App.handleStudyCheck(${day.id}, event)">${st.studyDate ? '✓' : ''}</div>
            <span class="check-date">${fmtDisplay(st.studyDate)}</span>
          </div>
          <div class="rev-chips">${revHtml}</div>
        </div>
      </div>
    `;
  }

  // ── STATS VIEW ────────────────────────────────────────────────────────────
  function renderStatsView() {
    const el = document.getElementById('viewStats');

    const studied = DAYS_DATA.filter(d => STATE[d.id].studyDate).length;
    const totalRevDone = DAYS_DATA.reduce((acc,d) =>
      acc + REV_SCHEDULE.filter(r => STATE[d.id].revisions[r.key]).length, 0);
    const dueCount = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
    const streak = calcStreak();

    // Per-section progress
    const secProgress = Object.entries(SECTIONS_META).map(([sec, meta]) => {
      const days = DAYS_DATA.filter(d => d.sec === sec);
      const done = days.filter(d => STATE[d.id].studyDate).length;
      const pct = Math.round((done / days.length) * 100);
      return { sec, meta, done, total: days.length, pct };
    });

    // Revision completion
    const revProgress = REV_SCHEDULE.map(r => {
      const eligible = DAYS_DATA.filter(d => STATE[d.id].studyDate).length;
      const done = DAYS_DATA.filter(d => STATE[d.id].revisions[r.key]).length;
      const pct = eligible > 0 ? Math.round((done / eligible) * 100) : 0;
      return { ...r, done, eligible, pct };
    });

    // Heatmap — last 90 days
    const heatmapData = buildHeatmap();

    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-card-num">${studied}</div>
          <div class="stat-card-label">Days Studied</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-num">${totalRevDone}</div>
          <div class="stat-card-label">Total Revisions</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-num">${streak}</div>
          <div class="stat-card-label">Day Streak 🔥</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-num">${dueCount}</div>
          <div class="stat-card-label">Due Today</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-num">${Math.round((studied/120)*100)}%</div>
          <div class="stat-card-label">Overall Progress</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-num">${120-studied}</div>
          <div class="stat-card-label">Days Remaining</div>
        </div>
      </div>

      <div class="progress-section">
        <h3>Section Progress</h3>
        ${secProgress.map(s => `
          <div class="prog-row">
            <div class="prog-label">${s.meta.label}</div>
            <div class="prog-bar-wrap">
              <div class="prog-bar-fill" style="width:${s.pct}%;background:${s.meta.color}"></div>
            </div>
            <div class="prog-pct">${s.pct}%</div>
          </div>
        `).join('')}
      </div>

      <div class="progress-section">
        <h3>Revision Completion</h3>
        ${revProgress.map(r => `
          <div class="prog-row">
            <div class="prog-label">${r.label} — ${r.desc}</div>
            <div class="prog-bar-wrap">
              <div class="prog-bar-fill" style="width:${r.pct}%"></div>
            </div>
            <div class="prog-pct">${r.done}/${r.eligible}</div>
          </div>
        `).join('')}
      </div>

      <div class="heatmap-wrap">
        <h3 style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">Activity — Last 90 Days</h3>
        <p style="font-size:11px;color:var(--text3);margin-bottom:8px">Each cell = one day. Darker = more activity.</p>
        <div class="heatmap-grid">
          ${heatmapData.map(cell => `
            <div class="hmap-cell hm-${cell.level}" title="${cell.date}: ${cell.count} activities"></div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function buildHeatmap() {
    const result = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(TODAY);
      d.setDate(d.getDate() - i);
      const iso = fmtISO(d);
      let count = 0;
      DAYS_DATA.forEach(day => {
        const st = STATE[day.id];
        if (st.studyDate === iso) count++;
        REV_SCHEDULE.forEach(r => { if (st.revisions[r.key] === iso) count++; });
      });
      const level = count === 0 ? 0 : count <= 1 ? 1 : count <= 3 ? 2 : count <= 5 ? 3 : 4;
      result.push({ date: iso, count, level });
    }
    return result;
  }

  // ── INTERACTION HANDLERS ──────────────────────────────────────────────────
  function toggleCard(dayId) {
    const el = document.getElementById('dc-' + dayId);
    if (!el) return;
    el.classList.toggle('open');
  }

  function handleStudyCheck(dayId, e) {
    e.stopPropagation();
    const st = STATE[dayId];
    if (st.studyDate) {
      // Already done — prompt to remove
      showModal({
        title: `Remove Study for Day ${dayId}?`,
        sub: 'This will also clear all revisions for this day.',
        confirm: 'Remove',
        danger: true,
        onConfirm: () => { unmarkStudied(dayId); closeModal(); }
      });
    } else {
      showDateModal(dayId, 'study');
    }
  }

  function handleChipClick(dayId, revKey, e) {
    e.stopPropagation();
    const st = STATE[dayId];
    if (!st.studyDate) { toast('Mark initial study first'); return; }
    if (st.revisions[revKey]) {
      showModal({
        title: `Remove ${revKey.toUpperCase()} for Day ${dayId}?`,
        sub: `This will unmark the ${revKey.toUpperCase()} revision.`,
        confirm: 'Remove',
        danger: true,
        onConfirm: () => { unmarkRevision(dayId, revKey); closeModal(); }
      });
    } else {
      showDateModal(dayId, revKey);
    }
  }

  function handleRevCheck(dayId, revKey, e) {
    e.stopPropagation();
    const st = STATE[dayId];
    if (st.revisions[revKey]) {
      showModal({
        title: `Remove ${revKey.toUpperCase()} for Day ${dayId}?`,
        sub: `Unmark this revision?`,
        confirm: 'Remove',
        danger: true,
        onConfirm: () => { unmarkRevision(dayId, revKey); closeModal(); }
      });
    } else {
      showDateModal(dayId, revKey);
    }
  }

  function promptUnmarkStudy(dayId) {
    showModal({
      title: `Remove Study for Day ${dayId}?`,
      sub: 'This will also clear all revisions for this day.',
      confirm: 'Remove',
      danger: true,
      onConfirm: () => { unmarkStudied(dayId); closeModal(); }
    });
  }

  // ── MODAL ─────────────────────────────────────────────────────────────────
  function showModal({ title, sub, confirm, danger, onConfirm }) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
      <div class="modal-title">${title}</div>
      <div class="modal-sub">${sub}</div>
      <div class="modal-btn-row">
        <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" style="${danger ? 'background:var(--red)' : ''}" id="modal-confirm-btn">${confirm}</button>
      </div>
    `;
    document.getElementById('modal-confirm-btn').onclick = onConfirm;
    document.getElementById('modal-overlay').classList.add('open');
  }

  function showDateModal(dayId, type) {
    const todayISO = fmtISO(TODAY);
    const label = type === 'study' ? 'Initial Study' : type.toUpperCase() + ' Revision';
    const day = DAYS_DATA.find(d => d.id === dayId);

    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
      <div class="modal-title">Mark ${label}</div>
      <div class="modal-sub">Day ${dayId} — ${day.topic}</div>
      <div class="date-input-group">
        <label>Date Completed</label>
        <input type="date" id="datePickerInput" value="${todayISO}" max="${todayISO}" />
      </div>
      <div class="modal-btn-row">
        <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" onclick="App.confirmDateModal(${dayId}, '${type}')">Mark Done</button>
      </div>
    `;
    document.getElementById('modal-overlay').classList.add('open');
  }

  function confirmDateModal(dayId, type) {
    const input = document.getElementById('datePickerInput');
    const dateISO = input.value;
    if (!dateISO) { toast('Please select a date'); return; }
    if (type === 'study') {
      markStudied(dayId, dateISO);
    } else {
      markRevision(dayId, type, dateISO);
    }
    // Re-open card in all view
    closeModal();
    setTimeout(() => {
      const card = document.getElementById('dc-' + dayId);
      if (card) card.classList.add('open');
    }, 100);
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
  }

  // ── EXPORT / IMPORT ───────────────────────────────────────────────────────
  function exportData() {
    const blob = new Blob([JSON.stringify({ version: 1, state: STATE, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bpsc_tracker_${fmtISO(TODAY)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('⬇ Data exported');
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const importedState = parsed.state || parsed;
        // Validate
        if (typeof importedState !== 'object') throw new Error();
        snapshot();
        // Merge — only import valid day IDs
        DAYS_DATA.forEach(d => {
          if (importedState[d.id]) {
            STATE[d.id] = importedState[d.id];
          }
        });
        saveToDB();
        renderAll();
        toast('⬆ Data imported successfully');
      } catch {
        toast('⚠ Invalid JSON file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── TOAST ─────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ── UTILS ─────────────────────────────────────────────────────────────────
  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  return {
    init, setView, filterSection,
    toggleCard,
    handleStudyCheck, handleChipClick, handleRevCheck, promptUnmarkStudy,
    confirmDateModal, closeModal,
    undo, redo,
    exportData, importData,
  };
})();

// ── Bootstrap ──
document.addEventListener('DOMContentLoaded', () => App.init());

// ── Service Worker ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
