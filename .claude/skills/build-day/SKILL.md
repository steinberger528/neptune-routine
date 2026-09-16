Name: Build-day
Description: Reads day rules, fixed events, tasks, yesterday's plan, school load and the quote bank to draft today's schedule as a day_plans row plus a short morning question list. Never touches the calendar. Neptune's B2.2 skill, run at the top of the 6:45 brief (B2.3).

Build Day
Neptune's morning skill. Produces a draft day_plans row and a question list for the Telegram brief — nothing else. Design: _meta/specs/2026-09-11-block-2-neptune-design.md (decisions D2, D4–D9, "The morning loop"). Persona and limits: .claude/agents/neptune.md.

Scope note (Part 1 build): this skill only builds the day. It does not replan on answers (replan-day, B2.4 — Part 2), does not write the calendar, and does not decide whether the 9:00 cutoff fires the calendar write — that split lives in the routine/cron wiring around this skill, not in it. In Part 1 there is no replan-day yet, so a silent morning simply ends at the cutoff with the draft unclaimed until Part 2 lands.

All dashboard reads and writes go through _meta/scripts/jea.mjs (the B1.2 bridge CLI) — never direct Supabase calls. See _meta/bridge-contract.md for the route list. A cloud routine has no local JEA .env, so pass no --env flag — jea.mjs reads DASHBOARD_URL / AUTH_SECRET from the routine's own environment instead.

1. Gather inputs
Run these reads (no --confirm needed — they're GETs):

node jea.mjs day-rules list
node jea.mjs fixed-events list
node jea.mjs tasks today
node jea.mjs tasks backlog
node jea.mjs school overview
node jea.mjs day-plans get --date <yesterday, YYYY-MM-DD>
tasks today returns { today: "<date>", overdue: [...], today_tasks: [...] } — the split is explicit, verified 2026-09-12 against live data, no guessing needed. tasks backlog returns { tasks: [...] }, someday work with no due date. Neither response has an urgency field — which bucket a task is in is its urgency; only overdue/today_tasks compete for today's placement, tasks (backlog) only fills what's left over.
Each task carries block_type, due_date, planned_date, time_estimate_min (usually null today, but use it for block sizing when a task has one — see step 4), blocked (+blocked_since on today/overdue tasks), key (a manually-flagged priority marker), in_progress, completed_at, tags, item_type. No urgency field — see above.
fixed-events list returns every fixed event regardless of day; filter to the ones whose days[] includes today's weekday.
day-plans get --date <yesterday> gives yesterday's blocks (for what was planned), carried_over (what was already a rollover yesterday), and pushed. A 404/empty result just means no plan existed — treat it as "nothing carried in."
Weather: no jea route is contracted for it yet (see Open dependencies below). If the dashboard's day-plans/brief responses happen to carry a weather field, use it; otherwise drop the weather line from the brief rather than guessing.
Read 03-Resources/quotes.md for the quote table.
Rollover age, for a task id sitting in today's overdue/carried set: walk backward day by day (day-plans get --date <d-1>, <d-2>, …) while the id keeps appearing in that day's carried_over, stopping at the first day it doesn't (or after 14 days back — far past the 3-day question threshold, so no need to walk further). The count of consecutive days found is the rollover age.

Quote selection: walk the last 30 days the same way (day-plans get --date, today-1 through today-30), collect every quote_used id seen. Pick any row from quotes.md whose id is not in that set. If all are used within 30 days, fall back to whichever used id is oldest (least recently seen in the walk) rather than skip the quote entirely.

2. Build the day, in order
Anchors. Wake time from the day_rules row with kind: anchor (currently 7:00, window_start doubles as the pinned clock time on an anchor row — window_end and duration_min are unused for it). Emit it as a short, non-zero block — 07:00–07:15, "Wake" — never a zero-duration marker: /api/day-plans rejects any block where end <= start.
Fixed events, placed at their actual times, each with buffer_before / buffer_after blocked around it as transit/prep time. These are read-only to Neptune (neptune.md's tag rule) — include them in blocks for rendering, but never mark them as his to move.
Rule blocks — day_rules rows with kind: window and a non-null duration_min (school, gym, lunch, dinner, …). window_start/window_end are optional bounds, not guaranteed — the seeded School/Gym/Dinner rows ship with both null (place anywhere that fits, in the order given here); only Lunch is currently bounded (11:30–13:30). When both are set, place inside that range; when absent, place in the remaining gaps in whatever order makes the day sane (rule order: school, gym, lunch, dinner is a reasonable default absent a stronger signal). Avoid anything already placed. School's duration_min (2h default) is a floor: if school-tagged open task volume exceeds one window's worth, add a second School window rather than truncate the work. Respect min_chunk_min / splittable if a rule can't fit in one continuous span in the remaining gaps. Not every window/anchor row is a placement rule — a row with course_code and weight set but duration_min null exists purely to weight School task ranking by course (D9's per-course study weights), not to place a block of its own. Skip it in this step; use it in step 4 instead.
Task blocks in whatever gaps are left. Group by block_type (Computer, Home, Errands, Calls, School — set by the router at capture per B2.12; if a task has no type, infer one from its title/tags rather than leaving it unplaced). 2 hours is the default block size — a floor, not a ceiling; a group with more work than fits gets a second block of the same type later in the day if room allows. If a task carries time_estimate_min, use it to size how much of a block it needs (several small-estimate tasks can share one 2h block); most will still be null today, so the 2h default remains the common case. Inside the School block(s), order tasks by their course's weight (the course-weight-only day_rules rows from step 3, matched on course_code) before falling back to the ranking in step 5 for ties.
Rank for placement and for overflow: overdue and today_tasks (today's bucket) always outrank backlog (tasks backlog, someday work) — that bucket split is the urgency signal (see step 1). Within a bucket: due date (soonest first, missing due date sorts last), then rollover age (oldest first), then key: true ahead of key: false on remaining ties.
Stop at the 00:00 hard wall. Nothing gets placed past midnight — exams included. Whatever doesn't fit is overflow; handle it per step 3 below.
3. Overflow: silent push vs. a question
For every task ranked below the point where the day runs out of room:

Default: push silently. Add its id to pushed with { "reason": "no_room" } (or "rolled" if it was already a rollover). No question, no mention in the brief text beyond the summary line.
Exception 1 — deadline cross. If pushing this task to tomorrow-or-later would put it past its own due date, do not push it silently. Add a brief_questions entry, kind: "deadline", naming the task and its due date (this is also B2.8's deadline-crossing flag — make it unmissable, not buried).
Exception 2 — 3+ day rollover. If the task's rollover age (step 1) is 3 or more and it's about to be pushed again, add a brief_questions entry, kind: "rollover" — "still doing this, or drop it?" — instead of pushing it silently again.
Backlog stragglers (kind: "backlog"): any backlog task with blocked: true raises one question — name it and ask what it's waiting on. Verified 2026-09-12: the blocked field exists and is populated (currently false on everything in the live backlog, so this hasn't fired yet, but the field is real). There's still no created-at timestamp on tasks, so "sitting too long" by pure age isn't computable — blocked: true is the only backlog signal to act on for now.
Cap at 5 questions total. If deadline/rollover/backlog questions exceed 4, keep the highest-priority 4 in that order (deadline, then rollover, then backlog) and drop the rest — they fall back to a silent push instead of surfacing. The 5th question is always, verbatim: "Anything you're planning today that isn't on the dashboard?" (kind: "open") — present even when there are zero substantive questions, so the brief always ends the same way.

4. Write the outputs
Draft plan — write, don't ask; the plan itself is S3 per neptune.md (writing a block into the plan isn't the same act as committing calendar time):

node jea.mjs day-plans put --file <path-to-plan.json> --confirm
Shape, reconciled 2026-09-12 against the live app/api/day-plans/route.ts (dashboard repo). It's a POST (upsert on (user_id, date)) — not PUT. Every block needs end strictly after start, both 24h "HH:MM". Only send the fields you're setting; omitted fields keep whatever the row already has. Do not send generated_at or finalized_at — the route stamps both itself:

{
  "date": "2026-09-14",
  "status": "draft",
  "blocks": [
    { "start": "07:00", "end": "07:15", "type": "anchor", "title": "Wake", "task_ids": [], "source_rule": "wake" },
    { "start": "09:00", "end": "09:50", "type": "fixed_event", "title": "ESI 4606 Lecture", "task_ids": [], "source_rule": "fixed_event:<id>" },
    { "start": "10:00", "end": "12:00", "type": "School", "title": "School focus block", "task_ids": ["<id>", "<id>"], "source_rule": "rule:school-window" }
  ],
  "quote_used": "discipline-equals-freedom",
  "carried_over": ["<task_id>"],
  "pushed": [{ "task_id": "<task_id>", "reason": "no_room" }]
}
Brief + questions — one call sends the Telegram short-form brief (the route appends the [Replan now] button itself) and persists brief_questions:

node jea.mjs brief send --file <path-to-brief.json> --confirm
Shape, reconciled against app/api/brief/route.ts: the route takes a single pre-composed telegram_text string — not separate greeting/summary_lines/quote fields, which it does not accept. Compose the greeting, 2–3 summary lines, the quote, and (if any) the numbered questions into one string before calling this. questions[].kind must be one of deadline | rollover | backlog | open:

{
  "date": "2026-09-14",
  "telegram_text": "Morning.\n\nTwo classes today, gym at 2, dinner runs long with the MW lab. Backlog's clean except one Signal Spring follow-up.\n\n\"Discipline equals freedom.\" — Jocko Willink\n\n1. Pushing 'ESI problem set 4' today misses its due date — bump something else, or accept the miss?\n2. 'Email Jim re: resume review' has rolled 3 days running — still doing this, or drop it?\n3. Anything you're planning today that isn't on the dashboard?",
  "questions": [
    { "kind": "deadline", "question": "Pushing 'ESI problem set 4' today misses its due date — bump something else, or accept the miss?" },
    { "kind": "rollover", "question": "'Email Jim re: resume review' has rolled 3 days running — still doing this, or drop it?" },
    { "kind": "open", "question": "Anything you're planning today that isn't on the dashboard?" }
  ]
}
Never write the calendar. No route in _meta/bridge-contract.md for calendar writes is called from this skill — that's replan-day (B2.4, Part 2) and the 9:00-cutoff cron, both outside this skill's job.

Verified live, 2026-09-12
Migrations 0024_neptune_day_plans.sql and 0025_task_block_type.sql are applied — day-rules list, day-plans get, and tasks today's block_type field all confirmed working against the real Supabase database, not just reviewed in code. day-plans get correctly returns "no plan" rather than a 500 for a date with no row yet.

Open dependencies
Weather has no contracted jea route. The dashboard already shows live date/weather in its own header (reverse-geocoded), so this may arrive for free once the dashboard side wires it into the day-plans/brief payload — until then this skill degrades gracefully by omitting the line.
The seeded School day_rules row has no window_start/window_end (confirmed by the dashboard session, not just inferred) — it's an intentional unconstrained placeholder, but re-check it reads sanely once this skill runs against real data.
No created-at timestamp on tasks — "backlog item sitting too long" (by age) still isn't computable; only the blocked: true half of that question source is real today.
