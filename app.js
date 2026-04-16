// ─── BPSC TRACKER v2 ────────────────────────────────────────────────────────
const App = (() => {
  const DB_NAME = 'bpsc_tracker_v2';
  const DB_VER  = 2;
  const STORE   = 'state';
  const KEY     = 'main';
  const CFG_KEY = 'config';

  let db = null;
  // STATE shape: { [dayId]: { studyDate, revisions:{r1..r8}, extraTopics:[{id,topic,studyDate,revisions}], notes } }
  let STATE = {};
  let CONFIG = buildDefaultConfig();
  let HISTORY = [];
  let FUTURE  = [];
  let currentView = 'today';
  let currentSection = 'all';
  let TODAY = new Date(); TODAY.setHours(0,0,0,0);

  function buildDefaultConfig() {
    return {
      revSchedule: REV_SCHEDULE.map(r => ({ ...r })),
      showBacklogReminder: true,
      reminderThreshold: 2, // days behind plan triggers warning
    };
  }

  // ── INIT ────────────────────────────────────────────────────────────────
  async function init() {
    await openDB();
    const saved = await loadFromDB();
    STATE  = (saved && saved.state)  ? saved.state  : buildFreshState();
    CONFIG = (saved && saved.config) ? { ...buildDefaultConfig(), ...saved.config } : buildDefaultConfig();
    renderDateDisplay();
    renderAll();
    updateUndoRedoBtns();
    setInterval(() => { TODAY = new Date(); TODAY.setHours(0,0,0,0); renderAll(); }, 60000);
  }

  function buildFreshState() {
    const s = {};
    DAYS_DATA.forEach(d => {
      s[d.id] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
    });
    // Pre-loaded data
    [8,9,10,11,12].forEach(id => { s[id].studyDate = '2026-04-07'; });
    [13,14,15,16,17].forEach(id => { s[id].studyDate = '2026-04-15'; });
    [8,9].forEach(id => { s[id].revisions.r1 = '2026-04-14'; });
    s[22].studyDate = '2026-04-14';
    return s;
  }

  function initRevs() {
    const r = {};
    REV_SCHEDULE.forEach(rev => r[rev.key] = null);
    return r;
  }

  function ensureDayState(dayId) {
    if (!STATE[dayId]) {
      STATE[dayId] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
    }
    if (!STATE[dayId].extraTopics) STATE[dayId].extraTopics = [];
    if (!STATE[dayId].notes) STATE[dayId].notes = '';
    if (!STATE[dayId].revisions) STATE[dayId].revisions = initRevs();
    return STATE[dayId];
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
    const payload = deepClone({ state: STATE, config: CONFIG });
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(payload, KEY);
    try { localStorage.setItem('bpsc_backup', JSON.stringify(payload)); } catch(_){}
  }

  // ── UNDO / REDO ──────────────────────────────────────────────────────────
  function snapshot() {
    HISTORY.push(deepClone({ state: STATE, config: CONFIG }));
    if (HISTORY.length > 50) HISTORY.shift();
    FUTURE = [];
    updateUndoRedoBtns();
  }

  function undo() {
    if (!HISTORY.length) return;
    FUTURE.push(deepClone({ state: STATE, config: CONFIG }));
    const s = HISTORY.pop();
    STATE = s.state; CONFIG = s.config;
    saveToDB(); renderAll(); updateUndoRedoBtns(); toast('↩ Undone');
  }

  function redo() {
    if (!FUTURE.length) return;
    HISTORY.push(deepClone({ state: STATE, config: CONFIG }));
    const s = FUTURE.pop();
    STATE = s.state; CONFIG = s.config;
    saveToDB(); renderAll(); updateUndoRedoBtns(); toast('↪ Redone');
  }

  function updateUndoRedoBtns() {
    document.getElementById('undoBtn').disabled = !HISTORY.length;
    document.getElementById('redoBtn').disabled = !FUTURE.length;
  }

  // ── DATE HELPERS ─────────────────────────────────────────────────────────
  function fmtISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function fmtDisplay(iso) {
    if (!iso) return '';
    const [y,m,d] = iso.split('-').map(Number);
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d} ${M[m-1]} ${String(y).slice(2)}`;
  }
  function fmtShort(iso) {
    if (!iso) return '—';
    const [,m,d] = iso.split('-').map(Number);
    return `${d}/${m}`;
  }
  function addDays(iso, n) {
    const d = new Date(iso); d.setDate(d.getDate() + n); return fmtISO(d);
  }
  function daysDiff(isoA, isoB) {
    return Math.round((new Date(isoB) - new Date(isoA)) / 86400000);
  }
  function isToday(iso) { return iso === fmtISO(TODAY); }
  function isPast(iso)  { return iso < fmtISO(TODAY); }
  function todayISO()   { return fmtISO(TODAY); }

  // ── REVISION LOGIC (each rev relative to PREVIOUS rev or study date) ──────
  function getEffectiveSchedule() {
    return CONFIG.revSchedule || REV_SCHEDULE;
  }

  function getRevTarget(dayId, revKey, st) {
    if (!st) st = ensureDayState(dayId);
    if (!st.studyDate) return null;
    const sched = getEffectiveSchedule();
    const idx = sched.findIndex(r => r.key === revKey);
    if (idx < 0) return null;

    // Walk the chain: each target = previous done date + this rev's days
    // If previous not done, target = previous target + this rev's days (projected)
    let baseDate = st.studyDate;
    for (let i = 0; i <= idx; i++) {
      const rv = sched[i];
      if (i === 0) {
        // R1 is based on study date
        const target = addDays(baseDate, rv.days);
        if (i === idx) return target;
        baseDate = st.revisions[rv.key] || target;
      } else {
        const target = addDays(baseDate, rv.days);
        if (i === idx) return target;
        baseDate = st.revisions[rv.key] || target;
      }
    }
    return null;
  }

  function getRevStatus(dayId, revKey, st) {
    if (!st) st = ensureDayState(dayId);
    if (st.revisions[revKey]) return 'done';
    const target = getRevTarget(dayId, revKey, st);
    if (!target) return 'no-study';
    // Check if previous revision done (unlock check)
    const sched = getEffectiveSchedule();
    const idx = sched.findIndex(r => r.key === revKey);
    if (idx > 0) {
      const prevKey = sched[idx-1].key;
      if (!st.revisions[prevKey]) return 'locked'; // previous not done yet
    }
    if (isToday(target)) return 'due-today';
    if (isPast(target))  return 'overdue';
    return 'upcoming';
  }

  function isDayActionable(dayId) {
    const st = ensureDayState(dayId);
    return getEffectiveSchedule().some(r => {
      const s = getRevStatus(dayId, r.key, st);
      return s === 'due-today' || s === 'overdue';
    });
  }

  // ── STUDY PLAN HELPERS ────────────────────────────────────────────────────
  function getPlanDay() {
    // How many plan days have elapsed since start?
    const start = new Date(STUDY_PLAN.startDate);
    const diff = Math.floor((TODAY - start) / 86400000) + 1;
    return Math.max(1, diff);
  }

  function getCurrentPhase() {
    const pd = getPlanDay();
    return STUDY_PLAN.phases.find(p => pd >= p.days[0] && pd <= p.days[1]) || null;
  }

  function getDaysToExam() {
    return daysDiff(todayISO(), STUDY_PLAN.examDate);
  }

  function getBacklogData() {
    const planDay = getPlanDay();
    const notStarted = [], startedOnce = [], startedFew = [], welldone = [];

    DAYS_DATA.forEach(d => {
      const st = ensureDayState(d.id);
      const sched = getEffectiveSchedule();
      const revsDone = sched.filter(r => st.revisions[r.key]).length;

      if (!st.studyDate) {
        notStarted.push(d);
      } else if (revsDone === 0) {
        startedOnce.push(d);
      } else if (revsDone <= 2) {
        startedFew.push({ ...d, revsDone });
      } else {
        welldone.push({ ...d, revsDone });
      }
    });

    // How many days behind on the plan?
    const phaseProgress = (() => {
      const phase = getCurrentPhase();
      if (!phase) return null;
      const [start, end] = phase.days;
      const expectedDays = Math.min(planDay - start + 1, end - start + 1);
      const phaseSections = phase.sections;
      const relevantDays = DAYS_DATA.filter(d => phaseSections.includes(d.sec));
      const studiedCount = relevantDays.filter(d => ensureDayState(d.id).studyDate).length;
      const behind = Math.max(0, expectedDays - studiedCount);
      return { phase, expectedDays, studiedCount, behind, relevantDays: relevantDays.length };
    })();

    return { notStarted, startedOnce, startedFew, welldone, phaseProgress };
  }

  function calcStreak() {
    let streak = 0;
    let date = new Date(TODAY);
    while (true) {
      const iso = fmtISO(date);
      const hasActivity = DAYS_DATA.some(d => {
        const st = STATE[d.id] || {};
        if (st.studyDate === iso) return true;
        return getEffectiveSchedule().some(r => (st.revisions || {})[r.key] === iso);
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
    ensureDayState(dayId).studyDate = dateISO;
    saveToDB(); renderAll(); toast(`✓ Day ${dayId} marked as studied`);
  }

  function unmarkStudied(dayId) {
    snapshot();
    const st = ensureDayState(dayId);
    st.studyDate = null;
    st.revisions = initRevs();
    saveToDB(); renderAll(); toast(`Removed study for Day ${dayId}`);
  }

  function markRevision(dayId, revKey, dateISO) {
    snapshot();
    ensureDayState(dayId).revisions[revKey] = dateISO;
    saveToDB(); renderAll(); toast(`✓ ${revKey.toUpperCase()} done for Day ${dayId}`);
  }

  function unmarkRevision(dayId, revKey) {
    snapshot();
    ensureDayState(dayId).revisions[revKey] = null;
    saveToDB(); renderAll(); toast(`${revKey.toUpperCase()} removed`);
  }

  function scheduleNextDay(dayId, revKey) {
    // Mark this revision as scheduled for tomorrow
    snapshot();
    ensureDayState(dayId).revisions[revKey] = addDays(todayISO(), 1);
    saveToDB(); renderAll(); toast(`${revKey.toUpperCase()} scheduled for tomorrow`);
  }

  // ── EXTRA TOPICS ──────────────────────────────────────────────────────────
  function addExtraTopic(dayId, topicText) {
    snapshot();
    const st = ensureDayState(dayId);
    const id = 'et_' + Date.now();
    st.extraTopics.push({ id, topic: topicText, studyDate: null, revisions: initRevs() });
    saveToDB(); renderAll(); toast('Topic added');
  }

  function removeExtraTopic(dayId, topicId) {
    snapshot();
    const st = ensureDayState(dayId);
    st.extraTopics = st.extraTopics.filter(t => t.id !== topicId);
    saveToDB(); renderAll(); toast('Topic removed');
  }

  function removeCoreDay(dayId) {
    // Mark day as "hidden" (we keep state but hide from lists)
    snapshot();
    ensureDayState(dayId).hidden = true;
    saveToDB(); renderAll(); toast('Day hidden');
  }

  // ── VIEWS ────────────────────────────────────────────────────────────────
  function setView(v, btn) {
    currentView = v;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else {
      const nb = document.querySelector(`[data-view="${v}"]`);
      if (nb) nb.classList.add('active');
    }
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const vid = 'view' + v.charAt(0).toUpperCase() + v.slice(1);
    const vEl = document.getElementById(vid);
    if (vEl) vEl.classList.add('active');
    const titles = { today:'Today', all:'All Days', stats:'Statistics', settings:'Settings', backlog:'Backlog' };
    document.getElementById('pageTitle').textContent = titles[v] || v;
    renderCurrentView();
  }

  function filterSection(sec, btn) {
    currentSection = sec;
    document.querySelectorAll('.sec-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (currentView !== 'all') setView('all', null);
    else renderAllView();
  }

  function renderAll() {
    renderTodayView();
    if (currentView === 'all')      renderAllView();
    if (currentView === 'stats')    renderStatsView();
    if (currentView === 'settings') renderSettingsView();
    if (currentView === 'backlog')  renderBacklogView();
    renderDateDisplay();
    updateBadges();
  }

  function renderCurrentView() {
    if (currentView === 'today')    renderTodayView();
    if (currentView === 'all')      renderAllView();
    if (currentView === 'stats')    renderStatsView();
    if (currentView === 'settings') renderSettingsView();
    if (currentView === 'backlog')  renderBacklogView();
  }

  function renderDateDisplay() {
    const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    document.getElementById('dateDisplay').textContent =
      `${days[TODAY.getDay()]} ${TODAY.getDate()} ${months[TODAY.getMonth()]} ${TODAY.getFullYear()}`;
    document.getElementById('streakChip').textContent = `🔥 ${calcStreak()}`;
    // Exam countdown
    const dte = getDaysToExam();
    const examEl = document.getElementById('examCountdown');
    if (examEl) {
      if (dte <= STUDY_PLAN.graceDays) examEl.textContent = dte <= 0 ? '📝 Exam Day!' : `🕊 Grace: ${dte}d`;
      else examEl.textContent = `📅 ${dte}d to exam`;
    }
  }

  function updateBadges() {
    const due = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
    const badge = document.getElementById('badge-today');
    if (badge) { badge.textContent = due > 0 ? due : ''; }
    if (currentView === 'today') {
      const sub = document.getElementById('pageSub');
      if (sub) sub.textContent = due > 0 ? `${due} revision${due>1?'s':''} need attention` : 'All caught up!';
    }
    // Backlog badge
    const bd = getBacklogData();
    const bBadge = document.getElementById('badge-backlog');
    if (bBadge) {
      const behind = bd.phaseProgress ? bd.phaseProgress.behind : 0;
      bBadge.textContent = behind > 0 ? behind : '';
    }
  }

  // ── TODAY VIEW ───────────────────────────────────────────────────────────
  function renderTodayView() {
    const el = document.getElementById('viewToday');
    if (!el) return;

    const studied = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
    const totalRevDone = DAYS_DATA.reduce((acc,d) => {
      return acc + getEffectiveSchedule().filter(r => ensureDayState(d.id).revisions[r.key]).length;
    }, 0);

    const dueItems = [];
    DAYS_DATA.forEach(day => {
      const st = ensureDayState(day.id);
      if (st.hidden) return;
      getEffectiveSchedule().forEach(r => {
        const s = getRevStatus(day.id, r.key, st);
        if (s === 'due-today' || s === 'overdue') {
          dueItems.push({ day, revKey: r.key, label: r.label, desc: r.desc, status: s });
        }
      });
    });

    const tISO = todayISO();
    const studiedToday = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate === tISO);
    const planDay = getPlanDay();
    const phase = getCurrentPhase();
    const dte = getDaysToExam();

    const phaseHtml = phase ? `
      <div class="plan-bar">
        <span class="plan-phase-tag" style="background:${phase.color}20;color:${phase.color};border:1px solid ${phase.color}40">${phase.label}</span>
        <span class="plan-desc">${phase.desc}</span>
        <span class="plan-day-num">Plan Day ${planDay}</span>
      </div>
    ` : '';

    el.innerHTML = `
      ${phaseHtml}
      <div class="today-hero">
        <div class="hero-card accent">
          <div class="hero-num">${dueItems.length}</div>
          <div class="hero-label">Due Today</div>
        </div>
        <div class="hero-card">
          <div class="hero-num">${studied}</div>
          <div class="hero-label">Studied</div>
        </div>
        <div class="hero-card">
          <div class="hero-num">${totalRevDone}</div>
          <div class="hero-label">Revisions</div>
        </div>
        <div class="hero-card">
          <div class="hero-num">${dte > 0 ? dte : '!'}</div>
          <div class="hero-label">Days Left</div>
        </div>
      </div>

      ${dueItems.length > 0 ? `
        <div class="section-title">Revisions Due <span class="count-chip">${dueItems.length}</span></div>
        <div class="rev-due-list">
          ${dueItems.map(item => renderDueCard(item)).join('')}
        </div>
      ` : `
        <div class="section-title">Revisions Due</div>
        <div class="no-due">🌿 No revisions due today — well done!</div>
      `}

      ${studiedToday.length > 0 ? `
        <div class="section-title" style="margin-top:28px">Studied Today <span class="count-chip green">${studiedToday.length}</span></div>
        <div class="rev-due-list">
          ${studiedToday.map(day => `
            <div class="rev-due-card completed">
              <div class="rdc-day">${formatDayId(day.id)}</div>
              <div class="rdc-topic">${day.topic}<small>${SECTIONS_META[day.sec].label}</small></div>
              <div class="rdc-rev-label">INITIAL READ</div>
              <div class="rdc-check done" onclick="App.promptUnmarkStudy('${day.id}')">✓</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;
  }

  function renderDueCard(item) {
    const { day, revKey, label, status } = item;
    const st = ensureDayState(day.id);
    const isDone = !!st.revisions[revKey];
    const target = getRevTarget(day.id, revKey, st);
    const overdueDays = status === 'overdue' ? daysDiff(target, todayISO()) : 0;

    return `
      <div class="rev-due-card ${isDone ? 'completed' : status === 'overdue' ? 'overdue' : ''}">
        <div class="rdc-day">${formatDayId(day.id)}</div>
        <div class="rdc-topic">
          ${day.topic}
          <small>${SECTIONS_META[day.sec].label} · Target: ${fmtDisplay(target)}${status === 'overdue' ? ` <span class="overdue-tag">${overdueDays}d late</span>` : ''}</small>
        </div>
        <div class="rdc-actions">
          <button class="rdc-snooze" onclick="App.scheduleNextDay('${day.id}','${revKey}')" title="Schedule for tomorrow">→+1</button>
          <div class="rdc-rev-label rev-${revKey}">${label}</div>
          <div class="rdc-check ${isDone ? 'done' : ''}" onclick="App.handleRevCheck('${day.id}','${revKey}',event)">${isDone ? '✓' : ''}</div>
        </div>
      </div>
    `;
  }

  function formatDayId(id) {
    if (typeof id === 'string' && id.startsWith('s')) return 'S' + id.slice(1).padStart(2,'0');
    return 'D' + String(id).padStart(3,'0');
  }

  // ── ALL DAYS VIEW ────────────────────────────────────────────────────────
  function renderAllView() {
    const el = document.getElementById('viewAll');
    if (!el) return;
    const sections = currentSection === 'all' ? Object.keys(SECTIONS_META) : [currentSection];
    let html = '';

    sections.forEach(sec => {
      const meta = SECTIONS_META[sec];
      const days = DAYS_DATA.filter(d => d.sec === sec && !ensureDayState(d.id).hidden);
      const studiedCount = days.filter(d => ensureDayState(d.id).studyDate).length;

      html += `
        <div class="days-section-header" style="border-left:3px solid ${meta.color}">
          <span>${meta.label}</span>
          <span class="sec-progress">${studiedCount}/${days.length} read</span>
          <button class="add-topic-btn" onclick="App.showAddTopicModal('${sec}')">+ Add Topic</button>
        </div>
        <div class="days-grid">
          ${days.map(day => renderDayCard(day)).join('')}
        </div>
      `;
    });

    el.innerHTML = html;
  }

  function renderDayCard(day) {
    const st = ensureDayState(day.id);
    const hasDue = isDayActionable(day.id);
    const sched = getEffectiveSchedule();
    const allDone = st.studyDate && sched.every(r => st.revisions[r.key]);

    let cardClass = 'day-card';
    if (hasDue) cardClass += ' has-due';
    else if (allDone) cardClass += ' all-complete';
    else if (!st.studyDate) cardClass += ' not-started';

    const timelineHtml = buildTimeline(day.id, st);

    return `
      <div class="${cardClass}" id="dc-${day.id}">
        <div class="dc-header" onclick="App.toggleCard('${day.id}')">
          <div class="dc-day-num">${formatDayId(day.id)}</div>
          <div class="dc-topic-wrap">
            <div class="dc-topic">${day.topic}</div>
            <div class="dc-status-row">
              ${hasDue ? '<span class="pill pill-due">DUE</span>' : ''}
              ${st.studyDate ? '<span class="pill pill-read">READ</span>' : '<span class="pill pill-ns">NOT STARTED</span>'}
              ${allDone ? '<span class="pill pill-done">✓ COMPLETE</span>' : ''}
            </div>
          </div>
          <span class="chevron">▸</span>
        </div>
        <div class="dc-body" id="dcb-${day.id}">
          ${timelineHtml}
          ${st.extraTopics && st.extraTopics.length > 0 ? `
            <div class="extra-topics-list">
              <div class="et-header">Extra Topics</div>
              ${st.extraTopics.map(et => `
                <div class="extra-topic-row">
                  <span class="et-topic">${et.topic}</span>
                  <button class="et-remove" onclick="App.confirmRemoveExtra('${day.id}','${et.id}')">✕</button>
                </div>
              `).join('')}
            </div>
          ` : ''}
          <div class="dc-footer-btns">
            <button class="dc-footer-btn" onclick="App.showAddExtraTopicModal('${day.id}')">+ Sub-topic</button>
            <button class="dc-footer-btn danger" onclick="App.confirmHideDay('${day.id}')">Remove Day</button>
          </div>
        </div>
      </div>
    `;
  }

  function buildTimeline(dayId, st) {
    const sched = getEffectiveSchedule();
    let html = '<div class="timeline">';

    // Initial study node
    const studyDone = !!st.studyDate;
    html += `
      <div class="tl-node ${studyDone ? 'tl-done' : 'tl-pending'}">
        <div class="tl-dot ${studyDone ? 'dot-done' : 'dot-empty'}" onclick="App.handleStudyCheck('${dayId}',event)">
          ${studyDone ? '✓' : ''}
        </div>
        <div class="tl-content">
          <div class="tl-label">Initial Read</div>
          <div class="tl-date ${studyDone ? 'date-done' : 'date-none'}">${studyDone ? fmtDisplay(st.studyDate) : 'Tap to mark'}</div>
        </div>
      </div>
    `;

    // Connector then revision nodes
    sched.forEach((r, idx) => {
      const status = getRevStatus(dayId, r.key, st);
      const target = getRevTarget(dayId, r.key, st);
      const done = !!st.revisions[r.key];
      const locked = status === 'locked' || status === 'no-study';
      const due = status === 'due-today' || status === 'overdue';

      let dotClass = 'dot-empty';
      if (done) dotClass = 'dot-done';
      else if (due) dotClass = 'dot-due';
      else if (locked) dotClass = 'dot-locked';

      let nodeClass = 'tl-node';
      if (done) nodeClass += ' tl-done';
      else if (due) nodeClass += ' tl-due-node';
      else if (locked) nodeClass += ' tl-locked';

      const prevDone = idx === 0 ? studyDone : !!st.revisions[sched[idx-1].key];
      const lineClass = prevDone ? 'tl-line line-done' : 'tl-line line-pending';

      html += `<div class="${lineClass}"></div>`;
      html += `
        <div class="${nodeClass}" ${locked ? '' : `onclick="App.handleChipClick('${dayId}','${r.key}',event)"`}>
          <div class="${dotClass} tl-dot">${done ? '✓' : due ? '!' : locked ? '○' : '·'}</div>
          <div class="tl-content">
            <div class="tl-label">${r.label} <span class="tl-desc">${r.desc}</span></div>
            <div class="tl-date ${done ? 'date-done' : due ? 'date-due' : 'date-future'}">
              ${done ? fmtDisplay(st.revisions[r.key]) : target ? fmtDisplay(target) : '—'}
              ${due && !done ? '<span class="due-badge">Due</span>' : ''}
            </div>
          </div>
          ${!done && !locked && st.studyDate ? `
            <button class="tl-snooze" onclick="event.stopPropagation();App.scheduleNextDay('${dayId}','${r.key}')" title="+1 day">→</button>
          ` : ''}
        </div>
      `;
    });

    html += '</div>';
    return html;
  }

  // ── STATS VIEW ──────────────────────────────────────────────────────────
  function renderStatsView() {
    const el = document.getElementById('viewStats');
    if (!el) return;

    const studied = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
    const sched = getEffectiveSchedule();
    const totalRevDone = DAYS_DATA.reduce((acc,d) =>
      acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
    const dueCount = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
    const streak = calcStreak();
    const planDay = getPlanDay();

    const secProgress = Object.entries(SECTIONS_META).map(([sec, meta]) => {
      const days = DAYS_DATA.filter(d => d.sec === sec);
      const done = days.filter(d => ensureDayState(d.id).studyDate).length;
      const pct = Math.round((done / days.length) * 100);
      return { sec, meta, done, total: days.length, pct };
    });

    const revProgress = sched.map(r => {
      const eligible = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
      const done = DAYS_DATA.filter(d => ensureDayState(d.id).revisions[r.key]).length;
      const pct = eligible > 0 ? Math.round((done / eligible) * 100) : 0;
      return { ...r, done, eligible, pct };
    });

    const heatmapData = buildHeatmap();
    const totalDays = DAYS_DATA.length;

    el.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-card-num">${studied}</div><div class="stat-card-label">Days Studied</div></div>
        <div class="stat-card"><div class="stat-card-num">${totalRevDone}</div><div class="stat-card-label">Revisions Done</div></div>
        <div class="stat-card"><div class="stat-card-num">${streak}</div><div class="stat-card-label">Day Streak 🔥</div></div>
        <div class="stat-card"><div class="stat-card-num">${dueCount}</div><div class="stat-card-label">Due Today</div></div>
        <div class="stat-card"><div class="stat-card-num">${Math.round((studied/totalDays)*100)}%</div><div class="stat-card-label">Overall Progress</div></div>
        <div class="stat-card"><div class="stat-card-num">${planDay}</div><div class="stat-card-label">Plan Day</div></div>
      </div>

      <div class="progress-section">
        <h3>Section Progress</h3>
        ${secProgress.map(s => `
          <div class="prog-row">
            <div class="prog-label">${s.meta.label}</div>
            <div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${s.pct}%;background:${s.meta.color}"></div></div>
            <div class="prog-pct">${s.done}/${s.total}</div>
          </div>
        `).join('')}
      </div>

      <div class="progress-section">
        <h3>Revision Completion (of studied days)</h3>
        ${revProgress.map(r => `
          <div class="prog-row">
            <div class="prog-label">${r.label} — ${r.desc}</div>
            <div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${r.pct}%"></div></div>
            <div class="prog-pct">${r.done}/${r.eligible}</div>
          </div>
        `).join('')}
      </div>

      <div class="heatmap-wrap">
        <h3>Activity — Last 90 Days</h3>
        <p class="hm-sub">Each cell = one day · darker = more activity</p>
        <div class="heatmap-grid">
          ${heatmapData.map(cell => `
            <div class="hmap-cell hm-${cell.level}" title="${cell.date}: ${cell.count}"></div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function buildHeatmap() {
    const result = [];
    for (let i = 89; i >= 0; i--) {
      const d = new Date(TODAY); d.setDate(d.getDate() - i);
      const iso = fmtISO(d);
      let count = 0;
      DAYS_DATA.forEach(day => {
        const st = STATE[day.id] || {};
        if (st.studyDate === iso) count++;
        getEffectiveSchedule().forEach(r => { if ((st.revisions||{})[r.key] === iso) count++; });
      });
      const level = count===0?0:count<=1?1:count<=3?2:count<=5?3:4;
      result.push({ date: iso, count, level });
    }
    return result;
  }

  // ── BACKLOG VIEW ──────────────────────────────────────────────────────────
  function renderBacklogView() {
    const el = document.getElementById('viewBacklog');
    if (!el) return;
    const { notStarted, startedOnce, startedFew, phaseProgress } = getBacklogData();

    const alertHtml = phaseProgress && phaseProgress.behind > 0 ? `
      <div class="backlog-alert">
        <div class="ba-icon">⚠</div>
        <div class="ba-text">
          <strong>${phaseProgress.behind} day${phaseProgress.behind>1?'s':''} behind</strong> on ${phaseProgress.phase.label}.<br>
          You've studied ${phaseProgress.studiedCount} of ${phaseProgress.relevantDays} relevant topics. Expected: ${phaseProgress.expectedDays}.
        </div>
      </div>
    ` : phaseProgress ? `
      <div class="backlog-ok">✓ On track for ${phaseProgress.phase.label} — ${phaseProgress.studiedCount}/${phaseProgress.relevantDays} topics done</div>
    ` : '';

    el.innerHTML = `
      ${alertHtml}

      <div class="backlog-section">
        <div class="bl-header">
          <span class="bl-icon" style="background:#C0392B20;color:#C0392B">✗</span>
          Not Started Yet <span class="count-chip red">${notStarted.length}</span>
        </div>
        ${notStarted.length === 0 ? '<div class="bl-empty">All topics started! 🌱</div>' : `
          <div class="bl-list">
            ${notStarted.slice(0,20).map(d => `
              <div class="bl-item">
                <span class="bl-id">${formatDayId(d.id)}</span>
                <span class="bl-topic">${d.topic}</span>
                <span class="bl-sec" style="color:${SECTIONS_META[d.sec].color}">${SECTIONS_META[d.sec].label}</span>
                <button class="bl-mark" onclick="App.showDateModalFor('${d.id}','study')">Mark Read</button>
              </div>
            `).join('')}
            ${notStarted.length > 20 ? `<div class="bl-more">+${notStarted.length-20} more</div>` : ''}
          </div>
        `}
      </div>

      <div class="backlog-section">
        <div class="bl-header">
          <span class="bl-icon" style="background:#E67E2220;color:#E67E22">↻</span>
          Read Once (No Revisions) <span class="count-chip orange">${startedOnce.length}</span>
        </div>
        ${startedOnce.length === 0 ? '<div class="bl-empty">All read topics have at least R1 done ✓</div>' : `
          <div class="bl-list">
            ${startedOnce.slice(0,15).map(d => {
              const st = ensureDayState(d.id);
              const r1target = getRevTarget(d.id, 'r1', st);
              const r1status = getRevStatus(d.id, 'r1', st);
              return `
                <div class="bl-item ${r1status==='overdue'?'bl-overdue':''}">
                  <span class="bl-id">${formatDayId(d.id)}</span>
                  <span class="bl-topic">${d.topic}</span>
                  <span class="bl-date">R1 target: ${fmtDisplay(r1target)}</span>
                  <button class="bl-mark" onclick="App.showDateModalFor('${d.id}','r1')">Mark R1</button>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>

      <div class="backlog-section">
        <div class="bl-header">
          <span class="bl-icon" style="background:#27AE6020;color:#27AE60">↑</span>
          In Progress (1–2 Revisions) <span class="count-chip green">${startedFew.length}</span>
        </div>
        ${startedFew.length === 0 ? '<div class="bl-empty">No topics at this stage</div>' : `
          <div class="bl-list">
            ${startedFew.slice(0,10).map(d => `
              <div class="bl-item">
                <span class="bl-id">${formatDayId(d.id)}</span>
                <span class="bl-topic">${d.topic}</span>
                <span class="bl-revs">${d.revsDone} rev done</span>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  }

  // ── SETTINGS VIEW ─────────────────────────────────────────────────────────
  function renderSettingsView() {
    const el = document.getElementById('viewSettings');
    if (!el) return;
    const sched = CONFIG.revSchedule || REV_SCHEDULE;

    el.innerHTML = `
      <div class="settings-section">
        <h3>Study Plan</h3>
        <div class="settings-row"><span>Plan Start</span><strong>${fmtDisplay(STUDY_PLAN.startDate)}</strong></div>
        <div class="settings-row"><span>Exam Date</span><strong>${fmtDisplay(STUDY_PLAN.examDate)}</strong></div>
        <div class="settings-row"><span>Today is Plan Day</span><strong>${getPlanDay()}</strong></div>
        <div class="settings-row"><span>Days to Exam</span><strong>${getDaysToExam()}</strong></div>
        <div class="settings-row"><span>Grace Period</span><strong>Last ${STUDY_PLAN.graceDays} days before exam</strong></div>
        <div class="phase-list">
          ${STUDY_PLAN.phases.map(p => `
            <div class="phase-card" style="border-left:3px solid ${p.color}">
              <strong style="color:${p.color}">${p.label}</strong> · Days ${p.days[0]}–${p.days[1]}
              <div class="phase-desc">${p.desc}</div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="settings-section">
        <h3>Spaced Repetition Rules</h3>
        <p class="settings-hint">Each revision gap is relative to the <em>previous</em> revision (or initial read for R1). Edit days and save.</p>
        <div id="sched-editor">
          ${sched.map((r,i) => `
            <div class="sched-row">
              <span class="sr-key">${r.label}</span>
              <span class="sr-relto">${i===0?'From Initial Read':'From prev revision'}</span>
              <span class="sr-plus">+</span>
              <input class="sr-input" type="number" id="sr-${r.key}" value="${r.days}" min="1" max="365" />
              <span class="sr-unit">days</span>
            </div>
          `).join('')}
        </div>
        <button class="settings-save-btn" onclick="App.saveSchedule()">Save Revision Rules</button>
        <button class="settings-reset-btn" onclick="App.resetSchedule()">Reset to Default</button>
      </div>

      <div class="settings-section">
        <h3>Data Management</h3>
        <div class="settings-btns">
          <button class="settings-action-btn" onclick="App.exportData()">⬇ Export JSON</button>
          <label class="settings-action-btn import-lbl">
            ⬆ Import JSON
            <input type="file" accept=".json" onchange="App.importData(event)" style="display:none"/>
          </label>
          <button class="settings-action-btn danger" onclick="App.confirmResetAll()">⚠ Reset All Data</button>
        </div>
      </div>

      <div class="settings-section">
        <h3>Undo / Redo</h3>
        <div class="settings-btns">
          <button class="ur-btn" id="undoBtn2" onclick="App.undo()">↩ Undo</button>
          <button class="ur-btn" id="redoBtn2" onclick="App.redo()">↪ Redo</button>
        </div>
        <p class="settings-hint">Up to 50 undo steps are stored in memory per session.</p>
      </div>
    `;
  }

  function saveSchedule() {
    const sched = CONFIG.revSchedule || REV_SCHEDULE.map(r => ({...r}));
    let valid = true;
    sched.forEach(r => {
      const inp = document.getElementById('sr-' + r.key);
      if (inp) {
        const v = parseInt(inp.value);
        if (isNaN(v) || v < 1) { valid = false; return; }
        r.days = v;
        r.desc = `+${v} day${v>1?'s':''}`;
      }
    });
    if (!valid) { toast('⚠ Invalid values'); return; }
    CONFIG.revSchedule = sched;
    saveToDB();
    renderAll();
    toast('✓ Revision rules saved');
  }

  function resetSchedule() {
    CONFIG.revSchedule = REV_SCHEDULE.map(r => ({...r}));
    saveToDB();
    renderSettingsView();
    toast('Reset to default schedule');
  }

  function confirmResetAll() {
    showModal({
      title: 'Reset All Data?',
      sub: 'This will permanently delete all study dates, revisions and extra topics.',
      confirm: 'Reset Everything',
      danger: true,
      onConfirm: () => {
        STATE = buildFreshState();
        HISTORY = []; FUTURE = [];
        saveToDB(); renderAll(); closeModal();
        toast('Data reset');
      }
    });
  }

  // ── INTERACTION HANDLERS ─────────────────────────────────────────────────
  function toggleCard(dayId) {
    const el = document.getElementById('dc-' + dayId);
    if (!el) return;
    el.classList.toggle('open');
  }

  function handleStudyCheck(dayId, e) {
    if (e) e.stopPropagation();
    const st = ensureDayState(dayId);
    if (st.studyDate) {
      showModal({
        title: `Remove study for ${formatDayId(dayId)}?`,
        sub: 'This will also clear all revisions for this day.',
        confirm: 'Remove', danger: true,
        onConfirm: () => { unmarkStudied(dayId); closeModal(); }
      });
    } else {
      showDateModal(dayId, 'study');
    }
  }

  function handleChipClick(dayId, revKey, e) {
    if (e) e.stopPropagation();
    const st = ensureDayState(dayId);
    if (!st.studyDate) { toast('Mark initial study first'); return; }
    const status = getRevStatus(dayId, revKey, st);
    if (status === 'locked') { toast('Complete previous revision first'); return; }
    if (st.revisions[revKey]) {
      showModal({
        title: `Remove ${revKey.toUpperCase()} for ${formatDayId(dayId)}?`,
        sub: `Unmark this revision?`, confirm: 'Remove', danger: true,
        onConfirm: () => { unmarkRevision(dayId, revKey); closeModal(); }
      });
    } else {
      showDateModal(dayId, revKey);
    }
  }

  function handleRevCheck(dayId, revKey, e) {
    if (e) e.stopPropagation();
    handleChipClick(dayId, revKey, null);
  }

  function promptUnmarkStudy(dayId) {
    showModal({
      title: `Remove study for ${formatDayId(dayId)}?`,
      sub: 'This will also clear all revisions.',
      confirm: 'Remove', danger: true,
      onConfirm: () => { unmarkStudied(dayId); closeModal(); }
    });
  }

  function showDateModalFor(dayId, type) {
    showDateModal(dayId, type);
  }

  // ── MODAL ─────────────────────────────────────────────────────────────────
  function showModal({ title, sub, confirm, danger, onConfirm }) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
      <div class="modal-title">${title}</div>
      <div class="modal-sub">${sub}</div>
      <div class="modal-btn-row">
        <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary${danger?' btn-danger':''}" id="modal-confirm-btn">${confirm}</button>
      </div>
    `;
    document.getElementById('modal-confirm-btn').onclick = onConfirm;
    document.getElementById('modal-overlay').classList.add('open');
  }

  function showDateModal(dayId, type) {
    const day = DAYS_DATA.find(d => String(d.id) === String(dayId));
    const label = type === 'study' ? 'Initial Study' : type.toUpperCase() + ' Revision';
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
      <div class="modal-title">Mark ${label}</div>
      <div class="modal-sub">${formatDayId(dayId)} — ${day ? day.topic : ''}</div>
      <div class="date-input-group">
        <label>Date Completed</label>
        <input type="date" id="datePickerInput" value="${todayISO()}" max="${todayISO()}" />
      </div>
      <div class="modal-btn-row">
        <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" onclick="App.confirmDateModal('${dayId}','${type}')">Mark Done</button>
      </div>
    `;
    document.getElementById('modal-overlay').classList.add('open');
  }

  function confirmDateModal(dayId, type) {
    const input = document.getElementById('datePickerInput');
    const dateISO = input.value;
    if (!dateISO) { toast('Please select a date'); return; }
    if (type === 'study') markStudied(dayId, dateISO);
    else markRevision(dayId, type, dateISO);
    closeModal();
    setTimeout(() => {
      const card = document.getElementById('dc-' + dayId);
      if (card && !card.classList.contains('open')) card.classList.add('open');
    }, 100);
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
  }

  // ── ADD TOPIC MODAL ───────────────────────────────────────────────────────
  function showAddTopicModal(sec) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
      <div class="modal-title">Add Topic to ${SECTIONS_META[sec].label}</div>
      <div class="modal-sub">This will appear as a new day card in this section</div>
      <div class="date-input-group">
        <label>Topic Name</label>
        <input type="text" id="newTopicInput" placeholder="Enter topic name..." style="padding:10px 14px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:14px;width:100%;background:var(--bg);color:var(--text);outline:none" />
      </div>
      <div class="modal-btn-row">
        <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" onclick="App.confirmAddTopic('${sec}')">Add Topic</button>
      </div>
    `;
    document.getElementById('modal-overlay').classList.add('open');
    setTimeout(() => document.getElementById('newTopicInput').focus(), 100);
  }

  function confirmAddTopic(sec) {
    const input = document.getElementById('newTopicInput');
    const topic = input.value.trim();
    if (!topic) { toast('Please enter a topic name'); return; }
    snapshot();
    // Generate a unique custom ID
    const customId = 'c_' + sec + '_' + Date.now();
    // Add to DAYS_DATA (runtime only — this session)
    DAYS_DATA.push({ id: customId, sec, topic, custom: true });
    STATE[customId] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
    saveToDB(); closeModal(); renderAll();
    toast('Topic added');
  }

  function showAddExtraTopicModal(dayId) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML = `
      <div class="modal-title">Add Sub-topic</div>
      <div class="modal-sub">Add a supplementary topic to ${formatDayId(dayId)}</div>
      <div class="date-input-group">
        <label>Sub-topic Name</label>
        <input type="text" id="extraTopicInput" placeholder="e.g. PYQs, Extra Notes..." style="padding:10px 14px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:14px;width:100%;background:var(--bg);color:var(--text);outline:none" />
      </div>
      <div class="modal-btn-row">
        <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" onclick="App.confirmAddExtra('${dayId}')">Add</button>
      </div>
    `;
    document.getElementById('modal-overlay').classList.add('open');
    setTimeout(() => document.getElementById('extraTopicInput').focus(), 100);
  }

  function confirmAddExtra(dayId) {
    const input = document.getElementById('extraTopicInput');
    const topic = input.value.trim();
    if (!topic) { toast('Enter a sub-topic name'); return; }
    addExtraTopic(dayId, topic);
    closeModal();
  }

  function confirmRemoveExtra(dayId, topicId) {
    showModal({
      title: 'Remove Sub-topic?', sub: 'This sub-topic will be deleted.',
      confirm: 'Remove', danger: true,
      onConfirm: () => { removeExtraTopic(dayId, topicId); closeModal(); }
    });
  }

  function confirmHideDay(dayId) {
    showModal({
      title: `Remove Day ${formatDayId(dayId)}?`,
      sub: 'Day will be hidden from view. You can restore via Settings > Data > Reset.',
      confirm: 'Remove', danger: true,
      onConfirm: () => { removeCoreDay(dayId); closeModal(); }
    });
  }

  // ── EXPORT / IMPORT ───────────────────────────────────────────────────────
  function exportData() {
    const payload = { version: 2, state: STATE, config: CONFIG, customTopics: DAYS_DATA.filter(d => d.custom), exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `bpsc_tracker_${todayISO()}.json`; a.click();
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
        if (typeof importedState !== 'object') throw new Error();
        snapshot();
        DAYS_DATA.forEach(d => {
          if (importedState[d.id]) STATE[d.id] = importedState[d.id];
        });
        // Restore custom topics
        if (parsed.customTopics) {
          parsed.customTopics.forEach(ct => {
            if (!DAYS_DATA.find(d => d.id === ct.id)) {
              DAYS_DATA.push(ct);
              if (importedState[ct.id]) STATE[ct.id] = importedState[ct.id];
            }
          });
        }
        if (parsed.config) CONFIG = { ...buildDefaultConfig(), ...parsed.config };
        saveToDB(); renderAll();
        toast('⬆ Import successful');
      } catch { toast('⚠ Invalid JSON file'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── TOAST ──────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  return {
    init, setView, filterSection,
    toggleCard,
    handleStudyCheck, handleChipClick, handleRevCheck, promptUnmarkStudy,
    showDateModalFor, confirmDateModal, closeModal,
    showAddTopicModal, confirmAddTopic,
    showAddExtraTopicModal, confirmAddExtra,
    confirmRemoveExtra, confirmHideDay,
    scheduleNextDay,
    saveSchedule, resetSchedule, confirmResetAll,
    exportData, importData,
    undo, redo,
  };
})();

document.addEventListener('DOMContentLoaded', () => App.init());
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
