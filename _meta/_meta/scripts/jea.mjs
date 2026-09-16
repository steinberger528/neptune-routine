#!/usr/bin/env node
// The bridge: a vault session or scheduled task reads/writes JEA dashboard state over
// its authenticated HTTP API (never Supabase directly — that's ideas-push.mjs and
// fixed-events-push.mjs's job for bulk vault->Supabase pushes). Contract, scope, and
// the reasoning for CLI-over-MCP: _meta/bridge-contract.md and
// _meta/specs/2026-08-31-block-1-bridge-design.md (Agentic OS build plan, B1).
//
// Usage: node jea.mjs <group> <command> [flags] --env <path-to-JEA-.env>
//   Reads run immediately. Writes require --confirm or print what they would have
//   sent and exit 2. --dry-run always prints the request and exits without sending.
//   --json prints the raw API response; default is a compact human-readable line.
//   --base-url overrides DASHBOARD_URL from --env (e.g. for local dev).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendLog } from './log-append.mjs'

process.on('unhandledRejection', (err) => {
  appendLog('jea-bridge', `ERROR · ${err?.message || err}`)
  console.error(`jea: ${err?.message || err}`)
  process.exit(1)
})

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

const argv = process.argv.slice(2)
const { positional, flags } = parseArgs(argv)
const [group, command, ...rest] = positional

function usageAndExit(code) {
  console.error(`Usage: node jea.mjs <group> <command> [flags] --env <path-to-JEA-.env>

Reads:
  tasks today
  tasks backlog
  fixed-events list
  school overview
  calendar range --start <YYYY-MM-DD> --end <YYYY-MM-DD>
  day-rules list
  day-plans get --date <YYYY-MM-DD>

Writes (require --confirm; --dry-run prints the request and exits):
  tasks create --title <text> [--urgency today|someday] [--due <YYYY-MM-DD>]
  tasks update <id> [--completed] [--due <YYYY-MM-DD>] [--in-progress]
  school task create --title <text> --item-type <type> [--due <YYYY-MM-DD>] [--component <group|individual>]
  day-plans put --file <path-to-json>
  brief send --file <path-to-json>

Flags: --env <path> (or --base-url / DASHBOARD_URL+AUTH_SECRET env vars — the latter
  is how a cloud routine authenticates, since it has no local JEA .env to point at)
  · --json · --dry-run · --confirm`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

function readEnvFile(envPath) {
  const env = {}
  const text = fs.readFileSync(envPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)\s*=\s*["']?([^"'\r\n]*)["']?\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}

function resolveConfig() {
  let fileEnv = {}
  if (flags.env) {
    if (!fs.existsSync(flags.env)) {
      console.error(`jea: --env file not found: ${flags.env}`)
      process.exit(1)
    }
    fileEnv = readEnvFile(flags.env)
  }

  // Falls back to process.env when no --env file is given: a cloud routine clones the
  // vault's GitHub repo, not the dashboard repo, so it has no local JEA .env to read —
  // DASHBOARD_URL / AUTH_SECRET are set as routine secrets instead (Neptune's B2.3 brief).
  const baseUrl = (flags['base-url'] || fileEnv.DASHBOARD_URL || process.env.DASHBOARD_URL || '').replace(/\/+$/, '')
  const authSecret = fileEnv.AUTH_SECRET || process.env.AUTH_SECRET

  if (!baseUrl) {
    console.error('jea: no base URL. Pass --base-url, set DASHBOARD_URL in the --env file, or export DASHBOARD_URL.')
    process.exit(1)
  }
  if (!authSecret) {
    console.error('jea: no AUTH_SECRET found. Pass --env, or export AUTH_SECRET.')
    process.exit(1)
  }

  return { baseUrl, authSecret }
}

// ---------------------------------------------------------------------------
// Request layer
// ---------------------------------------------------------------------------

async function request({ baseUrl, authSecret }, method, route, { query, body } = {}) {
  const url = new URL(baseUrl + route)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v)
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        'x-api-secret': authSecret,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') {
      console.error(`jea: request timed out after 15s — ${method} ${route}`)
    } else {
      console.error(`jea: dashboard unreachable at ${baseUrl} — ${err.message}`)
    }
    process.exit(1)
  }
  clearTimeout(timeout)

  if (res.status === 401) {
    console.error('jea: auth rejected (401) — check AUTH_SECRET matches the dashboard\'s value.')
    process.exit(1)
  }
  if (res.status === 404) {
    console.error(`jea: route not found (404) — ${method} ${route}. Has the dashboard API changed?`)
    process.exit(1)
  }
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = j.error ? ` — ${j.error}` : ''
    } catch {
      // non-JSON error body (e.g. an HTML error page) — omit detail rather than dump it
    }
    console.error(`jea: request failed (${res.status})${detail} — ${method} ${route}`)
    process.exit(1)
  }

  return res.json()
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function output(data, formatter) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(formatter(data))
  }
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`jea: file not found: ${filePath}`)
    process.exit(1)
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    console.error(`jea: invalid JSON in ${filePath} — ${err.message}`)
    process.exit(1)
  }
}

function requireWriteConfirmation(describeFn) {
  const description = describeFn()
  if (flags['dry-run']) {
    console.log(`[dry-run] ${description}`)
    process.exit(0)
  }
  if (!flags.confirm) {
    console.log(`[not sent — pass --confirm to write] ${description}`)
    process.exit(2)
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdTasksToday(cfg) {
  const data = await request(cfg, 'GET', '/api/tasks/today')
  output(data, (d) => {
    const overdue = d.overdue ?? []
    const today = d.today_tasks ?? []
    if (!overdue.length && !today.length) return 'No tasks due today.'
    const line = (t) => `${t.id.slice(0, 8)}  ${(t.block_type || '—').padEnd(8)} ${t.due_date || '—'}  ${t.title}`
    const lines = []
    if (overdue.length) lines.push('Overdue:', ...overdue.map(line))
    if (today.length) lines.push('Today:', ...today.map(line))
    return lines.join('\n')
  })
}

async function cmdTasksBacklog(cfg) {
  const data = await request(cfg, 'GET', '/api/tasks/backlog')
  output(data, (d) => {
    if (!d.tasks?.length) return 'Backlog is empty.'
    return d.tasks.map((t) => `${t.id.slice(0, 8)}  ${t.title}`).join('\n')
  })
}

async function cmdTasksCreate(cfg) {
  const title = flags.title
  if (!title) {
    console.error('jea: tasks create requires --title')
    process.exit(1)
  }
  const urgency = flags.urgency
  if (urgency && !['today', 'someday'].includes(urgency)) {
    console.error('jea: --urgency must be "today" or "someday"')
    process.exit(1)
  }
  const body = { title, ...(urgency ? { urgency } : {}), ...(flags.due ? { due_date: flags.due } : {}) }

  requireWriteConfirmation(() => `POST /api/tasks ${JSON.stringify(body)}`)

  const data = await request(cfg, 'POST', '/api/tasks', { body })
  appendLog('jea-bridge', `tasks create · ${title} · id ${data.id}`)
  output(data, (d) => `Created task ${d.id}`)
}

async function cmdTasksUpdate(cfg) {
  const id = rest[0]
  if (!id) {
    console.error('jea: tasks update requires an id, e.g. `tasks update <id> --completed`')
    process.exit(1)
  }
  const body = {}
  if (flags.completed !== undefined) body.completed = flags.completed !== 'false'
  if (flags.due !== undefined) body.due_date = flags.due
  if (flags['in-progress'] !== undefined) body.in_progress = flags['in-progress'] !== 'false'

  if (Object.keys(body).length === 0) {
    console.error('jea: tasks update requires at least one of --completed, --due, --in-progress')
    process.exit(1)
  }

  requireWriteConfirmation(() => `PATCH /api/tasks/${id} ${JSON.stringify(body)}`)

  await request(cfg, 'PATCH', `/api/tasks/${id}`, { body })
  appendLog('jea-bridge', `tasks update · ${id} · ${JSON.stringify(body)}`)
  output({ ok: true, id }, () => `Updated task ${id}`)
}

async function cmdFixedEventsList(cfg) {
  const data = await request(cfg, 'GET', '/api/fixed-events')
  output(data, (d) => {
    if (!d.fixed_events?.length) return 'No fixed events.'
    return d.fixed_events
      .map((e) => `${e.days.join(',')}  ${e.start}-${e.end}  ${e.kind.padEnd(9)} ${e.label}  (${e.source})`)
      .join('\n')
  })
}

async function cmdSchoolOverview(cfg) {
  const data = await request(cfg, 'GET', '/api/school/overview')
  output(data, (d) => {
    const courseCount = d.courses?.length ?? 0
    const openTasks = (d.tasks ?? []).filter((t) => !t.completed_at)
    const lines = [`${courseCount} course(s), ${openTasks.length} open item(s).`]
    for (const t of openTasks.slice(0, 20)) {
      lines.push(`  ${t.id.slice(0, 8)}  ${(t.item_type || '').padEnd(10)} ${t.due_date || '—'}  ${t.title}`)
    }
    return lines.join('\n')
  })
}

async function cmdSchoolTaskCreate(cfg) {
  const title = flags.title
  const itemType = flags['item-type']
  if (!title || !itemType) {
    console.error('jea: school task create requires --title and --item-type')
    process.exit(1)
  }
  const body = {
    title,
    item_type: itemType,
    ...(flags.due ? { due_date: flags.due } : {}),
    ...(flags.component ? { component: flags.component } : {}),
  }

  requireWriteConfirmation(() => `POST /api/school/tasks ${JSON.stringify(body)}`)

  const data = await request(cfg, 'POST', '/api/school/tasks', { body })
  appendLog('jea-bridge', `school task create · ${title} · id ${data.task?.id}`)
  output(data, (d) => `Created school task ${d.task?.id}`)
}

async function cmdCalendarRange(cfg) {
  if (!flags.start || !flags.end) {
    console.error('jea: calendar range requires --start and --end (YYYY-MM-DD)')
    process.exit(1)
  }
  const data = await request(cfg, 'GET', '/api/calendar', { query: { start: flags.start, end: flags.end } })
  output(data, (d) => JSON.stringify(d, null, 2))
}

async function cmdDayRulesList(cfg) {
  const data = await request(cfg, 'GET', '/api/day-rules')
  output(data, (d) => {
    if (!d.day_rules?.length) return 'No day rules.'
    return d.day_rules
      .map((r) => {
        const days = (r.days || []).join(',').padEnd(9)
        const kind = (r.kind || '').padEnd(7)
        const dur = r.duration_min ? `${String(r.duration_min).padStart(3)}m` : '   '
        const type = r.block_type ? ` [${r.block_type}]` : ''
        const inactive = r.active === false ? '  (inactive)' : ''
        return `${days} ${kind} ${dur}${type}  ${r.label}${inactive}`
      })
      .join('\n')
  })
}

async function cmdDayPlansGet(cfg) {
  if (!flags.date) {
    console.error('jea: day-plans get requires --date (YYYY-MM-DD)')
    process.exit(1)
  }
  const data = await request(cfg, 'GET', '/api/day-plans', { query: { date: flags.date } })
  output(data, (d) => {
    if (!d.day_plan) return `No plan for ${flags.date}.`
    const p = d.day_plan
    return `${p.date}  ${p.status}  ${p.blocks?.length ?? 0} block(s)${p.quote_used ? `  quote: ${p.quote_used}` : ''}`
  })
}

async function cmdDayPlansPut(cfg) {
  const filePath = flags.file
  if (!filePath) {
    console.error('jea: day-plans put requires --file <path-to-json>')
    process.exit(1)
  }
  const body = readJsonFile(filePath)
  if (!body.date) {
    console.error('jea: day-plans put file must include a "date" field')
    process.exit(1)
  }

  requireWriteConfirmation(() => `POST /api/day-plans · ${body.date} · status ${body.status || '?'} · ${body.blocks?.length ?? 0} block(s)`)

  const data = await request(cfg, 'POST', '/api/day-plans', { body })
  appendLog('jea-bridge', `day-plans put · ${body.date} · status ${body.status || '?'} · ${body.blocks?.length ?? 0} block(s)`)
  output(data, () => `Wrote day plan for ${body.date} (${body.status || '?'})`)
}

async function cmdBriefSend(cfg) {
  const filePath = flags.file
  if (!filePath) {
    console.error('jea: brief send requires --file <path-to-json>')
    process.exit(1)
  }
  const body = readJsonFile(filePath)
  if (!body.date) {
    console.error('jea: brief send file must include a "date" field')
    process.exit(1)
  }

  requireWriteConfirmation(() => `POST /api/brief · ${body.date} · ${body.questions?.length ?? 0} question(s)`)

  const data = await request(cfg, 'POST', '/api/brief', { body })
  appendLog('jea-bridge', `brief send · ${body.date} · ${body.questions?.length ?? 0} question(s)`)
  output(data, () => `Sent brief for ${body.date}`)
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const ROUTES = {
  'tasks today': cmdTasksToday,
  'tasks backlog': cmdTasksBacklog,
  'tasks create': cmdTasksCreate,
  'tasks update': cmdTasksUpdate,
  'fixed-events list': cmdFixedEventsList,
  'school overview': cmdSchoolOverview,
  'school task create': cmdSchoolTaskCreate,
  'calendar range': cmdCalendarRange,
  'day-rules list': cmdDayRulesList,
  'day-plans get': cmdDayPlansGet,
  'day-plans put': cmdDayPlansPut,
  'brief send': cmdBriefSend,
}

async function main() {
  if (!group || !command) usageAndExit(1)
  const key = `${group} ${command}`
  const handler = ROUTES[key]
  if (!handler) {
    console.error(`jea: unknown command "${key}"`)
    usageAndExit(1)
  }
  const cfg = resolveConfig()
  await handler(cfg)
}

main()
