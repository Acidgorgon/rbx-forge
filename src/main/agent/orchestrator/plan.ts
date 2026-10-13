// Plan validation and DAG helpers.
//
// Rules: 1..maxTasks tasks; unique ids; specialist roles only; non-empty goals; dependsOn names
// existing other tasks; no cycles; writer tasks (builder, tester) never list hot files; two writer
// tasks whose files overlap must be ordered by dependsOn (one an ancestor of the other), since
// claims are held for a task's whole run. Builders need at least one file.

import { normalizePath, overlaps } from './locks.ts'
import { ROLE_DEFAULTS } from './roles.ts'
import { SPECIALIST_ROLES, type Plan, type PlanTask, type PlanValidation } from './types.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/

export interface ValidateOptions {
  maxTasks: number
  hotFiles: string[]
  // Ids already used by earlier rounds of the same run: not reusable, but valid (finished) deps.
  takenIds?: Iterable<string>
}

export function validatePlan(input: unknown, opts: ValidateOptions): PlanValidation {
  const errors: string[] = []
  const raw = (input && typeof input === 'object' ? (input as { tasks?: unknown; notes?: unknown }) : {}) as { tasks?: unknown; notes?: unknown }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) return { ok: false, errors: ['plan needs at least one task'] }
  if (raw.tasks.length > opts.maxTasks) errors.push(`plan has ${raw.tasks.length} tasks; the limit is ${opts.maxTasks}`)

  const taken = new Set(opts.takenIds ?? [])
  const hot = opts.hotFiles.map((h) => normalizePath(h)).filter((h): h is string => !!h)
  const tasks: PlanTask[] = []
  const seen = new Set<string>()

  for (const [i, t] of (raw.tasks as unknown[]).entries()) {
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    const label = id || `#${i + 1}`
    if (!ID.test(id)) errors.push(`task ${label}: id must be 1-40 letters, digits, _ . -`)
    else if (seen.has(id)) errors.push(`task ${id}: duplicate id`)
    else if (taken.has(id)) errors.push(`task ${id}: id already used in an earlier round`)
    seen.add(id)
    const role = o.role as PlanTask['role']
    if (!SPECIALIST_ROLES.includes(role)) errors.push(`task ${label}: role must be one of ${SPECIALIST_ROLES.join(', ')}`)
    const goal = typeof o.goal === 'string' ? o.goal.trim() : ''
    if (!goal) errors.push(`task ${label}: goal is empty`)
    const files: string[] = []
    for (const f of Array.isArray(o.files) ? o.files : []) {
      const n = typeof f === 'string' ? normalizePath(f) : null
      if (!n) errors.push(`task ${label}: file ${JSON.stringify(f)} is not a path inside the project`)
      else if (!files.includes(n)) files.push(n)
    }
    const dependsOn = [...new Set((Array.isArray(o.dependsOn) ? o.dependsOn : []).filter((d): d is string => typeof d === 'string').map((d) => d.trim()))]
    const writer = SPECIALIST_ROLES.includes(role) && ROLE_DEFAULTS[role].writer
    if (writer) {
      for (const f of files) {
        const h = hot.find((x) => overlaps(x, f))
        if (h) errors.push(`task ${label}: ${h} is a shared file only the lead edits; drop it and have the ${role} call request_change`)
      }
    }
    if (role === 'builder' && files.length === 0) errors.push(`task ${label}: a builder needs the files it will edit`)
    tasks.push({ id, role, goal, files, dependsOn })
  }

  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) errors.push(`task ${t.id}: depends on itself`)
      else if (!ids.has(d) && !taken.has(d)) errors.push(`task ${t.id}: depends on unknown task ${d}`)
    }
  }
  if (errors.length) return { ok: false, errors }

  const cycle = findCycle(tasks)
  if (cycle) return { ok: false, errors: [`dependency cycle: ${cycle.join(' -> ')}`] }

  const anc = ancestors(tasks)
  const writers = tasks.filter((t) => ROLE_DEFAULTS[t.role].writer)
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i]
      const b = writers[j]
      if (anc.get(a.id)!.has(b.id) || anc.get(b.id)!.has(a.id)) continue
      for (const fa of a.files) {
        const fb = b.files.find((x) => overlaps(fa, x))
        if (fb) errors.push(`tasks ${a.id} and ${b.id} (${a.role}, ${b.role}) both edit ${fa === fb ? fa : `${fa} / ${fb}`}; give each file to one task or order them with dependsOn`)
      }
    }
  }
  if (errors.length) return { ok: false, errors }

  const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim() : undefined
  return { ok: true, plan: { tasks, ...(notes ? { notes } : {}) }, order: topoOrder(tasks) }
}

// First cycle found, as a closed path of ids (a -> b -> a), or null.
export function findCycle(tasks: Pick<PlanTask, 'id' | 'dependsOn'>[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]))
  const state = new Map<string, 1 | 2>() // 1 visiting, 2 done
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    const s = state.get(id)
    if (s === 2) return null
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id]
    state.set(id, 1)
    stack.push(id)
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue
      const c = visit(d)
      if (c) return c
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const t of tasks) {
    const c = visit(t.id)
    if (c) return c
  }
  return null
}

// Transitive dependencies of every task (assumes no cycles).
export function ancestors(tasks: Pick<PlanTask, 'id' | 'dependsOn'>[]): Map<string, Set<string>> {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]))
  const memo = new Map<string, Set<string>>()
  const get = (id: string): Set<string> => {
    const m = memo.get(id)
    if (m) return m
    const out = new Set<string>()
    memo.set(id, out)
    for (const d of deps.get(id) ?? []) {
      out.add(d)
      for (const x of get(d)) out.add(x)
    }
    return out
  }
  for (const t of tasks) get(t.id)
  return memo
}

// Kahn's order, stable by plan order among ready tasks. Deps outside `tasks` count as finished.
export function topoOrder(tasks: Pick<PlanTask, 'id' | 'dependsOn'>[]): string[] {
  const ids = new Set(tasks.map((t) => t.id))
  const done = new Set<string>()
  const out: string[] = []
  while (out.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d) || !ids.has(d)))
    if (!next) break
    done.add(next.id)
    out.push(next.id)
  }
  return out
}

// One line per error, for the submit_plan tool result.
export function planErrorText(errors: string[]): string {
  return `Plan rejected; fix and call submit_plan again:\n- ${errors.join('\n- ')}`
}

export function planSummary(plan: Plan): string {
  return plan.tasks
    .map((t) => `${t.id} [${t.role}] ${t.goal}${t.files.length ? ` (files: ${t.files.join(', ')})` : ''}${t.dependsOn.length ? ` after ${t.dependsOn.join(', ')}` : ''}`)
    .join('\n')
}
