// ─── BPSC TRACKER v3 · app.js ────────────────────────────────────────────────
const App = (() => {
  const DB_NAME = 'bpsc_tracker_v3';
  const DB_VER  = 1;
  const STORE   = 'state';
  const KEY     = 'main';

  let db       = null;
  let STATE    = {};
  let CONFIG   = buildDefaultConfig();
  let HISTORY  = [];
  let FUTURE   = [];
  let currentView    = 'today';
  let currentSection = 'all';
  let TODAY = new Date(); TODAY.setHours(0,0,0,0);

  // ── CONFIG ──────────────────────────────────────────────────────────────
  function buildDefaultConfig() {
    return {
      revSchedule: typeof REV_SCHEDULE !== 'undefined' ? REV_SCHEDULE.map(r => Object.assign({}, r)) : [],
      phases:      typeof STUDY_PLAN   !== 'undefined' && STUDY_PLAN.phases
        ? STUDY_PLAN.phases.map(p => Object.assign({}, p)) : []
    };
  }

  function getEffectiveSchedule() {
    return (CONFIG.revSchedule && CONFIG.revSchedule.length)
      ? CONFIG.revSchedule
      : REV_SCHEDULE;
  }

  function getActivePhases() {
    return (CONFIG.phases && CONFIG.phases.length)
      ? CONFIG.phases
      : STUDY_PLAN.phases;
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  async function init() {
    await openDB();
    let saved = await loadFromDB();

    // Fallback: if IndexedDB empty, try localStorage backup
    if (!saved) {
      try {
        const backup = localStorage.getItem('bpsc_v3_backup');
        if (backup) { saved = JSON.parse(backup); console.warn('[BPSC] IndexedDB empty — restored from localStorage backup'); }
      } catch(_) {}
    }

    STATE  = (saved && saved.state)  ? saved.state  : buildFreshState();
    CONFIG = (saved && saved.config) ? Object.assign({}, buildDefaultConfig(), saved.config) : buildDefaultConfig();

    // Normalize phases
    if (CONFIG.phases) {
      CONFIG.phases = CONFIG.phases.map(p => {
        if (!p.days && p.range) p.days = p.range;
        if (!p.days) p.days = [1, 90];
        return p;
      });
    }

    // Restore custom topics
    if (saved && saved.customTopics) {
      saved.customTopics.forEach(ct => {
        if (!DAYS_DATA.find(d => String(d.id) === String(ct.id))) DAYS_DATA.push(ct);
      });
    }

    // Remove topics the user previously deleted (so they don't reappear on reload)
    if (saved && saved.deletedIds && Array.isArray(saved.deletedIds)) {
      saved.deletedIds.forEach(id => {
        const idx = DAYS_DATA.findIndex(d => String(d.id) === String(id));
        if (idx > -1) DAYS_DATA.splice(idx, 1);
        delete STATE[String(id)];
      });
    }

    // Restore ID counters
    if (saved && saved.idCounters) Object.assign(SECTION_ID_COUNTERS, saved.idCounters);

    // Restore deleted IDs list
    if (saved && saved.deletedIds) DELETED_IDS = saved.deletedIds;

    renderAll();
    updateUndoRedoBtns();

    // Midnight refresh
    setInterval(() => {
      const n = new Date(); n.setHours(0,0,0,0);
      if (n.getTime() !== TODAY.getTime()) { TODAY = n; renderAll(); }
    }, 60000);
  }

  function buildFreshState() {
    const s = {};
    DAYS_DATA.forEach(d => {
      s[String(d.id)] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
    });
    return s;
  }

  function initRevs() {
    const r = {};
    getEffectiveSchedule().forEach(rev => { r[rev.key] = null; });
    return r;
  }

  function ensureDayState(dayId) {
    const key = String(dayId);
    if (!STATE[key]) {
      STATE[key] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
    }
    const st = STATE[key];
    if (!st.extraTopics) st.extraTopics = [];
    if (!st.notes)       st.notes = '';
    if (!st.revisions)   st.revisions = initRevs();
    getEffectiveSchedule().forEach(r => {
      if (st.revisions[r.key] === undefined) st.revisions[r.key] = null;
    });
    return st;
  }

  // ── INDEXEDDB ─────────────────────────────────────────────────────────────
  function openDB() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
      req.onsuccess = e => { db = e.target.result; res(); };
      req.onerror   = () => rej();
    });
  }

  function loadFromDB() {
    return new Promise(res => {
      if (!db) { res(null); return; }
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => res(req.result || null);
      req.onerror   = () => res(null);
    });
  }

  // Track deleted built-in topic IDs so they don't reappear on reload
  let DELETED_IDS = [];

  function saveToDB() {
    const customTopics = DAYS_DATA.filter(d => d.custom);
    const payload = deepClone({
      state: STATE,
      config: CONFIG,
      customTopics,
      deletedIds: DELETED_IDS,
      idCounters: typeof SECTION_ID_COUNTERS !== 'undefined' ? SECTION_ID_COUNTERS : {},
      savedAt: new Date().toISOString(),
    });

    // Save to localStorage FIRST (most reliable across sessions)
    try { localStorage.setItem('bpsc_v3_backup', JSON.stringify(payload)); } catch(_){}
    try { localStorage.setItem('bpsc_v3_backup2', JSON.stringify(payload)); } catch(_){} // second copy

    // Save to IndexedDB
    if (db) {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(payload, KEY);
        tx.onerror = () => console.error('[BPSC] IndexedDB save failed');
      } catch(e) { console.error('[BPSC] IndexedDB error:', e); }
    }
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
    ['undoBtn','undoBtn2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !HISTORY.length;
    });
    ['redoBtn','redoBtn2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !FUTURE.length;
    });
  }

  // ── DATE HELPERS ──────────────────────────────────────────────────────────
  function fmtISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function fmtDisplay(iso) {
    if (!iso) return '';
    const parts = iso.split('-').map(Number);
    const y = parts[0], m = parts[1], d = parts[2];
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d + ' ' + M[m-1] + " '" + String(y).slice(2);
  }
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return fmtISO(d);
  }
  function daysDiff(isoA, isoB) {
    return Math.round((new Date(isoB + 'T00:00:00') - new Date(isoA + 'T00:00:00')) / 86400000);
  }
  function isToday(iso) { return iso === fmtISO(TODAY); }
  function isPast(iso)  { return iso < fmtISO(TODAY); }
  function todayISO()   { return fmtISO(TODAY); }

  // ── REVISION LOGIC ─────────────────────────────────────────────────────────
  function getRevTarget(dayId, revKey, st) {
    if (!st) st = ensureDayState(dayId);
    if (!st.studyDate) return null;

    const sched  = getEffectiveSchedule();
    const rIndex = sched.findIndex(x => x.key === revKey);
    if (rIndex === -1) return null;

    let baseDate;
    if (rIndex === 0) {
      baseDate = st.studyDate;
    } else {
      const prevKey = sched[rIndex - 1].key;
      baseDate = st.revisions[prevKey];
    }

    if (!baseDate) return null;
    const gap = sched[rIndex].gap !== undefined ? sched[rIndex].gap : (sched[rIndex].days || 1);
    return addDays(baseDate, gap);
  }

  function getRevStatus(dayId, revKey, st) {
    if (!st) st = ensureDayState(dayId);
    if (st.revisions[revKey]) return 'done';

    const sched  = getEffectiveSchedule();
    const rIndex = sched.findIndex(x => x.key === revKey);

    let nextActionableIndex = -1;
    for (let i = 0; i < sched.length; i++) {
      const isDone = !!st.revisions[sched[i].key];
      if (isDone) continue;
      if (i === 0) {
        if (st.studyDate) { nextActionableIndex = i; break; }
      } else {
        if (st.revisions[sched[i-1].key]) { nextActionableIndex = i; break; }
      }
      break;
    }

    if (!st.studyDate) return 'locked';

    if (rIndex === nextActionableIndex) {
      const target = getRevTarget(dayId, revKey, st);
      if (!target) return 'locked';
      if (isToday(target)) return 'due-today';
      if (isPast(target))  return 'overdue';
      return 'upcoming';
    }

    if (rIndex === nextActionableIndex + 1) {
      const prevTarget = getRevTarget(dayId, sched[rIndex - 1].key, st);
      if (!prevTarget) return 'locked';
      return 'upcoming-preview';
    }

    return 'locked';
  }

  function isDayActionable(dayId) {
    const st   = ensureDayState(dayId);
    const sched = getEffectiveSchedule();
    return sched.some(r => {
      const s = getRevStatus(dayId, r.key, st);
      return s === 'due-today' || s === 'overdue';
    });
  }

  // ── PLAN / PHASE HELPERS ──────────────────────────────────────────────────

  // IST offset = UTC+5:30
  function getTodayIST() {
    const now = new Date();
    // Convert to IST by adding 5h30m to UTC
    const istOffset = 5.5 * 60 * 60000;
    const ist = new Date(now.getTime() + istOffset - now.getTimezoneOffset() * 60000);
    ist.setHours(0, 0, 0, 0);
    return ist;
  }

  function getPlanDay() {
    const start = new Date(STUDY_PLAN.startDate + 'T00:00:00+05:30');
    const todayIST = getTodayIST();
    const startIST = new Date(start.getTime());
    startIST.setHours(0, 0, 0, 0);
    return Math.max(1, Math.floor((todayIST - startIST) / 86400000) + 1);
  }

  function getPlanDateForDay(planDay) {
    const start = new Date(STUDY_PLAN.startDate + 'T00:00:00');
    start.setDate(start.getDate() + planDay - 1);
    return fmtISO(start);
  }

  function normalizePhase(p) {
    if (!p.days && p.range) p.days = p.range;
    if (!p.days) p.days = [1, 90];
    return p;
  }

  function getCurrentPhase() {
    const pd     = getPlanDay();
    const phases = getActivePhases().map(normalizePhase);
    return phases.find(p => pd >= p.days[0] && pd <= p.days[1]) || phases[phases.length - 1] || null;
  }

  function getDaysToExam() {
    return daysDiff(todayISO(), STUDY_PLAN.examDate);
  }

  // ── DYNAMIC PHASE SCHEDULER ───────────────────────────────────────────────
  //
  // LOGIC:
  // 1. Get all topics for this phase (by section)
  // 2. Separate into: already read (done) vs unread (pending)
  // 3. buffer = R1gap + R2gap + R3gap (days needed after last read to finish R3)
  // 4. availableDays = totalPhaseDays - buffer
  // 5. topicsPerDay = ceil(totalTopics / availableDays)  ← more topics/day so all finish R3 in phase
  // 6. Recalibrate: assign ONLY unread topics to dates starting from TODAY
  //    (already read topics keep their actual study date, no reassignment needed)
  // 7. If a topic's assigned date < today → it is BACKLOG
  // 8. Every time a topic is marked read → scheduler recalibrates remaining unread topics
  //
  // This means:
  // - topicsPerDay is fixed by phase math (e.g. 2/day for Phase 1)
  // - As you read topics, remaining topics shift forward from today
  // - Backlog = unread topics whose assigned date is already past
  // ─────────────────────────────────────────────────────────────────────────

  function getPhaseTopics(phase) {
    normalizePhase(phase);
    return DAYS_DATA.filter(d => phase.sections && phase.sections.includes(d.sec));
  }

  function computePhaseSchedule(phase) {
    normalizePhase(phase);
    const sched     = getEffectiveSchedule();
    const allTopics = getPhaseTopics(phase);
    const totalDays = phase.days[1] - phase.days[0] + 1;

    // Buffer = sum of R1+R2+R3 gaps so last read topic can still finish R3 in phase
    const r1gap  = sched[0] ? sched[0].gap : 1;
    const r2gap  = sched[1] ? sched[1].gap : 2;
    const r3gap  = sched[2] ? sched[2].gap : 4;
    const buffer = r1gap + r2gap + r3gap; // = 7 by default

    // topicsPerDay based on TOTAL topics in phase (fixed pace target)
    const availableDays = Math.max(1, totalDays - buffer);
    const topicsPerDay  = Math.ceil(allTopics.length / availableDays);

    // Split into read and unread
    const readTopics   = allTopics.filter(d => ensureDayState(d.id).studyDate);
    const unreadTopics = allTopics.filter(d => !ensureDayState(d.id).studyDate);

    // Phase start and end calendar dates
    const phaseStartDate = getPlanDateForDay(phase.days[0]);
    const phaseEndDate   = getPlanDateForDay(phase.days[1]);
    const tISO           = todayISO();

    // Recalibrate: assign unread topics starting from TODAY (or phase start if not started yet)
    // Assign in batches of topicsPerDay per day
    const assignments = {}; // topicId → { assignedDate, daysLate }

    // Already read topics: their assignment = their actual study date (done, no recalibration needed)
    readTopics.forEach(d => {
      const st = ensureDayState(d.id);
      assignments[String(d.id)] = {
        assignedDate: st.studyDate,
        status: 'done',
        daysLate: 0,
      };
    });

    // Unread topics: use ORIGINAL expected date (position in full topic list from phase start).
    // This correctly flags topics that should have been read by now as 'overdue'.
    // recalDate = compressed from today, used only for Today view scheduling.
    const assignStartDate = tISO >= phaseStartDate ? tISO : phaseStartDate;

    // Sort allTopics by planDay so position is stable after add/delete
    const sortedTopics = allTopics.slice().sort((a, b) => (a.planDay || 9999) - (b.planDay || 9999));
    const phaseOffset  = phase.days[0] - 1; // planDay of first topic in phase

    sortedTopics.forEach((topic, globalIdx) => {
      if (ensureDayState(topic.id).studyDate) return; // already done

      // Use planDay-relative position as stable anchor (survives add/delete/renumber)
      const stableIdx            = (topic.planDay != null) ? (topic.planDay - phaseOffset - 1) : globalIdx;
      const originalExpectedDate = addDays(phaseStartDate, Math.floor(Math.max(0, stableIdx) / topicsPerDay));
      const unreadIdx  = unreadTopics.indexOf(topic);
      const recalDate  = addDays(assignStartDate, Math.floor(unreadIdx / topicsPerDay));

      const isPast   = originalExpectedDate < tISO;
      const isToday_ = originalExpectedDate === tISO;
      const daysLate = isPast ? daysDiff(originalExpectedDate, tISO) : 0;

      assignments[String(topic.id)] = {
        assignedDate: isPast || isToday_ ? originalExpectedDate : recalDate,
        recalDate,
        status: isPast ? 'overdue' : isToday_ ? 'today' : 'upcoming',
        daysLate,
      };
    });

    // Phase progress stats
    const studiedCount  = readTopics.length;
    const expectedByNow = allTopics.filter(d => {
      const a = assignments[String(d.id)];
      return a && a.assignedDate <= tISO;
    }).length;
    const behind = Math.max(0, expectedByNow - studiedCount);

    return {
      assignments,
      topicsPerDay,
      availableDays,
      buffer,
      allTopics,
      readTopics,
      unreadTopics,
      studiedCount,
      expectedByNow,
      behind,
      phaseStartDate,
      phaseEndDate,
    };
  }

  // Get today's assigned unread topics for Today view — uses recalDate (compressed schedule)
  function getTodayTargets() {
    const tISO    = todayISO();
    const targets = [];
    getActivePhases().map(normalizePhase).forEach(phase => {
      const { assignments } = computePhaseSchedule(phase);
      Object.entries(assignments).forEach(([id, info]) => {
        // Show topics whose recalibrated date is today (includes backlog recovery topics)
        const schedDate = info.recalDate || info.assignedDate;
        if (schedDate === tISO && info.status !== 'done') {
          const topic = DAYS_DATA.find(d => String(d.id) === String(id));
          if (topic) targets.push({ topic, info });
        }
      });
    });
    return targets;
  }

  // Get upcoming unread topics (next few days after today) — uses recalDate
  function getUpcomingTargets() {
    const tISO    = todayISO();
    const upcoming = [];
    getActivePhases().map(normalizePhase).forEach(phase => {
      const { assignments } = computePhaseSchedule(phase);
      Object.entries(assignments).forEach(([id, info]) => {
        if (info.status === 'upcoming') {
          const schedDate = info.recalDate || info.assignedDate;
          if (schedDate > tISO) {
            const topic = DAYS_DATA.find(d => String(d.id) === String(id));
            if (topic) upcoming.push({ topic, info: { ...info, assignedDate: schedDate } });
          }
        }
      });
    });
    upcoming.sort((a, b) => a.info.assignedDate.localeCompare(b.info.assignedDate));
    return upcoming.slice(0, 5);
  }

  // ── PHASE PULSE (Recalibration Card) ─────────────────────────────────────


  function getBacklogData() {
    const overdueTopics    = [];
    const pendingRevisions = [];

    // Collect overdue reads across all phases
    getActivePhases().map(normalizePhase).forEach(phase => {
      const { assignments } = computePhaseSchedule(phase);
      Object.entries(assignments).forEach(([id, info]) => {
        if (info.status === 'overdue') {
          const topic = DAYS_DATA.find(d => String(d.id) === String(id));
          if (topic) {
            overdueTopics.push({ day: topic, assignedDate: info.assignedDate, daysLate: info.daysLate });
          }
        }
      });
    });

    // Sort by plan order (serial sequence)
    overdueTopics.sort((a, b) => (a.day.planDay || 9999) - (b.day.planDay || 9999));

    // Collect overdue revisions
    DAYS_DATA.forEach(d => {
      const st = ensureDayState(d.id);
      if (!st.studyDate) return;
      const sched = getEffectiveSchedule();
      const overdueRevs = sched.filter(r => getRevStatus(d.id, r.key, st) === 'overdue').length;
      if (overdueRevs > 0) pendingRevisions.push({ day: d, overdueRevs });
    });

    // Phase progress for current phase
    const phase = getCurrentPhase();
    let phaseProgress = null;
    if (phase) {
      const result = computePhaseSchedule(phase);
      phaseProgress = {
        phase,
        studiedCount:  result.studiedCount,
        total:         result.allTopics.length,
        expectedByNow: result.expectedByNow,
        behind:        result.behind,
        topicsPerDay:  result.topicsPerDay,
      };
    }

    return { overdueTopics, pendingRevisions, phaseProgress };
  }

  function calcStreak() {
    let streak = 0;
    const sched = getEffectiveSchedule();
    const date  = new Date(TODAY);
    while (true) {
      const iso = fmtISO(date);
      const hasActivity = DAYS_DATA.some(d => {
        const st = STATE[String(d.id)] || {};
        if (st.studyDate === iso) return true;
        return sched.some(r => (st.revisions || {})[r.key] === iso);
      });
      if (!hasActivity) break;
      streak++;
      date.setDate(date.getDate() - 1);
    }
    return streak;
  }

  // ── ACTIONS ───────────────────────────────────────────────────────────────
  function toggleSidebar() {
    if (window.innerWidth <= 700) {
      document.body.classList.toggle('sidebar-open');
    } else {
      document.body.classList.toggle('sidebar-closed');
    }
  }

  function markStudied(dayId, dateISO) {
    snapshot();
    ensureDayState(dayId).studyDate = dateISO;
    saveToDB(); renderAll(); toast('✓ Marked as read');
  }

  function unmarkStudied(dayId) {
    snapshot();
    const st     = ensureDayState(dayId);
    st.studyDate = null;
    st.revisions = initRevs();
    saveToDB(); renderAll(); toast('Study date removed');
  }

  function markRevision(dayId, revKey, dateISO) {
    snapshot();
    ensureDayState(dayId).revisions[revKey] = dateISO;
    saveToDB(); renderAll(); toast('✓ ' + revKey.toUpperCase() + ' done');
  }

  function unmarkRevision(dayId, revKey) {
    snapshot();
    const sched  = getEffectiveSchedule();
    const st     = ensureDayState(dayId);
    const rIndex = sched.findIndex(x => x.key === revKey);
    for (let i = rIndex; i < sched.length; i++) {
      st.revisions[sched[i].key] = null;
    }
    saveToDB(); renderAll(); toast(revKey.toUpperCase() + ' removed');
  }

  function scheduleNextDay(dayId, revKey) {
    snapshot();
    ensureDayState(dayId).revisions[revKey] = addDays(todayISO(), 1);
    saveToDB(); renderAll(); toast(revKey.toUpperCase() + ' →+1d');
  }

  // ── ROUTING ───────────────────────────────────────────────────────────────
  function setView(v, btn) {
    currentView = v;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else { const nb = document.querySelector('[data-view="' + v + '"]'); if (nb) nb.classList.add('active'); }
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    const vEl = document.getElementById('view' + v.charAt(0).toUpperCase() + v.slice(1));
    if (vEl) vEl.classList.add('active');
    const titles = { today:'Today', all:'All Days', stats:'Statistics', settings:'Settings', backlog:'Backlog' };
    document.getElementById('pageTitle').textContent = titles[v] || v;
    renderCurrentView();
    updatePageSub();
  }

  function filterSection(sec, btn) {
    currentSection = sec;
    document.querySelectorAll('.sec-item').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (currentView !== 'all') setView('all', null);
    else renderAllView();
  }

  function updatePageSub() {
    const sub = document.getElementById('pageSub');
    if (!sub) return;
    if (currentView === 'today') {
      const due = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
      sub.textContent = due > 0 ? (due + ' revision' + (due>1?'s':'') + ' need attention') : 'All caught up!';
    } else if (currentView === 'backlog') {
      const { overdueTopics } = getBacklogData();
      sub.textContent = overdueTopics.length > 0 ? (overdueTopics.length + ' overdue topics') : 'Phase on track';
    } else {
      sub.textContent = '';
    }
  }

  function renderAll() {
    try { renderHeader(); } catch(e) { console.error('renderHeader:', e); }
    try { renderTodayView(); } catch(e) { console.error('renderTodayView:', e); }
    try {
      if (currentView === 'all')      renderAllView();
      if (currentView === 'stats')    renderStatsView();
      if (currentView === 'settings') renderSettingsView();
      if (currentView === 'backlog')  renderBacklogView();
    } catch(e) { console.error('renderView:', e); }
    // Always re-render backlog in background so badge/count stays in sync
    // even when user is on a different view
    try {
      if (currentView !== 'backlog') renderBacklogView();
    } catch(e) { console.error('renderBacklogBg:', e); }
    try { updateBadges(); } catch(e) { console.error('updateBadges:', e); }
    try { updatePageSub(); } catch(e) { console.error('updatePageSub:', e); }
  }

  function renderCurrentView() {
    if (currentView === 'today')    renderTodayView();
    if (currentView === 'all')      renderAllView();
    if (currentView === 'stats')    renderStatsView();
    if (currentView === 'settings') renderSettingsView();
    if (currentView === 'backlog')  renderBacklogView();
  }

  // ── HEADER ────────────────────────────────────────────────────────────────
  function renderHeader() {
    const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateEl = document.getElementById('dateDisplay');
    if (dateEl) dateEl.textContent = days[TODAY.getDay()] + ' ' + TODAY.getDate() + ' ' + months[TODAY.getMonth()] + ' ' + TODAY.getFullYear();
    const streakEl = document.getElementById('streakChip');
    if (streakEl) streakEl.textContent = '🔥 ' + calcStreak();
    const dte = getDaysToExam();
    const examEl = document.getElementById('examCountdown');
    if (examEl) examEl.textContent = dte <= 0 ? '📝 Exam Day!' : dte <= STUDY_PLAN.graceDays ? ('🕊 Grace: ' + dte + 'd') : ('📅 ' + dte + 'd to exam');
  }

  function updateBadges() {
    const due = DAYS_DATA.filter(d => !ensureDayState(d.id).hidden && isDayActionable(d.id)).length;
    const badge = document.getElementById('badge-today');
    if (badge) badge.textContent = due > 0 ? due : '';
    const { overdueTopics, pendingRevisions } = getBacklogData();
    const bBadge = document.getElementById('badge-backlog');
    if (bBadge) { bBadge.textContent = overdueTopics.length > 0 ? overdueTopics.length : ''; }
  }

  // ── TODAY VIEW ────────────────────────────────────────────────────────────
  function renderTodayView() {
    const el = document.getElementById('viewToday');
    if (!el) return;

    const sched         = getEffectiveSchedule();
    const studied       = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
    const totalRevDone  = DAYS_DATA.reduce((acc,d) => acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
    const planDay       = getPlanDay();
    const phase         = getCurrentPhase();
    const phaseDaysLeft = phase ? Math.max(0, phase.days[1] - planDay) : 0;
    const tISO          = todayISO();

    // Overdue revisions + due today revisions
    const dueItems = [];
    DAYS_DATA.forEach(day => {
      const st = ensureDayState(day.id);
      if (st.hidden) return;
      sched.forEach(r => {
        const s = getRevStatus(day.id, r.key, st);
        if (s === 'due-today' || s === 'overdue') {
          dueItems.push({ day: day, revKey: r.key, label: r.label, status: s });
        }
      });
    });

    // Today's initial read targets (assigned by phase scheduler for today)
    const todayTargets  = getTodayTargets();

    // Topics studied today
    const studiedToday  = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate === tISO);

    const phaseHtml = phase ? (
      '<div class="plan-bar">' +
        '<span class="plan-phase-tag" style="background:' + phase.color + '22;color:' + phase.color + ';border:1px solid ' + phase.color + '44">' + phase.label + '</span>' +
        '<span class="plan-desc">' + (phase.desc || '') + '</span>' +
        '<span class="plan-day-num">Plan Day ' + planDay + '</span>' +
      '</div>'
    ) : '';

    // Today's read targets section
    const todayTargetsHtml = todayTargets.length > 0 ?
      '<div class="section-title" style="margin-top:24px">📖 Today\'s Read Targets <span class="count-chip orange">' + todayTargets.length + '</span></div>' +
      '<div class="rev-due-list">' +
        todayTargets.map(({ topic }) =>
          '<div class="rev-due-card" style="border-left:3px solid var(--gold)">' +
            '<div class="rdc-day">' + formatDayId(topic.id) + '</div>' +
            '<div class="rdc-topic" onclick="App.openTopicDetail(\'' + topic.id + '\')">' +
              topic.topic +
              '<small>' + (SECTIONS_META[topic.sec] ? SECTIONS_META[topic.sec].label : '') + ' · Scheduled for today</small>' +
            '</div>' +
            '<div class="rdc-actions">' +
              '<button class="bl-mark" onclick="App.showDateModal(\'' + topic.id + '\',\'study\')">Mark Read</button>' +
            '</div>' +
          '</div>'
        ).join('') +
      '</div>'
    : '<div class="section-title" style="margin-top:24px">📖 Today\'s Read Targets</div>' +
      '<div class="no-due" style="background:var(--gold-light);border-color:#EDD894;color:var(--gold)">✓ No new reads scheduled for today</div>';

    // Phase-focused hero stats — backlog uses overdueTopics.length (same source as badge)
    const phaseResult  = phase ? computePhaseSchedule(phase) : null;
    const phaseRead    = phaseResult ? phaseResult.studiedCount : 0;
    const phaseTotal   = phaseResult ? phaseResult.allTopics.length : 0;
    const phaseBacklog = getBacklogData().overdueTopics.length;  // single source of truth
    const phaseRemain  = phaseTotal - phaseRead;
    const newPace      = phaseResult && phaseDaysLeft > 0
      ? (phaseRemain / phaseDaysLeft).toFixed(1)
      : phaseRemain;

    el.innerHTML = phaseHtml +
      '<div class="today-hero">' +
        '<div class="hero-card accent" onclick="App.showAnalysisModal(\'phase\')">' +
          '<div class="hero-num">' + phaseRead + '<span style="font-size:14px;opacity:0.7">/' + phaseTotal + '</span></div>' +
          '<div class="hero-label">Phase Read</div>' +
        '</div>' +
        '<div class="hero-card' + (phaseBacklog > 0 ? ' hero-card-warn' : '') + '" onclick="App.showAnalysisModal(\'phase\')">' +
          '<div class="hero-num' + (phaseBacklog > 0 ? ' hero-num-red' : '') + '">' + phaseBacklog + '</div>' +
          '<div class="hero-label">Backlog</div>' +
        '</div>' +
        '<div class="hero-card" onclick="App.showAnalysisModal(\'phase\')">' +
          '<div class="hero-num">' + newPace + '</div>' +
          '<div class="hero-label">Topics/Day</div>' +
        '</div>' +
        '<div class="hero-card' + (dueItems.length > 0 ? ' hero-card-warn' : '') + '" onclick="App.showAnalysisModal(\'due\')">' +
          '<div class="hero-num' + (dueItems.length > 0 ? ' hero-num-red' : '') + '">' + dueItems.length + '</div>' +
          '<div class="hero-label">Rev. Due</div>' +
        '</div>' +
      '</div>' +

      // Revisions due
      (dueItems.length > 0 ?
        '<div class="section-title">🔁 Revisions Due <span class="count-chip">' + dueItems.length + '</span></div>' +
        '<div class="rev-due-list">' + dueItems.map(item => renderDueCard(item)).join('') + '</div>'
      :
        '<div class="section-title">🔁 Revisions Due</div>' +
        '<div class="no-due">✓ No revisions due today — well done!</div>'
      ) +

      // Today's read targets
      todayTargetsHtml +

      // Studied today
      (studiedToday.length > 0 ?
        '<div class="section-title" style="margin-top:24px">✅ Read Today <span class="count-chip green">' + studiedToday.length + '</span></div>' +
        '<div class="rev-due-list">' +
          studiedToday.map(day =>
            '<div class="rev-due-card completed">' +
              '<div class="rdc-day">' + formatDayId(day.id) + '</div>' +
              '<div class="rdc-topic" onclick="App.openTopicDetail(\'' + day.id + '\')">' +
                day.topic +
                '<small>' + (SECTIONS_META[day.sec] ? SECTIONS_META[day.sec].label : '') + '</small>' +
              '</div>' +
              '<div class="rdc-rev-label">READ</div>' +
              '<div class="rdc-check done" onclick="App.promptUnmarkStudy(\'' + day.id + '\')">✓</div>' +
            '</div>'
          ).join('') +
        '</div>'
      : '');
  }

  function renderDueCard(item) {
    const day = item.day, revKey = item.revKey, label = item.label, status = item.status;
    const st          = ensureDayState(day.id);
    const isDone      = !!st.revisions[revKey];
    const target      = getRevTarget(day.id, revKey, st);
    const overdueDays = status === 'overdue' ? daysDiff(target, todayISO()) : 0;
    const sectionName = SECTIONS_META[day.sec] ? SECTIONS_META[day.sec].label : 'General';

    return '<div class="rev-due-card ' + (isDone ? 'completed' : status === 'overdue' ? 'overdue' : '') + '">' +
      '<div class="rdc-day">' + formatDayId(day.id) + '</div>' +
      '<div class="rdc-topic" onclick="App.openTopicDetail(\'' + day.id + '\')">' +
        day.topic +
        '<small>' + sectionName + ' · Target: ' + fmtDisplay(target) + (status === 'overdue' ? ' <span class="overdue-tag">' + overdueDays + 'd late</span>' : '') + '</small>' +
      '</div>' +
      '<div class="rdc-actions">' +
        '<button class="rdc-snooze" onclick="App.scheduleNextDay(\'' + day.id + '\',\'' + revKey + '\')" title="Schedule for tomorrow">→+1</button>' +
        '<div class="rdc-rev-label rev-' + revKey + '">' + label + '</div>' +
        '<div class="rdc-check ' + (isDone ? 'done' : '') + '" onclick="App.handleRevCheck(\'' + day.id + '\',\'' + revKey + '\',event)">' + (isDone ? '✓' : '') + '</div>' +
      '</div>' +
    '</div>';
  }

  function formatDayId(id) {
    const sid = String(id);
    if (sid.startsWith('s'))    return 'S' + sid.slice(1).padStart(2,'0');
    if (sid.startsWith('c_')) {
      const day = DAYS_DATA.find(d => String(d.id) === sid);
      if (day && day.seqNum) return 'D' + String(day.seqNum).padStart(3,'0');
      return sid.toUpperCase().slice(0,6);
    }
    if (sid.startsWith('r_'))   return sid.replace('r_','').replace('_','.').toUpperCase();
    if (sid.startsWith('g'))    return 'G' + sid.slice(1).padStart(2,'0');
    if (sid.startsWith('ca'))   return sid.toUpperCase().slice(0,6);
    if (sid.startsWith('rev'))  return 'REV';
    if (sid.startsWith('mock')) return 'MOCK';
    if (!isNaN(Number(sid)))    return 'D' + sid.padStart(3,'0');
    return sid.toUpperCase().slice(0,6);
  }

  // ── ANALYTICS MODALS ──────────────────────────────────────────────────────
  // ── RECALIBRATION MODAL (replaces old static analysis modal) ─────────────
  // Every hero card tap → opens this with live recalibrated data for that type.
  // No stale numbers. Computed fresh from STATE on every open.
  function showAnalysisModal(type) {
    const planDay  = getPlanDay();
    const phase    = getCurrentPhase();
    const bd       = getBacklogData();
    const sched    = getEffectiveSchedule();
    const tISO     = todayISO();
    let title = '', html = '', insight = '', badge = '';

    // ── TAB SWITCHER (inline, not separate modal) ─────────────────────────
    const tabs = [
      { key:'phase',     icon:'📊', label:'Phase'    },
      { key:'due',       icon:'🔁', label:'Revisions'},
      { key:'studied',   icon:'📖', label:'Coverage' },
      { key:'revisions', icon:'🧠', label:'Memory'   },
    ];
    const tabHtml = '<div class="modal-tabs">' +
      tabs.map(t =>
        '<button class="modal-tab' + (t.key === type ? ' active' : '') + '" onclick="App.showAnalysisModal(\'' + t.key + '\')">' +
          t.icon + ' ' + t.label +
        '</button>'
      ).join('') +
    '</div>';

    // ── PHASE TRAJECTORY (primary / default) ──────────────────────────────
    if (type === 'phase') {
      if (phase) {
        const result       = computePhaseSchedule(phase);
        const phaseDay     = planDay - phase.days[0] + 1;
        const phaseTotalD  = phase.days[1] - phase.days[0] + 1;
        const daysLeft     = Math.max(0, phase.days[1] - planDay);
        const read         = result.studiedCount;
        const total        = result.allTopics.length;
        const expected     = result.expectedByNow;
        const backlog      = result.behind;
        const ahead        = Math.max(0, read - expected);
        const remaining    = total - read;
        const newPace      = daysLeft > 0 ? (remaining / daysLeft).toFixed(1) : remaining;
        const origPace     = result.topicsPerDay;
        const pct          = total > 0 ? Math.round((read / total) * 100) : 0;
        const barPct       = Math.min(100, pct);

        title = phase.label;
        badge = backlog > 0 ? '<span class="modal-badge red">' + backlog + ' behind</span>' :
                ahead  > 0 ? '<span class="modal-badge green">+' + ahead + ' ahead</span>' :
                             '<span class="modal-badge green">On pace</span>';

        // Phase timeline bar
        const phaseBarWidth = Math.min(100, Math.round(((phaseDay - 1) / phaseTotalD) * 100));
        const phaseTimeHtml =
          '<div class="rcal-phase-timeline">' +
            '<div class="rcal-timeline-track">' +
              '<div class="rcal-timeline-fill" style="width:' + phaseBarWidth + '%;background:' + phase.color + '"></div>' +
              '<div class="rcal-timeline-marker" style="left:' + phaseBarWidth + '%"></div>' +
            '</div>' +
            '<div class="rcal-timeline-labels">' +
              '<span>Day ' + phase.days[0] + ' · ' + fmtDisplay(result.phaseStartDate) + '</span>' +
              '<span style="color:' + phase.color + ';font-weight:700">▲ Today · Day ' + phaseDay + '</span>' +
              '<span>Day ' + phase.days[1] + ' · ' + fmtDisplay(result.phaseEndDate) + '</span>' +
            '</div>' +
          '</div>';

        // Progress bar
        const progressHtml =
          '<div class="rcal-prog-row">' +
            '<span class="rcal-prog-label">Topics Completed</span>' +
            '<span class="rcal-prog-val">' + pct + '%</span>' +
          '</div>' +
          '<div class="rcal-bar-track"><div class="rcal-bar-fill" style="width:' + barPct + '%;background:' + phase.color + '"></div></div>';

        // Stat grid
        const statGridHtml =
          '<div class="rcal-grid">' +
            '<div class="rcal-cell"><div class="rcal-num">' + read + '<span class="rcal-denom">/' + total + '</span></div><div class="rcal-lbl">Read</div></div>' +
            '<div class="rcal-cell"><div class="rcal-num' + (backlog > 0 ? ' rcal-red' : '') + '">' + expected + '</div><div class="rcal-lbl">Expected</div></div>' +
            '<div class="rcal-cell"><div class="rcal-num' + (backlog > 0 ? ' rcal-red' : ' rcal-green') + '">' + (backlog > 0 ? '−'+backlog : ahead > 0 ? '+'+ahead : '0') + '</div><div class="rcal-lbl">' + (backlog > 0 ? 'Backlog' : 'Ahead') + '</div></div>' +
            '<div class="rcal-cell"><div class="rcal-num">' + daysLeft + '</div><div class="rcal-lbl">Days Left</div></div>' +
          '</div>';

        // Recalibrated pace block
        const paceUp   = parseFloat(newPace) > origPace + 0.1;
        const paceDown = parseFloat(newPace) < origPace - 0.1;
        const paceHtml =
          '<div class="rcal-pace-block">' +
            '<div class="rcal-pace-row">' +
              '<span>Original pace</span><strong>' + origPace + ' topics/day</strong>' +
            '</div>' +
            '<div class="rcal-pace-row main">' +
              '<span>Required now</span>' +
              '<strong class="' + (paceUp ? 'rcal-red' : paceDown ? 'rcal-green' : '') + '">' +
                newPace + ' topics/day ' + (paceUp ? '▲' : paceDown ? '▼' : '–') +
              '</strong>' +
            '</div>' +
            (backlog > 0 ?
              '<div class="rcal-pace-row">' +
                '<span>To recover backlog</span><strong class="rcal-red">+' + Math.ceil(backlog / Math.max(1, daysLeft)) + ' extra/day</strong>' +
              '</div>' : '') +
            '<div class="rcal-pace-row">' +
              '<span>Topics remaining</span><strong>' + remaining + '</strong>' +
            '</div>' +
          '</div>';

        insight = backlog > 3
          ? '🔴 You are ' + backlog + ' topics behind. Halt new progression — clear the backlog in Backlog tab. New pace: ' + newPace + '/day.'
          : backlog > 0
          ? '🟡 ' + backlog + ' topic' + (backlog>1?'s':'') + ' behind schedule. Read 1 extra topic today to recover. Pace resets to ' + newPace + '/day.'
          : ahead > 0
          ? '🟢 ' + ahead + ' topics ahead. Your pace has relaxed to ' + newPace + '/day. Maintain discipline.'
          : '✅ Exactly on pace. Required rate is ' + newPace + ' topics/day for remaining ' + daysLeft + ' days.';

        html = phaseTimeHtml + progressHtml + statGridHtml + paceHtml;
      } else {
        title = 'Phase Trajectory';
        html  = '<div class="analysis-stat"><span>Status</span><strong>No active phase</strong></div>';
        insight = 'Study plan has ended or not started.';
      }
    }

    // ── REVISIONS DUE ─────────────────────────────────────────────────────
    else if (type === 'due') {
      const dueCount = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
      const overdueCount = DAYS_DATA.reduce((acc, d) => {
        const st = ensureDayState(d.id);
        return acc + sched.filter(r => getRevStatus(d.id, r.key, st) === 'overdue').length;
      }, 0);
      const doneTodayCount = DAYS_DATA.filter(d => {
        const st = ensureDayState(d.id);
        return st.studyDate === tISO || sched.some(r => st.revisions[r.key] === tISO);
      }).length;

      // Recalibrate: if revisions are overdue, memory gaps are forming
      const memoryRisk = overdueCount > 5 ? 'HIGH' : overdueCount > 0 ? 'MEDIUM' : 'LOW';
      const riskColor  = overdueCount > 5 ? 'var(--red)' : overdueCount > 0 ? '#E67E22' : 'var(--green)';

      title = 'Revisions';
      badge = dueCount > 0 ? '<span class="modal-badge red">' + dueCount + ' due</span>' : '<span class="modal-badge green">All clear</span>';
      html  =
        '<div class="rcal-grid">' +
          '<div class="rcal-cell"><div class="rcal-num' + (dueCount>0?' rcal-red':'') + '">' + dueCount + '</div><div class="rcal-lbl">Due Today</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num' + (overdueCount>0?' rcal-red':'') + '">' + overdueCount + '</div><div class="rcal-lbl">Overdue Slots</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num rcal-green">' + doneTodayCount + '</div><div class="rcal-lbl">Done Today</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num" style="color:' + riskColor + '">' + memoryRisk + '</div><div class="rcal-lbl">Memory Risk</div></div>' +
        '</div>' +
        '<div class="rcal-pace-block">' +
          '<div class="rcal-pace-row"><span>Spaced repetition slots pending</span><strong class="' + (dueCount>0?'rcal-red':'rcal-green') + '">' + dueCount + '</strong></div>' +
          '<div class="rcal-pace-row"><span>Overdue beyond today</span><strong class="' + (overdueCount>0?'rcal-red':'rcal-green') + '">' + overdueCount + '</strong></div>' +
        '</div>';
      insight = overdueCount > 5
        ? '🔴 ' + overdueCount + ' revision slots overdue. Topics are escaping long-term memory. Go to Backlog — do revisions before new reads.'
        : overdueCount > 0
        ? '🟡 ' + overdueCount + ' revision slots slightly overdue. Clear them today to keep memory network intact.'
        : dueCount > 0
        ? '🎯 ' + dueCount + ' revisions due today. Complete these first before any new initial reads.'
        : '✅ Revision engine is healthy. All spaced repetition on schedule.';
    }

    // ── COVERAGE ──────────────────────────────────────────────────────────
    else if (type === 'studied') {
      const totalTopics = DAYS_DATA.length;
      const studied     = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
      const pct         = Math.round((studied / totalTopics) * 100);
      const backlogCount = bd.overdueTopics.length;

      // Per-phase breakdown
      const allPhases = getActivePhases().map(normalizePhase);
      const phaseBreakdown = allPhases.map(p => {
        const r = computePhaseSchedule(p);
        const pp = Math.round((r.studiedCount / Math.max(1, r.allTopics.length)) * 100);
        return '<div class="rcal-phase-row" style="border-left:3px solid ' + p.color + '">' +
          '<span style="color:' + p.color + ';font-weight:600">' + p.label + '</span>' +
          '<span>' + r.studiedCount + '/' + r.allTopics.length + '</span>' +
          '<span>' + pp + '%</span>' +
          '<span class="' + (r.behind > 0 ? 'rcal-red' : 'rcal-green') + '">' + (r.behind > 0 ? '−'+r.behind+' behind' : '✓ on pace') + '</span>' +
        '</div>';
      }).join('');

      title = 'Coverage';
      badge = '<span class="modal-badge ' + (backlogCount > 0 ? 'red' : 'green') + '">' + pct + '% done</span>';
      html  =
        '<div class="rcal-prog-row"><span class="rcal-prog-label">Total Progress</span><span class="rcal-prog-val">' + pct + '%</span></div>' +
        '<div class="rcal-bar-track"><div class="rcal-bar-fill" style="width:' + pct + '%;background:var(--burgundy)"></div></div>' +
        '<div class="rcal-grid" style="margin-top:16px">' +
          '<div class="rcal-cell"><div class="rcal-num">' + studied + '</div><div class="rcal-lbl">Read</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num">' + (totalTopics - studied) + '</div><div class="rcal-lbl">Remaining</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num' + (backlogCount>0?' rcal-red':'') + '">' + backlogCount + '</div><div class="rcal-lbl">Backlog</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num">' + totalTopics + '</div><div class="rcal-lbl">Total</div></div>' +
        '</div>' +
        '<div style="margin-top:16px;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Phase Breakdown</div>' +
        phaseBreakdown;
      insight = backlogCount > 0
        ? '🔴 ' + backlogCount + ' topics should have been read by today. Recalibrated schedule is compressing them forward — check Backlog tab.'
        : '✅ All initial reads on pace. ' + (totalTopics - studied) + ' topics remain across ' + allPhases.length + ' phase' + (allPhases.length>1?'s':'') + '.';
    }

    // ── MEMORY / REVISIONS HEALTH ─────────────────────────────────────────
    else if (type === 'revisions') {
      const totalRevDone  = DAYS_DATA.reduce((acc,d) => acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
      const totalPossible = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length * sched.length;
      const totalOverdue  = bd.pendingRevisions.length;
      const revPct        = totalPossible > 0 ? Math.round((totalRevDone / totalPossible) * 100) : 0;

      // R1–R8 completion breakdown
      const revBreakdown = sched.map(r => {
        const done = DAYS_DATA.filter(d => ensureDayState(d.id).revisions[r.key]).length;
        const possible = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
        const p = possible > 0 ? Math.round((done/possible)*100) : 0;
        return '<div class="rcal-rev-row">' +
          '<span class="rcal-rev-key">' + r.label + '</span>' +
          '<div class="rcal-rev-bar-wrap"><div class="rcal-rev-bar" style="width:' + p + '%"></div></div>' +
          '<span class="rcal-rev-pct">' + done + '/' + possible + '</span>' +
        '</div>';
      }).join('');

      title = 'Memory';
      badge = totalOverdue > 0 ? '<span class="modal-badge red">' + totalOverdue + ' leaking</span>' : '<span class="modal-badge green">Healthy</span>';
      html  =
        '<div class="rcal-grid">' +
          '<div class="rcal-cell"><div class="rcal-num">' + totalRevDone + '</div><div class="rcal-lbl">Revisions Done</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num">' + totalPossible + '</div><div class="rcal-lbl">Total Possible</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num' + (totalOverdue>0?' rcal-red':' rcal-green') + '">' + totalOverdue + '</div><div class="rcal-lbl">Topics Leaking</div></div>' +
          '<div class="rcal-cell"><div class="rcal-num">' + revPct + '%</div><div class="rcal-lbl">Rev. Coverage</div></div>' +
        '</div>' +
        '<div style="margin-top:16px;font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Spaced Repetition Ladder</div>' +
        revBreakdown;
      insight = totalOverdue > 5
        ? '🔴 ' + totalOverdue + ' topics have revisions overdue — memory is degrading. Prioritise Backlog before new reads.'
        : totalOverdue > 0
        ? '🟡 ' + totalOverdue + ' topics leaking from memory. Clear their overdue revisions today.'
        : '✅ Spaced repetition engine is fully healthy. All ' + totalRevDone + ' revisions are keeping pace.';
    }

    const mc = document.getElementById('modal-content');
    mc.innerHTML =
      tabHtml +
      '<div class="modal-title">' + title + (badge ? ' ' + badge : '') + '</div>' +
      
      html +
      '<div class="analysis-insight">' + insight + '</div>' +
      '<div class="modal-btn-row" style="margin-top:20px"><button class="btn-primary" onclick="App.closeModal()">Got it</button></div>';
    document.getElementById('modal-overlay').classList.add('open');
  }

  // ── ALL DAYS VIEW ─────────────────────────────────────────────────────────
  function renderAllView() {
    const el = document.getElementById('viewAll');
    if (!el) return;
    const sections = currentSection === 'all' ? Object.keys(SECTIONS_META) : [currentSection];
    let html = '';

    sections.forEach(sec => {
      if (!SECTIONS_META[sec]) return;
      const meta         = SECTIONS_META[sec];
      const days         = DAYS_DATA.filter(d => d.sec === sec && !ensureDayState(d.id).hidden);
      const studiedCount = days.filter(d => ensureDayState(d.id).studyDate).length;

      html += '<div class="days-section-header" style="border-left-color:' + meta.color + '">' +
        '<span style="color:' + meta.color + '">' + meta.label + '</span>' +
        '<span class="sec-progress">' + studiedCount + '/' + days.length + ' read</span>' +
        '<button class="add-topic-btn" onclick="App.showAddTopicModal(\'' + sec + '\')">+ Add Topic</button>' +
      '</div>' +
      '<div class="days-grid">' + days.map(day => renderDayCard(day)).join('') + '</div>';
    });

    el.innerHTML = html || '<div class="no-due">No topics in this section.</div>';
  }

  function renderDayCard(day) {
    const st       = ensureDayState(day.id);
    const hasDue   = isDayActionable(day.id);
    const sched    = getEffectiveSchedule();
    const allDone  = st.studyDate && sched.every(r => st.revisions[r.key]);
    const isBacklog = !st.studyDate && day.planDay && day.planDay <= getPlanDay();

    let cardClass = 'day-card';
    if (hasDue)        cardClass += ' has-due';
    else if (allDone)  cardClass += ' all-complete';
    else if (!st.studyDate) cardClass += ' not-started';

    return '<div class="' + cardClass + '" id="dc-' + day.id + '">' +
      '<div class="dc-header" onclick="App.toggleCard(\'' + day.id + '\')">' +
        '<div class="dc-day-num">' + formatDayId(day.id) + '</div>' +
        '<div class="dc-topic-wrap">' +
          '<div class="dc-topic" onclick="event.stopPropagation();App.openTopicDetail(\'' + day.id + '\')">' + day.topic + '</div>' +
          '<div class="dc-status-row">' +
            (hasDue        ? '<span class="pill pill-due">DUE</span>' : '') +
            (isBacklog     ? '<span class="pill pill-due">BACKLOG</span>' : '') +
            (st.studyDate  ? '<span class="pill pill-read">READ</span>' : '<span class="pill pill-ns">NOT STARTED</span>') +
            (allDone       ? '<span class="pill pill-done">✓ COMPLETE</span>' : '') +
          '</div>' +
        '</div>' +
        '<span class="chevron">▸</span>' +
      '</div>' +
      '<div class="dc-body" id="dcb-' + day.id + '">' +
        buildTimeline(day.id, st) +
        (st.extraTopics && st.extraTopics.length > 0 ?
          '<div class="extra-topics-list">' +
            '<div class="et-header">Sub-topics</div>' +
            st.extraTopics.map(et =>
              '<div class="extra-topic-row">' +
                '<span class="et-topic">' + et.topic + '</span>' +
                '<button class="et-remove" onclick="App.confirmRemoveExtra(\'' + day.id + '\',\'' + et.id + '\')">✕</button>' +
              '</div>'
            ).join('') +
          '</div>'
        : '') +
        '<div class="dc-footer-btns">' +
          '<button class="dc-footer-btn" onclick="App.showAddExtraTopicModal(\'' + day.id + '\')">+ Sub-topic</button>' +
          '<button class="dc-footer-btn danger" onclick="App.confirmHideDay(\'' + day.id + '\')">🗑 Delete Topic</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // ── TIMELINE ──────────────────────────────────────────────────────────────
  function buildTimeline(dayId, st) {
    const sched    = getEffectiveSchedule();
    let html       = '<div class="timeline">';
    const studyDone = !!st.studyDate;

    html += '<div class="tl-node ' + (studyDone ? 'tl-done' : 'tl-pending') + '" onclick="App.handleStudyCheck(\'' + dayId + '\',event)">' +
      '<div class="tl-dot ' + (studyDone ? 'dot-done' : 'dot-empty') + '">' + (studyDone ? '✓' : '·') + '</div>' +
      '<div class="tl-content">' +
        '<div class="tl-label">Initial Read</div>' +
        '<div class="tl-date ' + (studyDone ? 'date-done' : 'date-none') + '">' + (studyDone ? fmtDisplay(st.studyDate) : 'Tap to mark') + '</div>' +
      '</div>' +
    '</div>';

    sched.forEach((r, idx) => {
      const status  = getRevStatus(dayId, r.key, st);
      const done    = !!st.revisions[r.key];
      const isPreview   = status === 'upcoming-preview';
      const isLocked    = status === 'locked';
      const isOverdue   = status === 'overdue';
      const isDueToday  = status === 'due-today';

      let displayTarget = null;
      if (done) {
        displayTarget = st.revisions[r.key];
      } else if (!isLocked) {
        if (isPreview) {
          const prevTarget = getRevTarget(dayId, sched[idx-1].key, st);
          if (prevTarget) {
            const gap = r.gap !== undefined ? r.gap : (r.days || 1);
            displayTarget = addDays(prevTarget, gap);
          }
        } else {
          displayTarget = getRevTarget(dayId, r.key, st);
        }
      }

      let dotClass = 'dot-empty';
      if (done)                           dotClass = 'dot-done';
      else if (isOverdue || isDueToday)   dotClass = 'dot-due';
      else if (isLocked || isPreview)     dotClass = 'dot-locked';

      let nodeClass = 'tl-node';
      if (done)                           nodeClass += ' tl-done';
      else if (isOverdue || isDueToday)   nodeClass += ' tl-due-node';
      else if (isLocked)                  nodeClass += ' tl-locked';
      else if (isPreview)                 nodeClass += ' tl-preview';

      const prevDone  = idx === 0 ? studyDone : !!st.revisions[sched[idx-1].key];
      const lineClass = prevDone ? 'tl-line line-done' : 'tl-line line-pending';

      const clickAttr = (!isLocked) ? ('onclick="App.handleChipClick(\'' + dayId + '\',\'' + r.key + '\',event)"') : '';

      const dateClass = done ? 'date-done' : (isLocked || isPreview) ? 'date-none' : (isOverdue || isDueToday) ? 'date-due' : 'date-future';
      const dateText = done
        ? fmtDisplay(st.revisions[r.key])
        : (displayTarget ? fmtDisplay(displayTarget) + (isPreview ? ' <span class="preview-tag">preview</span>' : '') : 'Locked');

      html += '<div class="' + lineClass + '"></div>';
      html += '<div class="' + nodeClass + '" ' + clickAttr + '>' +
        '<div class="' + dotClass + ' tl-dot">' + (done ? '✓' : (isLocked || isPreview) ? '🔒' : (isOverdue || isDueToday) ? '!' : '·') + '</div>' +
        '<div class="tl-content">' +
          '<div class="tl-label">' + r.label + ' <span class="tl-desc">' + (r.desc || '') + '</span></div>' +
          '<div class="tl-date ' + dateClass + '">' + dateText +
            ((isOverdue || isDueToday) && !done ? ' <span class="due-badge">Due</span>' : '') +
          '</div>' +
        '</div>' +
        (!done && !isLocked && !isPreview && st.studyDate ?
          '<button class="tl-snooze" onclick="event.stopPropagation();App.scheduleNextDay(\'' + dayId + '\',\'' + r.key + '\')" title="+1 day">→</button>'
        : '') +
      '</div>';
    });

    html += '</div>';
    return html;
  }

  // ── TOPIC DETAIL MODAL ────────────────────────────────────────────────────
  function openTopicDetail(dayId) {
    const day = DAYS_DATA.find(d => String(d.id) === String(dayId));
    if (!day) return;
    const st        = ensureDayState(day.id);
    const sched     = getEffectiveSchedule();
    const meta      = SECTIONS_META[day.sec] || { label: 'General', color: '#888' };
    const studyDone = !!st.studyDate;

    const revCards = sched.map(r => {
      const status    = getRevStatus(dayId, r.key, st);
      const done      = !!st.revisions[r.key];
      const isPreview = status === 'upcoming-preview';
      const isLocked  = status === 'locked';

      let displayTarget = null;
      if (done) {
        displayTarget = st.revisions[r.key];
      } else if (!isLocked) {
        if (isPreview) {
          const rIndex = sched.findIndex(x => x.key === r.key);
          const prevTarget = getRevTarget(dayId, sched[rIndex-1].key, st);
          if (prevTarget) { const gap = r.gap || r.days || 1; displayTarget = addDays(prevTarget, gap); }
        } else {
          displayTarget = getRevTarget(dayId, r.key, st);
        }
      }

      let cardClass  = 'td-rev-card';
      let statusText = '—';
      if (done)                          { cardClass += ' done';      statusText = '✓ Done'; }
      else if (status === 'due-today')   { cardClass += ' due-today'; statusText = '● Due Today'; }
      else if (status === 'overdue')     { cardClass += ' overdue';   statusText = '! Overdue'; }
      else if (isPreview)                { statusText = 'Preview'; }
      else if (isLocked)                 { statusText = '🔒 Locked'; }
      else if (status === 'upcoming')    { statusText = displayTarget ? fmtDisplay(displayTarget) : '—'; }

      const dateText = done ? fmtDisplay(st.revisions[r.key]) : (displayTarget ? fmtDisplay(displayTarget) : '—');
      const canClick = !isLocked && !isPreview;
      const statusColor = done ? '#1E5C38' : status === 'overdue' ? '#B91C1C' : status === 'due-today' ? '#B07A00' : isPreview ? '#999' : '#aaa';

      return '<div class="' + cardClass + (canClick ? '' : ' td-rev-no-click') + '"' +
        (canClick ? ' onclick="App.handleChipFromDetail(\'' + dayId + '\',\'' + r.key + '\')"' : '') + '>' +
        '<div class="td-rev-label">' + r.label + '</div>' +
        '<div class="td-rev-date">' + dateText + '</div>' +
        '<div class="td-rev-status" style="color:' + statusColor + '">' + statusText + '</div>' +
      '</div>';
    }).join('');

    const isBacklog = !studyDone && day.planDay && day.planDay <= getPlanDay();
    const hasDue    = isDayActionable(day.id);

    const mc = document.getElementById('modal-content');
    mc.innerHTML =
      '<div class="topic-detail-header">' +
        '<div>' +
          '<div class="td-day-badge">' + formatDayId(day.id) + '</div>' +
          '<div class="td-section-tag" style="background:' + meta.color + '22;color:' + meta.color + ';border:1px solid ' + meta.color + '44">' + meta.label + '</div>' +
        '</div>' +
        '<div style="flex:1">' +
          '<div class="td-topic-name">' + day.topic + '</div>' +
          (day.planDay ? '<div style="font-size:11px;color:#999;margin-top:4px;font-family:var(--mono)">Plan Day ' + day.planDay + ' · ' + fmtDisplay(getPlanDateForDay(day.planDay)) + '</div>' : '') +
          '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
            (isBacklog && !studyDone ? '<span class="pill pill-due">BACKLOG</span>' : '') +
            (hasDue ? '<span class="pill pill-due">REVISION DUE</span>' : '') +
            (studyDone
              ? '<span class="pill pill-read">Read: ' + fmtDisplay(st.studyDate) + '</span>'
              : '<span class="pill pill-ns">NOT STARTED</span>') +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">Revision Schedule</div>' +
      '<div class="td-revisions-grid">' + revCards + '</div>' +

      (st.extraTopics && st.extraTopics.length > 0 ?
        '<div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:14px 0 8px">Sub-topics</div>' +
        st.extraTopics.map(et => '<div style="font-size:13px;color:#333;padding:6px 0;border-bottom:1px solid #eee">' + et.topic + '</div>').join('')
      : '') +

      '<div class="td-actions" style="margin-top:18px">' +
        (!studyDone
          ? '<button class="btn-primary" onclick="App.replaceModalWith_DateModal(\'' + day.id + '\',\'study\')">Mark as Read</button>'
          : '<button class="btn-secondary" onclick="App.closeModal();App.promptUnmarkStudy(\'' + day.id + '\')">Unmark Read</button>') +
        '<button class="btn-secondary" onclick="App.closeModal()">Close</button>' +
      '</div>';

    document.getElementById('modal-overlay').classList.add('open');
  }

  // ── STATS VIEW ────────────────────────────────────────────────────────────
  function renderStatsView() {
    const el = document.getElementById('viewStats');
    if (!el) return;

    const sched        = getEffectiveSchedule();
    const studied      = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
    const totalRevDone = DAYS_DATA.reduce((acc,d) => acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
    const dueCount     = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
    const streak       = calcStreak();
    const planDay      = getPlanDay();
    const totalDays    = DAYS_DATA.length;

    const secProgress = Object.entries(SECTIONS_META).map(function(entry) {
      const sec = entry[0], meta = entry[1];
      const days = DAYS_DATA.filter(d => d.sec === sec);
      const done = days.filter(d => ensureDayState(d.id).studyDate).length;
      const pct  = days.length > 0 ? Math.round((done/days.length)*100) : 0;
      return { sec: sec, meta: meta, done: done, total: days.length, pct: pct };
    });

    const revProgress = sched.map(r => {
      const eligible = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
      const done     = DAYS_DATA.filter(d => ensureDayState(d.id).revisions[r.key]).length;
      const pct      = eligible > 0 ? Math.round((done/eligible)*100) : 0;
      return Object.assign({}, r, { done: done, eligible: eligible, pct: pct });
    });

    const heatmapData = buildHeatmap();

    el.innerHTML =
      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-card-num">' + studied + '</div><div class="stat-card-label">Days Studied</div></div>' +
        '<div class="stat-card"><div class="stat-card-num">' + totalRevDone + '</div><div class="stat-card-label">Revisions Done</div></div>' +
        '<div class="stat-card"><div class="stat-card-num">' + streak + '</div><div class="stat-card-label">Streak 🔥</div></div>' +
        '<div class="stat-card"><div class="stat-card-num">' + dueCount + '</div><div class="stat-card-label">Due Today</div></div>' +
        '<div class="stat-card"><div class="stat-card-num">' + Math.round((studied/totalDays)*100) + '%</div><div class="stat-card-label">Coverage</div></div>' +
        '<div class="stat-card"><div class="stat-card-num">' + planDay + '</div><div class="stat-card-label">Plan Day</div></div>' +
      '</div>' +

      '<div class="progress-section"><h3>Section Progress</h3>' +
        secProgress.map(s =>
          '<div class="prog-row">' +
            '<div class="prog-label">' + s.meta.label + '</div>' +
            '<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:' + s.pct + '%;background:' + s.meta.color + '"></div></div>' +
            '<div class="prog-pct">' + s.done + '/' + s.total + '</div>' +
          '</div>'
        ).join('') +
      '</div>' +

      '<div class="progress-section"><h3>Revision Completion</h3>' +
        revProgress.map(r =>
          '<div class="prog-row">' +
            '<div class="prog-label">' + r.label + ' — ' + (r.desc || '') + '</div>' +
            '<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:' + r.pct + '%;background:var(--burgundy)"></div></div>' +
            '<div class="prog-pct">' + r.done + '/' + r.eligible + '</div>' +
          '</div>'
        ).join('') +
      '</div>' +

      '<div class="heatmap-wrap">' +
        '<h3>Activity — Last 90 Days</h3>' +
        '<p class="hm-sub">Each cell = one day · darker = more activity</p>' +
        '<div class="heatmap-grid">' +
          heatmapData.map(cell => '<div class="hmap-cell hm-' + cell.level + '" title="' + cell.date + ': ' + cell.count + ' activities"></div>').join('') +
        '</div>' +
      '</div>';
  }

  function buildHeatmap() {
    const sched  = getEffectiveSchedule();
    const result = [];
    for (let i = 89; i >= 0; i--) {
      const d   = new Date(TODAY); d.setDate(d.getDate() - i);
      const iso = fmtISO(d);
      let count = 0;
      DAYS_DATA.forEach(day => {
        const st = STATE[String(day.id)] || {};
        if (st.studyDate === iso) count++;
        sched.forEach(r => { if ((st.revisions||{})[r.key] === iso) count++; });
      });
      const level = count===0?0:count<=1?1:count<=3?2:count<=5?3:4;
      result.push({ date: iso, count: count, level: level });
    }
    return result;
  }

  // ── BACKLOG VIEW ──────────────────────────────────────────────────────────
  function renderBacklogView() {
    const el = document.getElementById('viewBacklog');
    if (!el) return;
    const { overdueTopics, pendingRevisions, phaseProgress } = getBacklogData();
    const activePhases = getActivePhases().map(normalizePhase);

    // Group overdue read topics by phase
    const byPhase = {};
    overdueTopics.forEach(item => {
      const topic = item.day;
      const phase = activePhases.find(p => p.sections && p.sections.includes(topic.sec))
                 || { label: 'Unassigned', color: '#888', id: 'other' };
      if (!byPhase[phase.id]) byPhase[phase.id] = { phase: phase, items: [] };
      byPhase[phase.id].items.push(item);
    });

    const alertHtml = phaseProgress && phaseProgress.behind > 0 ?
      '<div class="backlog-alert">' +
        '<div class="ba-icon">⚠</div>' +
        '<div class="ba-text">' +
          '<strong>' + phaseProgress.behind + ' topic' + (phaseProgress.behind > 1 ? 's' : '') + ' behind schedule</strong> in ' + phaseProgress.phase.label + '.<br>' +
          'Read: ' + phaseProgress.studiedCount + ' of ' + phaseProgress.total + ' · ' +
          'Expected by now: ' + phaseProgress.expectedByNow + ' · ' +
          'Pace needed: <strong>' + phaseProgress.topicsPerDay + '/day</strong>' +
        '</div>' +
      '</div>'
    : phaseProgress ?
      '<div class="backlog-ok">✓ On track — ' + phaseProgress.studiedCount + '/' + phaseProgress.total + ' topics done in ' + phaseProgress.phase.label + '</div>'
    : '';

    const readBacklogHtml = overdueTopics.length > 0 ?
      '<div class="section-title" style="margin-bottom:12px">📚 Overdue Initial Reads <span class="count-chip red">' + overdueTopics.length + '</span></div>' +
      Object.values(byPhase).map(function(entry) {
        const phase = entry.phase, items = entry.items;
        return '<div class="phase-backlog-section" style="border-left-color:' + phase.color + '">' +
          '<div class="pbl-header" style="background:' + phase.color + '15;color:' + phase.color + ';border-bottom-color:' + phase.color + '33">' +
            phase.label + ' · ' + items.length + ' overdue reads' +
          '</div>' +
          '<div class="bl-list">' +
            items.map(function(item) {
              const d = item.day;
              return '<div class="bl-item">' +
                '<div class="bl-id">' + formatDayId(d.id) + '</div>' +
                '<div class="bl-topic" onclick="App.openTopicDetail(\'' + d.id + '\')">' + d.topic + '</div>' +
                '<span style="font-size:10px;color:var(--red);font-weight:700;white-space:nowrap">' + item.daysLate + 'd late</span>' +
                '<button class="bl-mark" onclick="App.showDateModal(\'' + d.id + '\',\'study\')">Mark Read</button>' +
                '<button class="bl-delete" onclick="App.confirmHideDay(\'' + d.id + '\')" title="Delete topic">🗑</button>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</div>';
      }).join('')
    : '<div class="backlog-ok" style="margin-bottom:16px">✓ All scheduled reads are on time!</div>';

    const revBacklogHtml = pendingRevisions.length > 0 ?
      '<div class="section-title" style="margin-bottom:12px;margin-top:20px">🔁 Overdue Revisions <span class="count-chip red">' + pendingRevisions.length + '</span></div>' +
      '<div class="backlog-section"><div class="bl-list">' +
        pendingRevisions.map(function(item) {
          const day = item.day;
          const st  = ensureDayState(day.id);
          const sched = getEffectiveSchedule();
          const nextOD = sched.find(r => getRevStatus(day.id, r.key, st) === 'overdue');
          return '<div class="bl-item bl-overdue">' +
            '<div class="bl-id">' + formatDayId(day.id) + '</div>' +
            '<div class="bl-topic" onclick="App.openTopicDetail(\'' + day.id + '\')">' + day.topic + '</div>' +
            '<span style="font-size:10px;color:var(--red);font-weight:700">' + item.overdueRevs + ' rev overdue</span>' +
            (nextOD ? '<button class="bl-mark" onclick="App.showDateModal(\'' + day.id + '\',\'' + nextOD.key + '\')">Mark ' + nextOD.key.toUpperCase() + '</button>' : '') +
          '</div>';
        }).join('') +
      '</div></div>'
    : '';

    el.innerHTML = alertHtml + readBacklogHtml + revBacklogHtml +
      (overdueTopics.length === 0 && pendingRevisions.length === 0
        ? '<div class="no-due">✓ No backlog — you\'re fully on track!</div>'
        : '');
  }

  // ── SETTINGS VIEW ─────────────────────────────────────────────────────────
  function renderSettingsView() {
    const el     = document.getElementById('viewSettings');
    if (!el) return;
    const sched  = getEffectiveSchedule();
    const phases = getActivePhases();

    el.innerHTML =
      '<div class="settings-section">' +
        '<h3>Study Plan</h3>' +
        '<div class="settings-row"><span>Plan Start</span><strong>' + fmtDisplay(STUDY_PLAN.startDate) + '</strong></div>' +
        '<div class="settings-row"><span>Exam Date</span><strong>' + fmtDisplay(STUDY_PLAN.examDate) + '</strong></div>' +
        '<div class="settings-row"><span>Today is Plan Day</span><strong>' + getPlanDay() + '</strong></div>' +
        '<div class="settings-row"><span>Days to Exam</span><strong>' + getDaysToExam() + '</strong></div>' +
        '<div class="phase-list">' +
          phases.map(normalizePhase).map(p =>
            '<div class="phase-card" style="border-left-color:' + p.color + '">' +
              '<strong style="color:' + p.color + '">' + p.label + '</strong> · Days ' + p.days[0] + '–' + p.days[1] +
              '<div class="phase-desc">' + (p.desc || '') + '</div>' +
            '</div>'
          ).join('') +
        '</div>' +
      '</div>' +

      '<div class="settings-section">' +
        '<h3>Spaced Repetition Rules</h3>' +
        '<p class="settings-hint">Each revision is scheduled relative to the <em>previous step\'s actual completion date</em> (chained, dynamic).</p>' +
        '<div id="sched-editor">' +
          sched.map(r =>
            '<div class="sched-row">' +
              '<span class="sr-key">' + r.label + '</span>' +
              '<span class="sr-relto">Prev Step +</span>' +
              '<input class="sr-input" type="number" id="sr-' + r.key + '" value="' + (r.gap !== undefined ? r.gap : (r.days || 1)) + '" min="1" max="365" />' +
              '<span class="sr-unit">days</span>' +
            '</div>'
          ).join('') +
        '</div>' +
        '<button class="settings-save-btn" onclick="App.saveSchedule()">Save Rules</button>' +
        '<button class="settings-reset-btn" onclick="App.resetSchedule()">Reset to Default</button>' +
      '</div>' +

      '<div class="settings-section">' +
        '<h3>Data Management</h3>' +
        '<div class="settings-btns">' +
          '<button class="settings-action-btn" onclick="App.exportData()">⬇ Export JSON</button>' +
          '<label class="settings-action-btn import-lbl">⬆ Import JSON<input type="file" accept=".json" onchange="App.importData(event)" style="display:none"/></label>' +
          '<button class="settings-action-btn danger" onclick="App.confirmResetAll()">⚠ Reset All Data</button>' +
        '</div>' +
      '</div>' +

      '<div class="settings-section">' +
        '<h3>Undo / Redo</h3>' +
        '<div class="settings-btns">' +
          '<button class="ur-btn" id="undoBtn2" onclick="App.undo()">↩ Undo</button>' +
          '<button class="ur-btn" id="redoBtn2" onclick="App.redo()">↪ Redo</button>' +
        '</div>' +
        '<p class="settings-hint">Up to 50 undo steps per session.</p>' +
      '</div>';
  }

  function saveSchedule() {
    const sched = getEffectiveSchedule().map(r => Object.assign({}, r));
    let valid = true;
    sched.forEach(r => {
      const inp = document.getElementById('sr-' + r.key);
      if (inp) {
        const v = parseInt(inp.value);
        if (isNaN(v) || v < 1) { valid = false; return; }
        r.gap  = v;
        r.days = v;
        r.desc = '+' + v + 'd';
      }
    });
    if (!valid) { toast('⚠ Invalid values'); return; }
    snapshot();
    CONFIG.revSchedule = sched;
    saveToDB(); renderAll(); toast('✓ Saved');
  }

  function resetSchedule() {
    snapshot();
    CONFIG.revSchedule = REV_SCHEDULE.map(r => Object.assign({}, r));
    CONFIG.phases      = STUDY_PLAN.phases.map(p => Object.assign({}, p));
    saveToDB(); renderSettingsView(); toast('Reset to default');
  }

  function confirmResetAll() {
    showModal({
      title: 'Reset All Data?',
      sub: 'Permanently deletes all study dates, revisions and extra topics.',
      confirm: 'Reset Everything', danger: true,
      onConfirm: function() {
        STATE   = buildFreshState();
        HISTORY = []; FUTURE = []; DELETED_IDS = [];
        const toRemove = DAYS_DATA.filter(d => d.custom).map(d => d.id);
        toRemove.forEach(id => { const idx = DAYS_DATA.findIndex(d => d.id === id); if (idx > -1) DAYS_DATA.splice(idx,1); });
        saveToDB(); renderAll(); closeModal(); toast('Data reset');
      }
    });
  }

  // ── INTERACTION HANDLERS ──────────────────────────────────────────────────
  function toggleCard(dayId) {
    const el = document.getElementById('dc-' + dayId);
    if (el) el.classList.toggle('open');
  }

  function handleStudyCheck(dayId, e) {
    if (e) e.stopPropagation();
    const st = ensureDayState(dayId);
    if (st.studyDate) {
      showModal({
        title: 'Remove study date?',
        sub: 'This will also clear all revisions for this topic.',
        confirm: 'Remove', danger: true,
        onConfirm: function() { unmarkStudied(dayId); closeModal(); }
      });
    } else {
      showDateModal(dayId, 'study');
    }
  }

  function handleChipClick(dayId, revKey, e) {
    if (e) e.stopPropagation();
    const st     = ensureDayState(dayId);
    const status = getRevStatus(dayId, revKey, st);

    if (!st.studyDate)                   { toast('Mark initial study first'); return; }
    if (status === 'locked')             { toast('⚠ Complete previous revision first'); return; }
    if (status === 'upcoming-preview')   { toast('Complete the current revision first'); return; }

    if (st.revisions[revKey]) {
      showModal({
        title: 'Remove ' + revKey.toUpperCase() + '?',
        sub: 'This will also clear all subsequent revisions (they depend on this date).',
        confirm: 'Remove', danger: true,
        onConfirm: function() { unmarkRevision(dayId, revKey); closeModal(); }
      });
    } else {
      showDateModal(dayId, revKey);
    }
  }

  function handleChipFromDetail(dayId, revKey) {
    const st     = ensureDayState(dayId);
    const status = getRevStatus(dayId, revKey, st);

    if (!st.studyDate)                   { toast('Mark initial study first'); return; }
    if (status === 'locked')             { toast('⚠ Complete previous revision first'); return; }
    if (status === 'upcoming-preview')   { toast('Complete the current revision first'); return; }

    if (st.revisions[revKey]) {
      showModal({
        title: 'Remove ' + revKey.toUpperCase() + '?',
        sub: 'This will also clear all subsequent revisions.',
        confirm: 'Remove', danger: true,
        onConfirm: function() {
          unmarkRevision(dayId, revKey);
          closeModal();
          setTimeout(function() { openTopicDetail(dayId); }, 50);
        }
      });
    } else {
      replaceModalWith_DateModal(dayId, revKey);
    }
  }

  function handleRevCheck(dayId, revKey, e) {
    if (e) e.stopPropagation();
    handleChipClick(dayId, revKey, null);
  }

  function promptUnmarkStudy(dayId) {
    showModal({
      title: 'Remove study date?',
      sub: 'This will also clear all revisions.',
      confirm: 'Remove', danger: true,
      onConfirm: function() { unmarkStudied(dayId); closeModal(); }
    });
  }

  // ── MODAL SYSTEM ──────────────────────────────────────────────────────────
  function showModal(opts) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML =
      '<div class="modal-title">' + opts.title + '</div>' +
      '<div class="modal-sub">' + opts.sub + '</div>' +
      '<div class="modal-btn-row">' +
        '<button class="btn-secondary" onclick="App.closeModal()">Cancel</button>' +
        '<button class="btn-primary' + (opts.danger ? ' btn-danger' : '') + '" id="modal-confirm-btn">' + opts.confirm + '</button>' +
      '</div>';
    document.getElementById('modal-confirm-btn').onclick = opts.onConfirm;
    document.getElementById('modal-overlay').classList.add('open');
  }

  function showDateModal(dayId, type) {
    const day   = DAYS_DATA.find(d => String(d.id) === String(dayId));
    const label = type === 'study' ? 'Initial Study' : type.toUpperCase() + ' Revision';
    const mc    = document.getElementById('modal-content');
    mc.innerHTML =
      '<div class="modal-title">Mark ' + label + '</div>' +
      '<div class="modal-sub">' + formatDayId(dayId) + ' — ' + (day ? day.topic : '') + '</div>' +
      '<div class="date-input-group">' +
        '<label>Date Completed</label>' +
        '<input type="date" id="datePickerInput" value="' + todayISO() + '" max="' + todayISO() + '" />' +
      '</div>' +
      '<div class="modal-btn-row">' +
        '<button class="btn-secondary" onclick="App.closeModal()">Cancel</button>' +
        '<button class="btn-primary" onclick="App.confirmDateModal(\'' + dayId + '\',\'' + type + '\')">Mark Done</button>' +
      '</div>';
    document.getElementById('modal-overlay').classList.add('open');
  }

  function replaceModalWith_DateModal(dayId, type) {
    showDateModal(dayId, type);
  }

  function confirmDateModal(dayId, type) {
    const input   = document.getElementById('datePickerInput');
    const dateISO = input ? input.value : '';
    if (!dateISO) { toast('Please select a date'); return; }
    if (type === 'study') markStudied(dayId, dateISO);
    else markRevision(dayId, type, dateISO);
    closeModal();
    setTimeout(function() {
      const card = document.getElementById('dc-' + dayId);
      if (card && !card.classList.contains('open')) card.classList.add('open');
    }, 100);
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('open');
  }

  // ── ADD TOPIC / EXTRA ─────────────────────────────────────────────────────
  function showAddTopicModal(sec) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML =
      '<div class="modal-title">Add Topic to ' + SECTIONS_META[sec].label + '</div>' +
      '<div class="modal-sub">Will be numbered sequentially in this section</div>' +
      '<div class="date-input-group">' +
        '<label>Topic Name</label>' +
        '<input type="text" id="newTopicInput" placeholder="Enter topic name..." style="padding:10px 14px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:14px;width:100%;background:var(--surface2);color:var(--text);outline:none" />' +
      '</div>' +
      '<div class="modal-btn-row">' +
        '<button class="btn-secondary" onclick="App.closeModal()">Cancel</button>' +
        '<button class="btn-primary" onclick="App.confirmAddTopic(\'' + sec + '\')">Add Topic</button>' +
      '</div>';
    document.getElementById('modal-overlay').classList.add('open');
    setTimeout(function() { const i = document.getElementById('newTopicInput'); if(i) i.focus(); }, 100);
  }

  function confirmAddTopic(sec) {
    const input = document.getElementById('newTopicInput');
    const topic = input ? input.value.trim() : '';
    if (!topic) { toast('Please enter a topic name'); return; }
    snapshot();

    SECTION_ID_COUNTERS[sec] = (SECTION_ID_COUNTERS[sec] || 0) + 1;
    const seqNum   = SECTION_ID_COUNTERS[sec];
    const customId = 'c_' + sec + '_' + seqNum;
    DAYS_DATA.push({ id: customId, sec: sec, topic: topic, custom: true, seqNum: seqNum, planDay: null });
    STATE[customId] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
    saveToDB(); closeModal(); renderAll();
    toast('Topic added as #' + seqNum);
  }

  function showAddExtraTopicModal(dayId) {
    const mc = document.getElementById('modal-content');
    mc.innerHTML =
      '<div class="modal-title">Add Sub-topic</div>' +
      '<div class="modal-sub">Supplementary topic for ' + formatDayId(dayId) + '</div>' +
      '<div class="date-input-group">' +
        '<label>Sub-topic Name</label>' +
        '<input type="text" id="extraTopicInput" placeholder="e.g. PYQs, Extra Notes..." style="padding:10px 14px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:14px;width:100%;background:var(--surface2);color:var(--text);outline:none" />' +
      '</div>' +
      '<div class="modal-btn-row">' +
        '<button class="btn-secondary" onclick="App.closeModal()">Cancel</button>' +
        '<button class="btn-primary" onclick="App.confirmAddExtra(\'' + dayId + '\')">Add</button>' +
      '</div>';
    document.getElementById('modal-overlay').classList.add('open');
    setTimeout(function() { const i = document.getElementById('extraTopicInput'); if(i) i.focus(); }, 100);
  }

  function confirmAddExtra(dayId) {
    const input = document.getElementById('extraTopicInput');
    const topic = input ? input.value.trim() : '';
    if (!topic) { toast('Enter a sub-topic name'); return; }
    snapshot();
    ensureDayState(dayId).extraTopics.push({ id: 'et_' + Date.now(), topic: topic });
    saveToDB(); closeModal(); renderAll(); toast('Sub-topic added');
  }

  function confirmRemoveExtra(dayId, topicId) {
    showModal({
      title: 'Remove Sub-topic?', sub: 'This sub-topic will be deleted.',
      confirm: 'Remove', danger: true,
      onConfirm: function() {
        snapshot();
        const st = ensureDayState(dayId);
        st.extraTopics = st.extraTopics.filter(t => t.id !== topicId);
        saveToDB(); closeModal(); renderAll(); toast('Removed');
      }
    });
  }

  function confirmHideDay(dayId) {
    const day = DAYS_DATA.find(d => String(d.id) === String(dayId));
    const topicName = day ? day.topic : dayId;
    showModal({
      title: 'Delete this topic?',
      sub: '"' + topicName + '" will be permanently deleted. Plan day numbers will be reassigned automatically.',
      confirm: 'Delete', danger: true,
      onConfirm: function() {
        snapshot();
        const idx = DAYS_DATA.findIndex(d => String(d.id) === String(dayId));
        if (idx > -1) DAYS_DATA.splice(idx, 1);
        delete STATE[String(dayId)];
        // Track deleted ID so it does not reappear on next reload
        if (!DELETED_IDS.includes(String(dayId))) DELETED_IDS.push(String(dayId));

        // Reassign planDay numbers sequentially — no gaps
        // Group by section order, then renumber by existing order within each sec
        // Actually: renumber ALL topics that have planDay by their current sorted order
        const withPlanDay = DAYS_DATA.filter(d => d.planDay != null).sort((a, b) => a.planDay - b.planDay);
        withPlanDay.forEach((d, i) => { d.planDay = i + 1; });

        saveToDB(); closeModal(); renderAll(); toast('✓ Topic deleted & days renumbered');
      }
    });
  }

  // ── EXPORT / IMPORT ───────────────────────────────────────────────────────
  function exportData() {
    const payload = {
      version: 3,
      state: STATE, config: CONFIG,
      customTopics: DAYS_DATA.filter(d => d.custom),
      idCounters: typeof SECTION_ID_COUNTERS !== 'undefined' ? SECTION_ID_COUNTERS : {},
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'bpsc_tracker_' + todayISO() + '.json'; a.click();
    URL.revokeObjectURL(url);
    toast('⬇ Exported');
  }

  function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const parsed        = JSON.parse(ev.target.result);
        const importedState = parsed.state || parsed;
        if (typeof importedState !== 'object') throw new Error('Invalid');
        snapshot();
        DAYS_DATA.forEach(d => {
          if (importedState[String(d.id)]) STATE[String(d.id)] = importedState[String(d.id)];
        });
        if (parsed.customTopics) {
          parsed.customTopics.forEach(ct => {
            if (!DAYS_DATA.find(d => String(d.id) === String(ct.id))) {
              DAYS_DATA.push(ct);
              if (importedState[String(ct.id)]) STATE[String(ct.id)] = importedState[String(ct.id)];
            }
          });
        }
        if (parsed.idCounters && typeof SECTION_ID_COUNTERS !== 'undefined') {
          Object.assign(SECTION_ID_COUNTERS, parsed.idCounters);
        }
        if (parsed.config) CONFIG = Object.assign({}, buildDefaultConfig(), parsed.config);
        saveToDB(); renderAll(); toast('⬆ Import successful');
      } catch(err) { toast('⚠ Invalid JSON file'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ── TOAST ─────────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { el.classList.remove('show'); }, 2200);
  }

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  return {
    init, setView, filterSection,
    toggleSidebar, toggleCard,
    handleStudyCheck, handleChipClick, handleRevCheck, promptUnmarkStudy,
    showDateModal, replaceModalWith_DateModal, confirmDateModal, closeModal,
    showAnalysisModal,
    showAddTopicModal, confirmAddTopic,
    showAddExtraTopicModal, confirmAddExtra,
    confirmRemoveExtra, confirmHideDay,
    scheduleNextDay,
    saveSchedule, resetSchedule, confirmResetAll,
    exportData, importData,
    undo, redo,
    openTopicDetail, handleChipFromDetail,
  };
})();

document.addEventListener('DOMContentLoaded', function() { App.init(); });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function() {});
}
