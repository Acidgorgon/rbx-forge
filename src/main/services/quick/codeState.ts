// userData/code/state.json: which quick versions are bad and which one is starting right now
// (pure transitions + small sync file helpers; no electron imports; tested).
//
// The bootstrap sets `booting` before it loads a quick version, and the app clears it once its
// window has loaded (markBooted). A `booting` still set at the next launch means that version never
// finished starting (crash, hang, blank window), so it is marked bad and the bundled code runs.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface CodeState {
  bad: Record<string, { reason: string; at: number }>
  booting?: { version: string; at: number }
  // Settings > Updates > Quick updates is off: boot the installed app's own code.
  disabled?: boolean
}

const MAX_BAD = 50

export function emptyCodeState(): CodeState {
  return { bad: {} }
}

export function parseCodeState(text: string | null | undefined): CodeState {
  const state = emptyCodeState()
  if (!text) return state
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    return state
  }
  if (!raw || typeof raw !== 'object') return state
  if (raw.bad && typeof raw.bad === 'object') {
    for (const [version, entry] of Object.entries(raw.bad as Record<string, any>)) {
      if (entry && typeof entry.reason === 'string') state.bad[version] = { reason: entry.reason, at: Number(entry.at) || 0 }
    }
  }
  if (raw.booting && typeof raw.booting.version === 'string') state.booting = { version: raw.booting.version, at: Number(raw.booting.at) || 0 }
  if (raw.disabled === true) state.disabled = true
  return state
}

export function isBad(state: CodeState, version: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.bad, version)
}

export function markBad(state: CodeState, version: string, reason: string, now: number): CodeState {
  const bad = { ...state.bad, [version]: { reason: reason.slice(0, 500), at: now } }
  // Keep the newest entries only.
  const keys = Object.keys(bad).sort((a, b) => bad[b].at - bad[a].at)
  for (const key of keys.slice(MAX_BAD)) delete bad[key]
  const next: CodeState = { ...state, bad }
  if (next.booting?.version === version) delete next.booting
  return next
}

export function beginBoot(state: CodeState, version: string, now: number): CodeState {
  return { ...state, booting: { version, at: now } }
}

// Clears the marker when it belongs to `version` (a newer launch may have replaced it).
export function finishBoot(state: CodeState, version: string): CodeState {
  if (state.booting?.version !== version) return state
  const next = { ...state }
  delete next.booting
  return next
}

// At launch: a marker left by the previous launch means that version failed to boot.
export function recoverInterruptedBoot(state: CodeState, now: number): { state: CodeState; failed: string | null } {
  if (!state.booting) return { state, failed: null }
  const version = state.booting.version
  return { state: markBad(state, version, 'did not finish starting (crashed, hung or showed no window)', now), failed: version }
}

export function setDisabled(state: CodeState, disabled: boolean): CodeState {
  const next = { ...state }
  if (disabled) next.disabled = true
  else delete next.disabled
  return next
}

export function readCodeState(file: string): CodeState {
  try {
    return parseCodeState(readFileSync(file, 'utf8'))
  } catch {
    return emptyCodeState()
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Atomic write (temp file + rename), retrying the rename while Windows has the file open.
export function writeCodeState(file: string, state: CodeState): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`)
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      sleepSync(10 + i * 10)
    }
  }
}

// Read, change and write in one step.
export function updateCodeState(file: string, change: (state: CodeState) => CodeState): CodeState {
  const next = change(readCodeState(file))
  writeCodeState(file, next)
  return next
}
