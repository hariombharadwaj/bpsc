# BPSC Revision Tracker v2

A fully offline-capable PWA for BPSC Prelims 2026. Rebuilt with earth-tone design, timeline-based revision view, and smart study plan tracking.

## What's New in v2
- ✅ General Science topics (S01–S20) added
- 📅 Study Plan: Phase 1→2→3 with backlog tracking
- ⏱ 8-level spaced repetition (R1–R8), each relative to previous revision
- 🌿 Earth-tone design (parchment, terracotta, olive, ochre)
- 🗂 Timeline view per topic: Read → R1 → R2 … R8 with dates
- ➕ Add/remove topics within any day or section
- ⚙ Settings panel: revision rules, data import/export, reset
- ⚑ Backlog view: not-started, once-read, in-progress tracking
- →+1 Snooze: reschedule any revision to next day
- 🔒 Revision unlock: each revision unlocks only after previous is done

## Spaced Repetition Logic
Initial Read: Day 0
R1: +1 day  (Day 1)
R2: +2 days (Day 3)
R3: +4 days (Day 7)
R4: +7 days (Day 14)
R5: +10 days (Day 24)
R6: +14 days (Day 38)
R7: +18 days (Day 56)
R8: +21 days (Day 77)
Each gap is from the PREVIOUS revision, not from initial read.

## Study Plan
- Start: 22 Mar 2026
- Exam: 26 Jul 2026
- Phase 1 (Day 1–49): Science, Bihar, Ancient, Medieval, Modern + CA Jul–Apr
- Phase 2 (Day 50–74): Polity, Geography + CA May–Jun
- Phase 3 (Day 75–90): Economy, Maths/Reasoning + CA up to date
- Grace period: last 5 days before exam

## Deploy on GitHub Pages
1. Push this folder to a GitHub repo
2. Settings → Pages → Source: main branch /
3. Live at: https://yourusername.github.io/reponame
