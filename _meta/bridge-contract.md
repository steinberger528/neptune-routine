The bridge contract
What _meta/scripts/jea.mjs may call on the JEA dashboard's /api/* surface, and what it deliberately does not. Design: _meta/specs/2026-08-31-block-1-bridge-design.md (Agentic OS build plan, B1) and _meta/specs/2026-09-11-block-2-neptune-design.md (Block 2). The dashboard has 44+ routes total; twelve are in scope.

Base URL: https://justin-os-nine.vercel.app (or --base-url for local dev). Auth: x-api-secret header, same AUTH_SECRET the dashboard already accepts for cron/CLI access (lib/api-auth.ts, proxy.ts in the JEA repo).

In scope
Command	Route	Method	Access
tasks today	/api/tasks/today	GET	read
tasks backlog	/api/tasks/backlog	GET	read
tasks create	/api/tasks	POST	write
tasks update <id>	/api/tasks/[id]	PATCH	write
fixed-events list	/api/fixed-events	GET	read
school overview	/api/school/overview	GET	read
school task create	/api/school/tasks	POST	write
calendar range	/api/calendar	GET	read
day-rules list	/api/day-rules	GET	read
day-plans get	/api/day-plans?date=	GET	read
day-plans put	/api/day-plans	POST	write
brief send	/api/brief	POST	write
Chosen because this is what B2's build-day/replan-day skills need to read the shape of a day (open tasks, fixed constraints, school load, calendar) and write back into it (new tasks, status/due-date/focus changes). Nothing here is speculative — every command maps to a named step in _meta/agentic-os-build-plan.md Block 2 or 3.

The last four rows are B2.11/B2.2/B2.3 additions (2026-09-11), reconciled 2026-09-12 against the dashboard session's landed code. day-plans put and brief send are schema-agnostic passthroughs — jea.mjs reads the --file JSON and sends it verbatim as the request body (only checking it carries a date field, for the log line), rather than hardcoding day_plans/brief field names into the CLI. That keeps the vault's client decoupled from the dashboard route's exact request shape. day-plans put is a POST (not PUT — corrected 2026-09-12 after reading the real route), which upserts the one row per date on conflict (user_id, date), per D2. brief send's body must be { date, telegram_text, questions: [{ kind, question }] } — telegram_text is the fully composed message string (greeting, summary lines, quote, questions); the route appends the [Replan now] button itself and does not accept separate greeting/summary_lines/ quote fields. build-day's SKILL.md carries the reconciled shapes.

Auth for the 6:45 cloud routine. A cloud routine clones the vault's GitHub repo, not the dashboard repo, so it has no local JEA .env to pass via --env. jea.mjs now also reads DASHBOARD_URL / AUTH_SECRET from the process environment when --env is omitted — set as routine secrets when Justin creates the 6:45 routine on claude.ai, not committed anywhere.

Not live yet. All four routes exist in code (app/api/day-rules, app/api/day-plans, app/api/brief, dashboard repo) but migrations 0024_neptune_day_plans.sql and 0025_task_block_type.sql have not been applied to the live Supabase database — this project never auto-applies migrations. Every call above 500s until Justin applies both by hand via the Supabase dashboard.

Out of scope, and why
crm/* (14 routes: briefings, business-metrics, clients, escalations, ingest, jobs, messages, overview) — Signal Spring's own boundary. Not a vault-session concern; add to a different contract if Signal Spring ever needs a bridge of its own.
capture, session/chat, telegram/webhook, auth/login, auth/logout — the dashboard's own inbound surface (Telegram, browser login, the session chat pipeline). The vault calls the dashboard; it doesn't impersonate these entry points.
goals/*, habits/*, journal/*, ideas/*, nutrition/*, calendar/reschedule, tasks/[id] DELETE-equivalents, tasks/planner, tasks/rollover, tasks/schedule — no build-plan step through Block 3 reads or writes these via the bridge. ideas/* and nutrition/sync already have their own one-way vault→Supabase or cron paths (ideas-push.mjs, the Vercel cron in vercel.json) and don't need a second one. tasks/schedule specifically triggers the dashboard's own AI scheduling agent rather than doing a plain read/write — B2.2's build-day is meant to replace that logic, not call through to it.
Adding a route: when a build-plan step actually needs one of these, add it here with its access level and the step that needs it, then add the command to jea.mjs's command table. This file is the boundary — a route the CLI doesn't implement can't be called from a vault session no matter what a prompt asks for.
