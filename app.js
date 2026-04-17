// ─── BPSC TRACKER v3 · app.js ────────────────────────────────────────────────
const App = (() => {
const DB_NAME = ‘bpsc_tracker_v3’;
const DB_VER  = 1;
const STORE   = ‘state’;
const KEY     = ‘main’;

let db       = null;
let STATE    = {};
let CONFIG   = buildDefaultConfig();
let HISTORY  = [];
let FUTURE   = [];
let currentView    = ‘today’;
let currentSection = ‘all’;
let TODAY = new Date(); TODAY.setHours(0,0,0,0);

// ── CONFIG ──────────────────────────────────────────────────────────────
function buildDefaultConfig() {
return {
revSchedule: typeof REV_SCHEDULE !== ‘undefined’ ? REV_SCHEDULE.map(r => ({ …r })) : [],
phases:      typeof STUDY_PLAN   !== ‘undefined’ && STUDY_PLAN.phases
? STUDY_PLAN.phases.map(p => ({ …p })) : []
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
const saved = await loadFromDB();

```
STATE  = (saved && saved.state)  ? saved.state  : buildFreshState();
CONFIG = (saved && saved.config) ? { ...buildDefaultConfig(), ...saved.config } : buildDefaultConfig();
// Normalize any phases loaded from old IndexedDB that used 'range' instead of 'days'
if (CONFIG.phases) CONFIG.phases = CONFIG.phases.map(p => { if (!p.days && p.range) p.days = p.range; if (!p.days) p.days = [1,90]; return p; });

// Restore custom topics
if (saved && saved.customTopics) {
  saved.customTopics.forEach(ct => {
    if (!DAYS_DATA.find(d => String(d.id) === String(ct.id))) DAYS_DATA.push(ct);
  });
}
// Restore ID counters
if (saved && saved.idCounters) Object.assign(SECTION_ID_COUNTERS, saved.idCounters);

renderAll();
updateUndoRedoBtns();

// Midnight refresh
setInterval(() => {
  const n = new Date(); n.setHours(0,0,0,0);
  if (n.getTime() !== TODAY.getTime()) { TODAY = n; renderAll(); }
}, 60000);
```

}

function buildFreshState() {
const s = {};
DAYS_DATA.forEach(d => {
s[d.id] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: ‘’ };
});
return s;
}

function initRevs() {
const r = {};
getEffectiveSchedule().forEach(rev => { r[rev.key] = null; });
return r;
}

function ensureDayState(dayId) {
if (!STATE[dayId]) {
STATE[dayId] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: ‘’ };
}
const st = STATE[dayId];
if (!st.extraTopics) st.extraTopics = [];
if (!st.notes)       st.notes = ‘’;
if (!st.revisions)   st.revisions = initRevs();
// Ensure all revision keys exist (in case schedule was customised)
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
const tx  = db.transaction(STORE, ‘readonly’);
const req = tx.objectStore(STORE).get(KEY);
req.onsuccess = () => res(req.result || null);
req.onerror   = () => res(null);
});
}

function saveToDB() {
if (!db) return;
const customTopics = DAYS_DATA.filter(d => d.custom);
const payload = deepClone({
state: STATE, config: CONFIG, customTopics,
idCounters: typeof SECTION_ID_COUNTERS !== ‘undefined’ ? SECTION_ID_COUNTERS : {},
});
const tx = db.transaction(STORE, ‘readwrite’);
tx.objectStore(STORE).put(payload, KEY);
try { localStorage.setItem(‘bpsc_v3_backup’, JSON.stringify(payload)); } catch(_){}
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
saveToDB(); renderAll(); updateUndoRedoBtns(); toast(‘↩ Undone’);
}

function redo() {
if (!FUTURE.length) return;
HISTORY.push(deepClone({ state: STATE, config: CONFIG }));
const s = FUTURE.pop();
STATE = s.state; CONFIG = s.config;
saveToDB(); renderAll(); updateUndoRedoBtns(); toast(‘↪ Redone’);
}

function updateUndoRedoBtns() {
[‘undoBtn’,‘undoBtn2’].forEach(id => {
const el = document.getElementById(id);
if (el) el.disabled = !HISTORY.length;
});
[‘redoBtn’,‘redoBtn2’].forEach(id => {
const el = document.getElementById(id);
if (el) el.disabled = !FUTURE.length;
});
}

// ── DATE HELPERS ──────────────────────────────────────────────────────────
function fmtISO(d) {
return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDisplay(iso) {
if (!iso) return ‘’;
const [y,m,d] = iso.split(’-’).map(Number);
const M = [‘Jan’,‘Feb’,‘Mar’,‘Apr’,‘May’,‘Jun’,‘Jul’,‘Aug’,‘Sep’,‘Oct’,‘Nov’,‘Dec’];
return `${d} ${M[m-1]} '${String(y).slice(2)}`;
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

// ── REVISION LOGIC (Chained, Dynamic, Locked) ─────────────────────────────
//
// CHAIN: Each revision’s target = previous step’s completion date + gap
//   R1 target = studyDate + r1.gap
//   R2 target = R1 completion date + r2.gap  (NOT studyDate + r1.gap + r2.gap)
//   R3 target = R2 completion date + r3.gap  … and so on
//
// VISIBILITY RULE (Option B):
//   - done         → always shown as done
//   - next undone  → shown as due-today / overdue / upcoming  (actionable)
//   - one after    → shown as upcoming (preview only, not actionable)
//   - rest         → locked
//
// So at most ONE future preview is ever shown per topic.
// ──────────────────────────────────────────────────────────────────────────

function getRevTarget(dayId, revKey, st) {
if (!st) st = ensureDayState(dayId);
if (!st.studyDate) return null;

```
const sched  = getEffectiveSchedule();
const rIndex = sched.findIndex(x => x.key === revKey);
if (rIndex === -1) return null;

// Base date: for R1 = studyDate; for R2+ = previous revision's completion date
let baseDate;
if (rIndex === 0) {
  baseDate = st.studyDate;
} else {
  const prevKey = sched[rIndex - 1].key;
  baseDate = st.revisions[prevKey]; // null if previous not done
}

if (!baseDate) return null; // strictly chained — cannot compute without previous

const gap = sched[rIndex].gap !== undefined ? sched[rIndex].gap : (sched[rIndex].days || 1);
return addDays(baseDate, gap);
```

}

function getRevStatus(dayId, revKey, st) {
if (!st) st = ensureDayState(dayId);

```
// Already done
if (st.revisions[revKey]) return 'done';

const sched  = getEffectiveSchedule();
const rIndex = sched.findIndex(x => x.key === revKey);

// ── VISIBILITY RULE B ──────────────────────────────────────────────────
// Find the index of the "next actionable" revision (first undone, unlocked)
// = first revision whose previous step is done (or is R1 with studyDate set)
let nextActionableIndex = -1;
for (let i = 0; i < sched.length; i++) {
  const isDone = !!st.revisions[sched[i].key];
  if (isDone) continue;
  // Check if this revision is unlocked
  if (i === 0) {
    if (st.studyDate) { nextActionableIndex = i; break; }
  } else {
    if (st.revisions[sched[i-1].key]) { nextActionableIndex = i; break; }
  }
  // If we reach a revision that is both undone and locked, stop
  break;
}

// If there's no study date at all, everything is locked
if (!st.studyDate) return 'locked';

// This revision is done (already handled above)
// Is this the next actionable revision?
if (rIndex === nextActionableIndex) {
  const target = getRevTarget(dayId, revKey, st);
  if (!target) return 'locked';
  if (isToday(target)) return 'due-today';
  if (isPast(target))  return 'overdue';
  return 'upcoming';
}

// Is this the preview (one beyond the actionable)?
if (rIndex === nextActionableIndex + 1) {
  // Show as upcoming if we can compute a target from the actionable one's
  // projected date (use target of the previous, not its completion)
  const prevTarget = getRevTarget(dayId, sched[rIndex - 1].key, st);
  if (!prevTarget) return 'locked';
  // We know the previous isn't done yet (it's the actionable one)
  // so we compute preview target using the projected completion (its target date)
  const previewBase = prevTarget;
  const gap = sched[rIndex].gap !== undefined ? sched[rIndex].gap : (sched[rIndex].days || 1);
  // We just check if a target is computable — status is always 'upcoming' for preview
  return 'upcoming-preview'; // distinct from actionable upcoming
}

// Everything else is locked
return 'locked';
```

}

function isDayActionable(dayId) {
const st   = ensureDayState(dayId);
const sched = getEffectiveSchedule();
return sched.some(r => {
const s = getRevStatus(dayId, r.key, st);
return s === ‘due-today’ || s === ‘overdue’;
});
}

// ── PLAN / PHASE HELPERS ──────────────────────────────────────────────────
function getPlanDay() {
const start = new Date(STUDY_PLAN.startDate);
return Math.max(1, Math.floor((TODAY - start) / 86400000) + 1);
}

function getPlanDateForDay(planDay) {
const start = new Date(STUDY_PLAN.startDate);
start.setDate(start.getDate() + planDay - 1);
return fmtISO(start);
}

// Normalize phase: support old ‘range’ key and new ‘days’ key
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

function getBacklogData() {
const planDay = getPlanDay();
const overdueTopics    = [];
const pendingRevisions = [];
const inProgress       = [];

```
DAYS_DATA.forEach(d => {
  if (ensureDayState(d.id).hidden) return;
  const st    = ensureDayState(d.id);
  const sched = getEffectiveSchedule();
  const revsDone = sched.filter(r => st.revisions[r.key]).length;

  if (!st.studyDate) {
    if (d.planDay && d.planDay <= planDay) overdueTopics.push(d);
  } else {
    const overdueRevs = sched.filter(r => getRevStatus(d.id, r.key, st) === 'overdue').length;
    if (overdueRevs > 0) pendingRevisions.push({ day: d, overdueRevs, revsDone });
    else if (revsDone < sched.length) inProgress.push({ day: d, revsDone });
  }
});

const phase = getCurrentPhase();
let phaseProgress = null;
if (phase) {
  normalizePhase(phase);
  const relevantDays    = DAYS_DATA.filter(d => d.planDay >= phase.days[0] && d.planDay <= phase.days[1]);
  const expectedCount   = relevantDays.filter(d => d.planDay <= planDay).length;
  const studiedCount    = relevantDays.filter(d => ensureDayState(d.id).studyDate).length;
  const behind          = Math.max(0, expectedCount - studiedCount);
  phaseProgress = { phase, expectedCount, studiedCount, behind, total: relevantDays.length };
}

return { overdueTopics, pendingRevisions, inProgress, phaseProgress };
```

}

// Streak: count consecutive days with any activity ending today
function calcStreak() {
let streak = 0;
const sched = getEffectiveSchedule();
const date  = new Date(TODAY);
while (true) {
const iso = fmtISO(date);
const hasActivity = DAYS_DATA.some(d => {
const st = STATE[d.id] || {};
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
// Desktop: toggle sidebar-closed (hides sidebar from layout)
// Mobile:  toggle sidebar-open  (slides sidebar overlay in/out)
if (window.innerWidth <= 700) {
document.body.classList.toggle(‘sidebar-open’);
} else {
document.body.classList.toggle(‘sidebar-closed’);
}
}

function markStudied(dayId, dateISO) {
snapshot();
ensureDayState(dayId).studyDate = dateISO;
saveToDB(); renderAll(); toast(‘✓ Marked as read’);
}

function unmarkStudied(dayId) {
snapshot();
const st     = ensureDayState(dayId);
st.studyDate = null;
// Use current effective schedule keys to clear — avoids orphan keys
st.revisions = initRevs();
saveToDB(); renderAll(); toast(‘Study date removed’);
}

function markRevision(dayId, revKey, dateISO) {
snapshot();
ensureDayState(dayId).revisions[revKey] = dateISO;
saveToDB(); renderAll(); toast(`✓ ${revKey.toUpperCase()} done`);
}

function unmarkRevision(dayId, revKey) {
snapshot();
// FIX: also clear all subsequent revisions (they depend on this one)
const sched  = getEffectiveSchedule();
const st     = ensureDayState(dayId);
const rIndex = sched.findIndex(x => x.key === revKey);
for (let i = rIndex; i < sched.length; i++) {
st.revisions[sched[i].key] = null;
}
saveToDB(); renderAll(); toast(`${revKey.toUpperCase()} removed`);
}

function scheduleNextDay(dayId, revKey) {
snapshot();
ensureDayState(dayId).revisions[revKey] = addDays(todayISO(), 1);
saveToDB(); renderAll(); toast(`${revKey.toUpperCase()} →+1d`);
}

// ── ROUTING ───────────────────────────────────────────────────────────────
function setView(v, btn) {
currentView = v;
document.querySelectorAll(’.nav-item’).forEach(b => b.classList.remove(‘active’));
if (btn) btn.classList.add(‘active’);
else { const nb = document.querySelector(`[data-view="${v}"]`); if (nb) nb.classList.add(‘active’); }
document.querySelectorAll(’.view’).forEach(el => el.classList.remove(‘active’));
const vEl = document.getElementById(‘view’ + v.charAt(0).toUpperCase() + v.slice(1));
if (vEl) vEl.classList.add(‘active’);
const titles = { today:‘Today’, all:‘All Days’, stats:‘Statistics’, settings:‘Settings’, backlog:‘Backlog’ };
document.getElementById(‘pageTitle’).textContent = titles[v] || v;
renderCurrentView();
updatePageSub();
}

function filterSection(sec, btn) {
currentSection = sec;
document.querySelectorAll(’.sec-item’).forEach(b => b.classList.remove(‘active’));
if (btn) btn.classList.add(‘active’);
if (currentView !== ‘all’) setView(‘all’, null);
else renderAllView();
}

function updatePageSub() {
const sub = document.getElementById(‘pageSub’);
if (!sub) return;
if (currentView === ‘today’) {
const due = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
sub.textContent = due > 0 ? `${due} revision${due>1?'s':''} need attention` : ‘All caught up!’;
} else if (currentView === ‘backlog’) {
const { overdueTopics } = getBacklogData();
sub.textContent = overdueTopics.length > 0 ? `${overdueTopics.length} overdue topics` : ‘Phase on track’;
} else {
sub.textContent = ‘’;
}
}

function renderAll() {
try { renderHeader(); } catch(e) { console.error(‘renderHeader:’, e); }
try { renderTodayView(); } catch(e) { console.error(‘renderTodayView:’, e); }
try {
if (currentView === ‘all’)      renderAllView();
if (currentView === ‘stats’)    renderStatsView();
if (currentView === ‘settings’) renderSettingsView();
if (currentView === ‘backlog’)  renderBacklogView();
} catch(e) { console.error(‘renderView:’, e); }
try { updateBadges(); } catch(e) { console.error(‘updateBadges:’, e); }
try { updatePageSub(); } catch(e) { console.error(‘updatePageSub:’, e); }
}

function renderCurrentView() {
if (currentView === ‘today’)    renderTodayView();
if (currentView === ‘all’)      renderAllView();
if (currentView === ‘stats’)    renderStatsView();
if (currentView === ‘settings’) renderSettingsView();
if (currentView === ‘backlog’)  renderBacklogView();
}

// ── HEADER ────────────────────────────────────────────────────────────────
function renderHeader() {
const days   = [‘Sun’,‘Mon’,‘Tue’,‘Wed’,‘Thu’,‘Fri’,‘Sat’];
const months = [‘Jan’,‘Feb’,‘Mar’,‘Apr’,‘May’,‘Jun’,‘Jul’,‘Aug’,‘Sep’,‘Oct’,‘Nov’,‘Dec’];
const dateEl = document.getElementById(‘dateDisplay’);
if (dateEl) dateEl.textContent = `${days[TODAY.getDay()]} ${TODAY.getDate()} ${months[TODAY.getMonth()]} ${TODAY.getFullYear()}`;
const streakEl = document.getElementById(‘streakChip’);
if (streakEl) streakEl.textContent = `🔥 ${calcStreak()}`;
const dte = getDaysToExam();
const examEl = document.getElementById(‘examCountdown’);
if (examEl) examEl.textContent = dte <= 0 ? ‘📝 Exam Day!’ : dte <= STUDY_PLAN.graceDays ? `🕊 Grace: ${dte}d` : `📅 ${dte}d to exam`;
}

function updateBadges() {
const due = DAYS_DATA.filter(d => !ensureDayState(d.id).hidden && isDayActionable(d.id)).length;
const badge = document.getElementById(‘badge-today’);
if (badge) badge.textContent = due > 0 ? due : ‘’;
const { overdueTopics, pendingRevisions } = getBacklogData();
const bBadge = document.getElementById(‘badge-backlog’);
if (bBadge) { const t = overdueTopics.length + pendingRevisions.length; bBadge.textContent = t > 0 ? t : ‘’; }
}

// ── TODAY VIEW ────────────────────────────────────────────────────────────
function renderTodayView() {
const el = document.getElementById(‘viewToday’);
if (!el) return;

```
const sched        = getEffectiveSchedule();
const studied      = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
const totalRevDone = DAYS_DATA.reduce((acc,d) => acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
const planDay      = getPlanDay();
const phase        = getCurrentPhase();
const phaseDaysLeft = phase ? Math.max(0, phase.days[1] - planDay) : 0;

const dueItems = [];
DAYS_DATA.forEach(day => {
  const st = ensureDayState(day.id);
  if (st.hidden) return;
  sched.forEach(r => {
    const s = getRevStatus(day.id, r.key, st);
    if (s === 'due-today' || s === 'overdue') {
      dueItems.push({ day, revKey: r.key, label: r.label, status: s });
    }
  });
});

const tISO        = todayISO();
const studiedToday = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate === tISO);

const phaseHtml = phase ? `
  <div class="plan-bar">
    <span class="plan-phase-tag" style="background:${phase.color}22;color:${phase.color};border:1px solid ${phase.color}44">${phase.label}</span>
    <span class="plan-desc">${phase.desc || ''}</span>
    <span class="plan-day-num">Plan Day ${planDay}</span>
  </div>
` : '';

el.innerHTML = `
  ${phaseHtml}
  <div class="today-hero">
    <div class="hero-card accent" onclick="App.showAnalysisModal('due')">
      <div class="hero-num">${dueItems.length}</div>
      <div class="hero-label">Due Today</div>
    </div>
    <div class="hero-card" onclick="App.showAnalysisModal('studied')">
      <div class="hero-num">${studied}</div>
      <div class="hero-label">Studied</div>
    </div>
    <div class="hero-card" onclick="App.showAnalysisModal('revisions')">
      <div class="hero-num">${totalRevDone}</div>
      <div class="hero-label">Revisions</div>
    </div>
    <div class="hero-card" onclick="App.showAnalysisModal('phase')">
      <div class="hero-num">${phaseDaysLeft}</div>
      <div class="hero-label">Phase Days Left</div>
    </div>
  </div>

  ${dueItems.length > 0 ? `
    <div class="section-title">Revisions Due <span class="count-chip">${dueItems.length}</span></div>
    <div class="rev-due-list">${dueItems.map(item => renderDueCard(item)).join('')}</div>
  ` : `
    <div class="section-title">Revisions Due</div>
    <div class="no-due">✓ No revisions due today — well done!</div>
  `}

  ${studiedToday.length > 0 ? `
    <div class="section-title" style="margin-top:28px">Studied Today <span class="count-chip green">${studiedToday.length}</span></div>
    <div class="rev-due-list">
      ${studiedToday.map(day => `
        <div class="rev-due-card completed">
          <div class="rdc-day">${formatDayId(day.id)}</div>
          <div class="rdc-topic" onclick="App.openTopicDetail('${day.id}')">
            ${day.topic}
            <small>${SECTIONS_META[day.sec] ? SECTIONS_META[day.sec].label : ''}</small>
          </div>
          <div class="rdc-rev-label">READ</div>
          <div class="rdc-check done" onclick="App.promptUnmarkStudy('${day.id}')">✓</div>
        </div>
      `).join('')}
    </div>
  ` : ''}
`;
```

}

function renderDueCard(item) {
const { day, revKey, label, status } = item;
const st          = ensureDayState(day.id);
const isDone      = !!st.revisions[revKey];
const target      = getRevTarget(day.id, revKey, st);
const overdueDays = status === ‘overdue’ ? daysDiff(target, todayISO()) : 0;
const sectionName = SECTIONS_META[day.sec] ? SECTIONS_META[day.sec].label : ‘General’;

```
return `
  <div class="rev-due-card ${isDone ? 'completed' : status === 'overdue' ? 'overdue' : ''}">
    <div class="rdc-day">${formatDayId(day.id)}</div>
    <div class="rdc-topic" onclick="App.openTopicDetail('${day.id}')">
      ${day.topic}
      <small>${sectionName} · Target: ${fmtDisplay(target)}${status === 'overdue' ? ` <span class="overdue-tag">${overdueDays}d late</span>` : ''}</small>
    </div>
    <div class="rdc-actions">
      <button class="rdc-snooze" onclick="App.scheduleNextDay('${day.id}','${revKey}')" title="Schedule for tomorrow">→+1</button>
      <div class="rdc-rev-label rev-${revKey}">${label}</div>
      <div class="rdc-check ${isDone ? 'done' : ''}" onclick="App.handleRevCheck('${day.id}','${revKey}',event)">${isDone ? '✓' : ''}</div>
    </div>
  </div>
`;
```

}

function formatDayId(id) {
const sid = String(id);
if (sid.startsWith(‘s’))   return ‘S’ + sid.slice(1).padStart(2,‘0’);
if (sid.startsWith(‘c_’)) {
const day = DAYS_DATA.find(d => String(d.id) === sid);
if (day && day.seqNum) return ‘D’ + String(day.seqNum).padStart(3,‘0’);
const parts = sid.split(’*’);
return parts[1].slice(0,3).toUpperCase() + (parts[2] || ‘’).slice(-4);
}
// FIX: handle float-derived string IDs like ‘r_118_1’
if (sid.startsWith(’r*’)) return sid.replace(‘r_’,‘D’).replace(’_’,’.’);
// Pure number
if (!isNaN(Number(sid))) return ‘D’ + sid.padStart(3,‘0’);
// Alphanumeric like ‘g1’, ‘ca1_f’, etc.
return sid.toUpperCase().slice(0,6);
}

// ── ANALYTICS MODALS ──────────────────────────────────────────────────────
function showAnalysisModal(type) {
const planDay = getPlanDay();
const phase   = getCurrentPhase();
const bd      = getBacklogData();
const sched   = getEffectiveSchedule();
let title = ‘’, html = ‘’, insight = ‘’;

```
if (type === 'due') {
  const dueCount = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
  const doneTodayCount = DAYS_DATA.filter(d => {
    const st = ensureDayState(d.id);
    return st.studyDate === todayISO() || sched.some(r => st.revisions[r.key] === todayISO());
  }).length;
  title   = 'Daily Action Analysis';
  html    = `
    <div class="analysis-stat"><span>Pending Revisions Today</span><strong>${dueCount}</strong></div>
    <div class="analysis-stat"><span>Tasks Completed Today</span><strong>${doneTodayCount}</strong></div>
  `;
  insight = dueCount > 0
    ? '🎯 Focus on clearing today\'s pending revisions before reading new topics. Stop memory decay first.'
    : '✅ Fully caught up. You may safely tackle new initial reads or custom sub-topics.';
}
else if (type === 'studied') {
  const totalTopics = DAYS_DATA.length;
  const studied     = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
  const pct         = Math.round((studied/totalTopics)*100);
  title   = 'Overall Study Coverage';
  html    = `
    <div class="analysis-stat"><span>Topics Read</span><strong>${studied} / ${totalTopics}</strong></div>
    <div class="analysis-stat"><span>Not Started</span><strong>${totalTopics - studied}</strong></div>
    <div class="analysis-stat"><span>Coverage</span><strong>${pct}%</strong></div>
  `;
  insight = bd.overdueTopics.length > 0
    ? `🎯 ${bd.overdueTopics.length} initial reads pending from past days. Halt forward progression and clear this backlog.`
    : '✅ Initial reads are pacing well. Keep matching new reads to your phase schedule.';
}
else if (type === 'revisions') {
  const totalRevDone = DAYS_DATA.reduce((acc,d) => acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
  const totalOverdue = bd.pendingRevisions.length;
  title   = 'Revision Health Check';
  html    = `
    <div class="analysis-stat"><span>Total Revisions Logged</span><strong>${totalRevDone}</strong></div>
    <div class="analysis-stat"><span>Topics w/ Overdue Revisions</span><strong style="color:var(--red)">${totalOverdue}</strong></div>
  `;
  insight = totalOverdue > 0
    ? `🎯 ${totalOverdue} topics are leaking from your memory network. Open Backlog and clear these red alerts.`
    : '✅ Spaced repetition engine is healthy. Memory retention is optimal.';
}
else if (type === 'phase') {
  const phaseDaysLeft = phase ? Math.max(0, phase.days[1] - planDay) : 0;
  if (phase && bd.phaseProgress) {
    const topicsLeft  = bd.phaseProgress.total - bd.phaseProgress.studiedCount;
    const requiredPace = phaseDaysLeft > 0 ? (topicsLeft / phaseDaysLeft).toFixed(1) : topicsLeft;
    title = `${phase.label} Trajectory`;
    html  = `
      <div class="analysis-stat"><span>Phase Boundary</span><strong>Day ${phase.days[0]} – ${phase.days[1]}</strong></div>
      <div class="analysis-stat"><span>Unread Topics in Phase</span><strong>${topicsLeft}</strong></div>
      <div class="analysis-stat"><span>Days Remaining</span><strong>${phaseDaysLeft}</strong></div>
      <div class="analysis-stat"><span>Required Pace</span><strong>${requiredPace} topics / day</strong></div>
    `;
    insight = requiredPace > 2
      ? '🎯 Falling behind phase schedule. Increase daily read volume to catch up.'
      : '✅ Moving at a sustainable pace. Stick to the plan.';
  }
}

const mc = document.getElementById('modal-content');
mc.innerHTML = `
  <div class="modal-title">${title}</div>
  <div style="font-size:11px;color:var(--text3);margin-bottom:16px;text-transform:uppercase;letter-spacing:1px">Decision Analytics</div>
  ${html}
  <div class="analysis-insight">${insight}</div>
  <div class="modal-btn-row" style="margin-top:20px">
    <button class="btn-primary" onclick="App.closeModal()">Got it</button>
  </div>
`;
document.getElementById('modal-overlay').classList.add('open');
```

}

// ── ALL DAYS VIEW ─────────────────────────────────────────────────────────
function renderAllView() {
const el = document.getElementById(‘viewAll’);
if (!el) return;
const sections = currentSection === ‘all’ ? Object.keys(SECTIONS_META) : [currentSection];
let html = ‘’;

```
sections.forEach(sec => {
  if (!SECTIONS_META[sec]) return;
  const meta         = SECTIONS_META[sec];
  const days         = DAYS_DATA.filter(d => d.sec === sec && !ensureDayState(d.id).hidden);
  const studiedCount = days.filter(d => ensureDayState(d.id).studyDate).length;

  html += `
    <div class="days-section-header" style="border-left-color:${meta.color}">
      <span style="color:${meta.color}">${meta.label}</span>
      <span class="sec-progress">${studiedCount}/${days.length} read</span>
      <button class="add-topic-btn" onclick="App.showAddTopicModal('${sec}')">+ Add Topic</button>
    </div>
    <div class="days-grid">${days.map(day => renderDayCard(day)).join('')}</div>
  `;
});

el.innerHTML = html || '<div class="no-due">No topics in this section.</div>';
```

}

function renderDayCard(day) {
const st       = ensureDayState(day.id);
const hasDue   = isDayActionable(day.id);
const sched    = getEffectiveSchedule();
const allDone  = st.studyDate && sched.every(r => st.revisions[r.key]);
const isBacklog = !st.studyDate && day.planDay && day.planDay <= getPlanDay();

```
let cardClass = 'day-card';
if (hasDue)        cardClass += ' has-due';
else if (allDone)  cardClass += ' all-complete';
else if (!st.studyDate) cardClass += ' not-started';

return `
  <div class="${cardClass}" id="dc-${day.id}">
    <div class="dc-header" onclick="App.toggleCard('${day.id}')">
      <div class="dc-day-num">${formatDayId(day.id)}</div>
      <div class="dc-topic-wrap">
        <div class="dc-topic" onclick="event.stopPropagation();App.openTopicDetail('${day.id}')">${day.topic}</div>
        <div class="dc-status-row">
          ${hasDue        ? '<span class="pill pill-due">DUE</span>' : ''}
          ${isBacklog     ? '<span class="pill pill-due">BACKLOG</span>' : ''}
          ${st.studyDate  ? '<span class="pill pill-read">READ</span>' : '<span class="pill pill-ns">NOT STARTED</span>'}
          ${allDone       ? '<span class="pill pill-done">✓ COMPLETE</span>' : ''}
        </div>
      </div>
      <span class="chevron">▸</span>
    </div>
    <div class="dc-body" id="dcb-${day.id}">
      ${buildTimeline(day.id, st)}
      ${st.extraTopics && st.extraTopics.length > 0 ? `
        <div class="extra-topics-list">
          <div class="et-header">Sub-topics</div>
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
        ${day.custom ? `<button class="dc-footer-btn danger" onclick="App.confirmHideDay('${day.id}')">Remove</button>` : ''}
      </div>
    </div>
  </div>
`;
```

}

// ── TIMELINE ──────────────────────────────────────────────────────────────
// Visibility rule B:
//   done            → dot-done
//   next actionable → due-today / overdue / upcoming  (clickable)
//   one preview     → upcoming-preview (shown but visually dimmer, not clickable for action)
//   rest            → locked
function buildTimeline(dayId, st) {
const sched    = getEffectiveSchedule();
let html       = ‘<div class="timeline">’;
const studyDone = !!st.studyDate;

```
html += `
  <div class="tl-node ${studyDone ? 'tl-done' : 'tl-pending'}" onclick="App.handleStudyCheck('${dayId}',event)">
    <div class="tl-dot ${studyDone ? 'dot-done' : 'dot-empty'}">${studyDone ? '✓' : '·'}</div>
    <div class="tl-content">
      <div class="tl-label">Initial Read</div>
      <div class="tl-date ${studyDone ? 'date-done' : 'date-none'}">${studyDone ? fmtDisplay(st.studyDate) : 'Tap to mark'}</div>
    </div>
  </div>
`;

sched.forEach((r, idx) => {
  const status  = getRevStatus(dayId, r.key, st);
  const done    = !!st.revisions[r.key];
  const isPreview   = status === 'upcoming-preview';
  const isLocked    = status === 'locked';
  const isOverdue   = status === 'overdue';
  const isDueToday  = status === 'due-today';
  const isUpcoming  = status === 'upcoming';

  // Compute display target
  let displayTarget = null;
  if (done) {
    displayTarget = st.revisions[r.key];
  } else if (!isLocked) {
    if (isPreview) {
      // For preview: compute from actionable revision's target (not completion)
      const prevTarget = getRevTarget(dayId, sched[idx-1].key, st);
      if (prevTarget) {
        const gap = r.gap !== undefined ? r.gap : (r.days || 1);
        displayTarget = addDays(prevTarget, gap);
      }
    } else {
      displayTarget = getRevTarget(dayId, r.key, st);
    }
  }

  let dotClass  = 'dot-empty';
  if (done)        dotClass = 'dot-done';
  else if (isOverdue || isDueToday) dotClass = 'dot-due';
  else if (isLocked || isPreview)   dotClass = 'dot-locked';

  let nodeClass = 'tl-node';
  if (done)          nodeClass += ' tl-done';
  else if (isOverdue || isDueToday) nodeClass += ' tl-due-node';
  else if (isLocked) nodeClass += ' tl-locked';
  else if (isPreview) nodeClass += ' tl-preview';

  const prevDone    = idx === 0 ? studyDone : !!st.revisions[sched[idx-1].key];
  const lineClass   = prevDone ? 'tl-line line-done' : 'tl-line line-pending';

  // Only actionable revisions get click handler
  const clickable   = !isLocked && !isPreview && !done;
  const clickAttr   = (done || !isLocked && !isPreview)
    ? `onclick="App.handleChipClick('${dayId}','${r.key}',event)"`
    : '';

  html += `<div class="${lineClass}"></div>`;
  html += `
    <div class="${nodeClass}" ${clickAttr}>
      <div class="${dotClass} tl-dot">${done ? '✓' : isLocked || isPreview ? '🔒' : (isOverdue || isDueToday) ? '!' : '·'}</div>
      <div class="tl-content">
        <div class="tl-label">${r.label} <span class="tl-desc">${r.desc || ''}</span></div>
        <div class="tl-date ${done ? 'date-done' : isLocked || isPreview ? 'date-none' : isOverdue || isDueToday ? 'date-due' : 'date-future'}">
          ${done
            ? fmtDisplay(st.revisions[r.key])
            : displayTarget
              ? fmtDisplay(displayTarget) + (isPreview ? ' <span class="preview-tag">preview</span>' : '')
              : 'Locked'}
          ${(isOverdue || isDueToday) && !done ? '<span class="due-badge">Due</span>' : ''}
        </div>
      </div>
      ${!done && !isLocked && !isPreview && st.studyDate ? `
        <button class="tl-snooze" onclick="event.stopPropagation();App.scheduleNextDay('${dayId}','${r.key}')" title="+1 day">→</button>
      ` : ''}
    </div>
  `;
});

html += '</div>';
return html;
```

}

// ── TOPIC DETAIL MODAL ────────────────────────────────────────────────────
function openTopicDetail(dayId) {
const day = DAYS_DATA.find(d => String(d.id) === String(dayId));
if (!day) return;
const st        = ensureDayState(day.id);
const sched     = getEffectiveSchedule();
const meta      = SECTIONS_META[day.sec] || { label: ‘General’, color: ‘#888’ };
const studyDone = !!st.studyDate;

```
const revCards = sched.map(r => {
  const status = getRevStatus(dayId, r.key, st);
  const done   = !!st.revisions[r.key];
  const isPreview = status === 'upcoming-preview';
  const isLocked  = status === 'locked';

  // Compute display target same way as timeline
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

  let cardClass   = 'td-rev-card';
  let statusText  = '—';
  if (done)                  { cardClass += ' done';      statusText = '✓ Done'; }
  else if (status === 'due-today')  { cardClass += ' due-today'; statusText = '● Due Today'; }
  else if (status === 'overdue')    { cardClass += ' overdue';   statusText = '! Overdue'; }
  else if (isPreview)               { statusText = `Preview`; }
  else if (isLocked)                { statusText = '🔒 Locked'; }
  else if (status === 'upcoming')   { statusText = displayTarget ? fmtDisplay(displayTarget) : '—'; }

  const dateText = done ? fmtDisplay(st.revisions[r.key]) : (displayTarget ? fmtDisplay(displayTarget) : '—');
  const canClick = !isLocked && !isPreview;

  return `
    <div class="${cardClass}${canClick ? '' : ' td-rev-no-click'}"
         ${canClick ? `onclick="App.handleChipFromDetail('${dayId}','${r.key}')"` : ''}>
      <div class="td-rev-label">${r.label}</div>
      <div class="td-rev-date">${dateText}</div>
      <div class="td-rev-status" style="color:${done?'#1E5C38':status==='overdue'?'#B91C1C':status==='due-today'?'#B07A00':isPreview?'#999':'#aaa'}">${statusText}</div>
    </div>
  `;
}).join('');

const isBacklog = !studyDone && day.planDay && day.planDay <= getPlanDay();
const hasDue    = isDayActionable(day.id);

const mc = document.getElementById('modal-content');
mc.innerHTML = `
  <div class="topic-detail-header">
    <div>
      <div class="td-day-badge">${formatDayId(day.id)}</div>
      <div class="td-section-tag" style="background:${meta.color}22;color:${meta.color};border:1px solid ${meta.color}44">${meta.label}</div>
    </div>
    <div style="flex:1">
      <div class="td-topic-name">${day.topic}</div>
      ${day.planDay ? `<div style="font-size:11px;color:#999;margin-top:4px;font-family:var(--mono)">Plan Day ${day.planDay} · ${fmtDisplay(getPlanDateForDay(day.planDay))}</div>` : ''}
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        ${isBacklog && !studyDone ? '<span class="pill pill-due">BACKLOG</span>' : ''}
        ${hasDue   ? '<span class="pill pill-due">REVISION DUE</span>' : ''}
        ${studyDone
          ? `<span class="pill pill-read">Read: ${fmtDisplay(st.studyDate)}</span>`
          : '<span class="pill pill-ns">NOT STARTED</span>'}
      </div>
    </div>
  </div>

  <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px">Revision Schedule</div>
  <div class="td-revisions-grid">${revCards}</div>

  ${st.extraTopics && st.extraTopics.length > 0 ? `
    <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:1.5px;margin:14px 0 8px">Sub-topics</div>
    ${st.extraTopics.map(et => `<div style="font-size:13px;color:#333;padding:6px 0;border-bottom:1px solid #eee">${et.topic}</div>`).join('')}
  ` : ''}

  <div class="td-actions" style="margin-top:18px">
    ${!studyDone
      ? `<button class="btn-primary" onclick="App.replaceModalWith_DateModal('${dayId}','study')">Mark as Read</button>`
      : `<button class="btn-secondary" onclick="App.closeModal();App.promptUnmarkStudy('${dayId}')">Unmark Read</button>`}
    <button class="btn-secondary" onclick="App.closeModal()">Close</button>
  </div>
`;
document.getElementById('modal-overlay').classList.add('open');
```

}

// ── STATS VIEW ────────────────────────────────────────────────────────────
function renderStatsView() {
const el = document.getElementById(‘viewStats’);
if (!el) return;

```
const sched        = getEffectiveSchedule();
const studied      = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
const totalRevDone = DAYS_DATA.reduce((acc,d) => acc + sched.filter(r => ensureDayState(d.id).revisions[r.key]).length, 0);
const dueCount     = DAYS_DATA.filter(d => isDayActionable(d.id)).length;
const streak       = calcStreak();
const planDay      = getPlanDay();
const totalDays    = DAYS_DATA.length;

const secProgress = Object.entries(SECTIONS_META).map(([sec, meta]) => {
  const days = DAYS_DATA.filter(d => d.sec === sec);
  const done = days.filter(d => ensureDayState(d.id).studyDate).length;
  const pct  = days.length > 0 ? Math.round((done/days.length)*100) : 0;
  return { sec, meta, done, total: days.length, pct };
});

const revProgress = sched.map(r => {
  const eligible = DAYS_DATA.filter(d => ensureDayState(d.id).studyDate).length;
  const done     = DAYS_DATA.filter(d => ensureDayState(d.id).revisions[r.key]).length;
  const pct      = eligible > 0 ? Math.round((done/eligible)*100) : 0;
  return { ...r, done, eligible, pct };
});

const heatmapData = buildHeatmap();

el.innerHTML = `
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-card-num">${studied}</div><div class="stat-card-label">Days Studied</div></div>
    <div class="stat-card"><div class="stat-card-num">${totalRevDone}</div><div class="stat-card-label">Revisions Done</div></div>
    <div class="stat-card"><div class="stat-card-num">${streak}</div><div class="stat-card-label">Streak 🔥</div></div>
    <div class="stat-card"><div class="stat-card-num">${dueCount}</div><div class="stat-card-label">Due Today</div></div>
    <div class="stat-card"><div class="stat-card-num">${Math.round((studied/totalDays)*100)}%</div><div class="stat-card-label">Coverage</div></div>
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
    <h3>Revision Completion</h3>
    ${revProgress.map(r => `
      <div class="prog-row">
        <div class="prog-label">${r.label} — ${r.desc || ''}</div>
        <div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${r.pct}%;background:var(--burgundy)"></div></div>
        <div class="prog-pct">${r.done}/${r.eligible}</div>
      </div>
    `).join('')}
  </div>

  <div class="heatmap-wrap">
    <h3>Activity — Last 90 Days</h3>
    <p class="hm-sub">Each cell = one day · darker = more activity</p>
    <div class="heatmap-grid">
      ${heatmapData.map(cell => `<div class="hmap-cell hm-${cell.level}" title="${cell.date}: ${cell.count} activities"></div>`).join('')}
    </div>
  </div>
`;
```

}

function buildHeatmap() {
const sched  = getEffectiveSchedule();
const result = [];
for (let i = 89; i >= 0; i–) {
const d   = new Date(TODAY); d.setDate(d.getDate() - i);
const iso = fmtISO(d);
let count = 0;
DAYS_DATA.forEach(day => {
const st = STATE[day.id] || {};
if (st.studyDate === iso) count++;
sched.forEach(r => { if ((st.revisions||{})[r.key] === iso) count++; });
});
const level = count===0?0:count<=1?1:count<=3?2:count<=5?3:4;
result.push({ date: iso, count, level });
}
return result;
}

// ── BACKLOG VIEW ──────────────────────────────────────────────────────────
function renderBacklogView() {
const el = document.getElementById(‘viewBacklog’);
if (!el) return;
const { overdueTopics, pendingRevisions, phaseProgress } = getBacklogData();
const planDay      = getPlanDay();
const activePhases = getActivePhases();

```
// Group overdue topics by phase
const byPhase = {};
overdueTopics.forEach(d => {
  const phase = activePhases.map(normalizePhase).find(p => d.planDay >= p.days[0] && d.planDay <= p.days[1])
             || { label: 'Unassigned', color: '#888', id: 'other' };
  if (!byPhase[phase.id]) byPhase[phase.id] = { phase, topics: [] };
  byPhase[phase.id].topics.push(d);
});

const alertHtml = phaseProgress && phaseProgress.behind > 0 ? `
  <div class="backlog-alert">
    <div class="ba-icon">⚠</div>
    <div class="ba-text">
      <strong>${phaseProgress.behind} topic${phaseProgress.behind>1?'s':''} behind</strong> in ${phaseProgress.phase.label}.<br>
      Studied: ${phaseProgress.studiedCount} of ${phaseProgress.total}. Expected by now: ${phaseProgress.expectedCount}.
    </div>
  </div>
` : phaseProgress ? `
  <div class="backlog-ok">✓ On track — ${phaseProgress.studiedCount}/${phaseProgress.total} topics done in current phase</div>
` : '';

const phaseBacklogHtml = Object.values(byPhase).length > 0 ? `
  <div class="section-title" style="margin-bottom:12px">
    Topics Not Started (Plan Day Passed)
    <span class="count-chip red">${overdueTopics.length}</span>
  </div>
  ${Object.values(byPhase).map(({ phase, topics }) => `
    <div class="phase-backlog-section" style="border-left-color:${phase.color}">
      <div class="pbl-header" style="background:${phase.color}15;color:${phase.color};border-bottom-color:${phase.color}33">
        ${phase.label} · ${topics.length} overdue
      </div>
      <div class="bl-list">
        ${topics.map(d => {
          const daysOverdue = planDay - d.planDay;
          return `
            <div class="bl-item">
              <div class="bl-id">${formatDayId(d.id)}</div>
              <div class="bl-topic" onclick="App.openTopicDetail('${d.id}')">${d.topic}</div>
              <span style="font-size:10px;color:${phase.color};font-weight:600;font-family:var(--mono);white-space:nowrap">${daysOverdue}d late</span>
              <button class="bl-mark" onclick="App.showDateModal('${d.id}','study')">Mark Read</button>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('')}
` : overdueTopics.length === 0 ? `
  <div class="backlog-ok" style="margin-bottom:16px">✓ All required plan-day topics started!</div>
` : '';

const revBacklogHtml = pendingRevisions.length > 0 ? `
  <div class="section-title" style="margin-bottom:12px;margin-top:${overdueTopics.length>0?'20px':'0'}">
    Overdue Revisions <span class="count-chip red">${pendingRevisions.length}</span>
  </div>
  <div class="backlog-section">
    <div class="bl-list">
      ${pendingRevisions.map(({ day, overdueRevs }) => {
        const st       = ensureDayState(day.id);
        const sched    = getEffectiveSchedule();
        const nextOD   = sched.find(r => getRevStatus(day.id, r.key, st) === 'overdue');
        return `
          <div class="bl-item bl-overdue">
            <div class="bl-id">${formatDayId(day.id)}</div>
            <div class="bl-topic" onclick="App.openTopicDetail('${day.id}')">${day.topic}</div>
            <span style="font-size:10px;color:var(--red);font-weight:700">${overdueRevs} rev overdue</span>
            ${nextOD ? `<button class="bl-mark" onclick="App.showDateModal('${day.id}','${nextOD.key}')">Mark ${nextOD.key.toUpperCase()}</button>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  </div>
` : '';

el.innerHTML = `
  ${alertHtml}
  ${phaseBacklogHtml}
  ${revBacklogHtml}
  ${overdueTopics.length === 0 && pendingRevisions.length === 0
    ? '<div class="no-due">✓ No backlog — you\'re fully on track!</div>'
    : ''}
`;
```

}

// ── SETTINGS VIEW ─────────────────────────────────────────────────────────
function renderSettingsView() {
const el     = document.getElementById(‘viewSettings’);
if (!el) return;
const sched  = getEffectiveSchedule();
const phases = getActivePhases();

```
el.innerHTML = `
  <div class="settings-section">
    <h3>Study Plan</h3>
    <div class="settings-row"><span>Plan Start</span><strong>${fmtDisplay(STUDY_PLAN.startDate)}</strong></div>
    <div class="settings-row"><span>Exam Date</span><strong>${fmtDisplay(STUDY_PLAN.examDate)}</strong></div>
    <div class="settings-row"><span>Today is Plan Day</span><strong>${getPlanDay()}</strong></div>
    <div class="settings-row"><span>Days to Exam</span><strong>${getDaysToExam()}</strong></div>
    <div class="phase-list">
      ${phases.map(normalizePhase).map(p => `
        <div class="phase-card" style="border-left-color:${p.color}">
          <strong style="color:${p.color}">${p.label}</strong> · Days ${p.days[0]}–${p.days[1]}
          <div class="phase-desc">${p.desc || ''}</div>
        </div>
      `).join('')}
    </div>
  </div>

  <div class="settings-section">
    <h3>Spaced Repetition Rules</h3>
    <p class="settings-hint">Each revision is scheduled relative to the <em>previous step's actual completion date</em> (chained, dynamic). R1 = study date + gap, R2 = R1 done date + gap, etc.</p>
    <div id="sched-editor">
      ${sched.map(r => `
        <div class="sched-row">
          <span class="sr-key">${r.label}</span>
          <span class="sr-relto">Prev Step +</span>
          <input class="sr-input" type="number" id="sr-${r.key}" value="${r.gap !== undefined ? r.gap : (r.days || 1)}" min="1" max="365" />
          <span class="sr-unit">days</span>
        </div>
      `).join('')}
    </div>
    <button class="settings-save-btn" onclick="App.saveSchedule()">Save Rules</button>
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
    <p class="settings-hint">Up to 50 undo steps per session.</p>
  </div>
`;
```

}

function saveSchedule() {
const sched = getEffectiveSchedule().map(r => ({…r}));
let valid = true;
sched.forEach(r => {
const inp = document.getElementById(‘sr-’ + r.key);
if (inp) {
const v = parseInt(inp.value);
if (isNaN(v) || v < 1) { valid = false; return; }
r.gap  = v;
r.days = v;
r.desc = `+${v}d`;
}
});
if (!valid) { toast(‘⚠ Invalid values’); return; }
snapshot();
CONFIG.revSchedule = sched;
saveToDB(); renderAll(); toast(‘✓ Saved’);
}

function resetSchedule() {
snapshot();
CONFIG.revSchedule = REV_SCHEDULE.map(r => ({…r}));
CONFIG.phases      = STUDY_PLAN.phases.map(p => ({…p}));
saveToDB(); renderSettingsView(); toast(‘Reset to default’);
}

function confirmResetAll() {
showModal({
title: ‘Reset All Data?’,
sub: ‘Permanently deletes all study dates, revisions and extra topics.’,
confirm: ‘Reset Everything’, danger: true,
onConfirm: () => {
STATE   = buildFreshState();
HISTORY = []; FUTURE = [];
const toRemove = DAYS_DATA.filter(d => d.custom).map(d => d.id);
toRemove.forEach(id => { const idx = DAYS_DATA.findIndex(d => d.id === id); if (idx > -1) DAYS_DATA.splice(idx,1); });
saveToDB(); renderAll(); closeModal(); toast(‘Data reset’);
}
});
}

// ── INTERACTION HANDLERS ──────────────────────────────────────────────────
function toggleCard(dayId) {
const el = document.getElementById(‘dc-’ + dayId);
if (el) el.classList.toggle(‘open’);
}

function handleStudyCheck(dayId, e) {
if (e) e.stopPropagation();
const st = ensureDayState(dayId);
if (st.studyDate) {
showModal({
title: ‘Remove study date?’,
sub: ‘This will also clear all revisions for this topic.’,
confirm: ‘Remove’, danger: true,
onConfirm: () => { unmarkStudied(dayId); closeModal(); }
});
} else {
showDateModal(dayId, ‘study’);
}
}

function handleChipClick(dayId, revKey, e) {
if (e) e.stopPropagation();
const st     = ensureDayState(dayId);
const status = getRevStatus(dayId, revKey, st);

```
if (!st.studyDate)            { toast('Mark initial study first'); return; }
if (status === 'locked')      { toast('⚠ Complete previous revision first'); return; }
if (status === 'upcoming-preview') { toast('Complete the current revision first'); return; }

if (st.revisions[revKey]) {
  showModal({
    title: `Remove ${revKey.toUpperCase()}?`,
    sub: 'This will also clear all subsequent revisions (they depend on this date).',
    confirm: 'Remove', danger: true,
    onConfirm: () => { unmarkRevision(dayId, revKey); closeModal(); }
  });
} else {
  showDateModal(dayId, revKey);
}
```

}

function handleChipFromDetail(dayId, revKey) {
const st     = ensureDayState(dayId);
const status = getRevStatus(dayId, revKey, st);

```
if (!st.studyDate)            { toast('Mark initial study first'); return; }
if (status === 'locked')      { toast('⚠ Complete previous revision first'); return; }
if (status === 'upcoming-preview') { toast('Complete the current revision first'); return; }

if (st.revisions[revKey]) {
  showModal({
    title: `Remove ${revKey.toUpperCase()}?`,
    sub: 'This will also clear all subsequent revisions.',
    confirm: 'Remove', danger: true,
    onConfirm: () => {
      unmarkRevision(dayId, revKey);
      closeModal();
      setTimeout(() => openTopicDetail(dayId), 50);
    }
  });
} else {
  // FIX: replace modal content in-place — no flicker
  replaceModalWith_DateModal(dayId, revKey);
}
```

}

function handleRevCheck(dayId, revKey, e) {
if (e) e.stopPropagation();
handleChipClick(dayId, revKey, null);
}

function promptUnmarkStudy(dayId) {
showModal({
title: ‘Remove study date?’,
sub: ‘This will also clear all revisions.’,
confirm: ‘Remove’, danger: true,
onConfirm: () => { unmarkStudied(dayId); closeModal(); }
});
}

// ── MODAL SYSTEM ──────────────────────────────────────────────────────────
function showModal({ title, sub, confirm, danger, onConfirm }) {
const mc = document.getElementById(‘modal-content’);
mc.innerHTML = `<div class="modal-title">${title}</div> <div class="modal-sub">${sub}</div> <div class="modal-btn-row"> <button class="btn-secondary" onclick="App.closeModal()">Cancel</button> <button class="btn-primary${danger?' btn-danger':''}" id="modal-confirm-btn">${confirm}</button> </div>`;
document.getElementById(‘modal-confirm-btn’).onclick = onConfirm;
document.getElementById(‘modal-overlay’).classList.add(‘open’);
}

function showDateModal(dayId, type) {
const day   = DAYS_DATA.find(d => String(d.id) === String(dayId));
const label = type === ‘study’ ? ‘Initial Study’ : type.toUpperCase() + ’ Revision’;
const mc    = document.getElementById(‘modal-content’);
mc.innerHTML = `<div class="modal-title">Mark ${label}</div> <div class="modal-sub">${formatDayId(dayId)} — ${day ? day.topic : ''}</div> <div class="date-input-group"> <label>Date Completed</label> <input type="date" id="datePickerInput" value="${todayISO()}" max="${todayISO()}" /> </div> <div class="modal-btn-row"> <button class="btn-secondary" onclick="App.closeModal()">Cancel</button> <button class="btn-primary" onclick="App.confirmDateModal('${dayId}','${type}')">Mark Done</button> </div>`;
document.getElementById(‘modal-overlay’).classList.add(‘open’);
}

// FIX for handleChipFromDetail: replaces content in already-open modal (no flicker)
function replaceModalWith_DateModal(dayId, type) {
showDateModal(dayId, type); // modal is already open or will open — no double-toggle
}

function confirmDateModal(dayId, type) {
const input   = document.getElementById(‘datePickerInput’);
const dateISO = input ? input.value : ‘’;
if (!dateISO) { toast(‘Please select a date’); return; }
if (type === ‘study’) markStudied(dayId, dateISO);
else markRevision(dayId, type, dateISO);
closeModal();
setTimeout(() => {
const card = document.getElementById(‘dc-’ + dayId);
if (card && !card.classList.contains(‘open’)) card.classList.add(‘open’);
}, 100);
}

function closeModal() {
document.getElementById(‘modal-overlay’).classList.remove(‘open’);
}

// ── ADD TOPIC / EXTRA ─────────────────────────────────────────────────────
function showAddTopicModal(sec) {
const mc = document.getElementById(‘modal-content’);
mc.innerHTML = `<div class="modal-title">Add Topic to ${SECTIONS_META[sec].label}</div> <div class="modal-sub">Will be numbered sequentially in this section</div> <div class="date-input-group"> <label>Topic Name</label> <input type="text" id="newTopicInput" placeholder="Enter topic name..." style="padding:10px 14px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:14px;width:100%;background:var(--surface2);color:var(--text);outline:none" /> </div> <div class="modal-btn-row"> <button class="btn-secondary" onclick="App.closeModal()">Cancel</button> <button class="btn-primary" onclick="App.confirmAddTopic('${sec}')">Add Topic</button> </div>`;
document.getElementById(‘modal-overlay’).classList.add(‘open’);
setTimeout(() => { const i = document.getElementById(‘newTopicInput’); if(i) i.focus(); }, 100);
}

function confirmAddTopic(sec) {
const input = document.getElementById(‘newTopicInput’);
const topic = input ? input.value.trim() : ‘’;
if (!topic) { toast(‘Please enter a topic name’); return; }
snapshot();

```
SECTION_ID_COUNTERS[sec] = (SECTION_ID_COUNTERS[sec] || 0) + 1;
const seqNum   = SECTION_ID_COUNTERS[sec];
const customId = `c_${sec}_${seqNum}`;
// FIX: custom topics default planDay to null so they don't immediately appear in backlog
DAYS_DATA.push({ id: customId, sec, topic, custom: true, seqNum, planDay: null });
STATE[customId] = { studyDate: null, revisions: initRevs(), extraTopics: [], notes: '' };
saveToDB(); closeModal(); renderAll();
toast(`Topic added as #${seqNum}`);
```

}

function showAddExtraTopicModal(dayId) {
const mc = document.getElementById(‘modal-content’);
mc.innerHTML = `<div class="modal-title">Add Sub-topic</div> <div class="modal-sub">Supplementary topic for ${formatDayId(dayId)}</div> <div class="date-input-group"> <label>Sub-topic Name</label> <input type="text" id="extraTopicInput" placeholder="e.g. PYQs, Extra Notes..." style="padding:10px 14px;border:1.5px solid var(--border2);border-radius:var(--radius-sm);font-size:14px;width:100%;background:var(--surface2);color:var(--text);outline:none" /> </div> <div class="modal-btn-row"> <button class="btn-secondary" onclick="App.closeModal()">Cancel</button> <button class="btn-primary" onclick="App.confirmAddExtra('${dayId}')">Add</button> </div>`;
document.getElementById(‘modal-overlay’).classList.add(‘open’);
setTimeout(() => { const i = document.getElementById(‘extraTopicInput’); if(i) i.focus(); }, 100);
}

function confirmAddExtra(dayId) {
const input = document.getElementById(‘extraTopicInput’);
const topic = input ? input.value.trim() : ‘’;
if (!topic) { toast(‘Enter a sub-topic name’); return; }
snapshot();
ensureDayState(dayId).extraTopics.push({ id: ‘et_’ + Date.now(), topic });
saveToDB(); closeModal(); renderAll(); toast(‘Sub-topic added’);
}

function confirmRemoveExtra(dayId, topicId) {
showModal({
title: ‘Remove Sub-topic?’, sub: ‘This sub-topic will be deleted.’,
confirm: ‘Remove’, danger: true,
onConfirm: () => {
snapshot();
const st = ensureDayState(dayId);
st.extraTopics = st.extraTopics.filter(t => t.id !== topicId);
saveToDB(); closeModal(); renderAll(); toast(‘Removed’);
}
});
}

function confirmHideDay(dayId) {
showModal({
title: ‘Remove this topic?’, sub: ‘Custom topic will be permanently deleted.’,
confirm: ‘Remove’, danger: true,
onConfirm: () => {
snapshot();
const idx = DAYS_DATA.findIndex(d => String(d.id) === String(dayId));
if (idx > -1) DAYS_DATA.splice(idx, 1);
delete STATE[dayId];
saveToDB(); closeModal(); renderAll(); toast(‘Topic removed’);
}
});
}

// ── EXPORT / IMPORT ───────────────────────────────────────────────────────
function exportData() {
const payload = {
version: 3,
state: STATE, config: CONFIG,
customTopics: DAYS_DATA.filter(d => d.custom),
idCounters: typeof SECTION_ID_COUNTERS !== ‘undefined’ ? SECTION_ID_COUNTERS : {},
exportedAt: new Date().toISOString()
};
const blob = new Blob([JSON.stringify(payload, null, 2)], { type: ‘application/json’ });
const url  = URL.createObjectURL(blob);
const a    = document.createElement(‘a’);
a.href = url; a.download = `bpsc_tracker_${todayISO()}.json`; a.click();
URL.revokeObjectURL(url);
toast(‘⬇ Exported’);
}

function importData(e) {
const file = e.target.files[0];
if (!file) return;
const reader = new FileReader();
reader.onload = ev => {
try {
const parsed        = JSON.parse(ev.target.result);
const importedState = parsed.state || parsed;
if (typeof importedState !== ‘object’) throw new Error(‘Invalid’);
snapshot();
// Merge state for all known topics
DAYS_DATA.forEach(d => {
if (importedState[d.id]) STATE[d.id] = importedState[d.id];
});
// Restore custom topics
if (parsed.customTopics) {
parsed.customTopics.forEach(ct => {
if (!DAYS_DATA.find(d => String(d.id) === String(ct.id))) {
DAYS_DATA.push(ct);
if (importedState[ct.id]) STATE[ct.id] = importedState[ct.id];
}
});
}
if (parsed.idCounters && typeof SECTION_ID_COUNTERS !== ‘undefined’) {
Object.assign(SECTION_ID_COUNTERS, parsed.idCounters);
}
if (parsed.config) CONFIG = { …buildDefaultConfig(), …parsed.config };
saveToDB(); renderAll(); toast(‘⬆ Import successful’);
} catch { toast(‘⚠ Invalid JSON file’); }
};
reader.readAsText(file);
e.target.value = ‘’;
}

// ── TOAST ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
const el = document.getElementById(‘toast’);
if (!el) return;
el.textContent = msg;
el.classList.add(‘show’);
clearTimeout(toastTimer);
toastTimer = setTimeout(() => el.classList.remove(‘show’), 2200);
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

document.addEventListener(‘DOMContentLoaded’, () => App.init());

if (‘serviceWorker’ in navigator) {
navigator.serviceWorker.register(‘sw.js’).catch(() => {});
}
