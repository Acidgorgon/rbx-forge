// How the titlebar Serve button and the status bar show rojo serve (no electron, no React; tested in
// test/rojoRestart.test.ts). A serve held by the Forge Sync gate is its own state, not "Starting",
// so a held rojo never looks like it is about to come up on its own.
import type { RojoPlaceStatus, ServiceStatus } from './types.ts'

export type ServeKind = 'running' | 'starting' | 'checking' | 'waiting' | 'held' | 'crashed' | 'failed' | 'stopped'

export interface ServeView {
  kind: ServeKind
  label: string
  title: string
  // Served places (other than the active one) that are not serving, or that need Rojo connected again
  // in Studio: "Serving FSF · Menu held" instead of a plain "Serving".
  attention?: RojoPlaceStatus[]
}

const PLACE_WORD: Record<RojoPlaceStatus['state'], string> = {
  serving: 'serving',
  starting: 'starting',
  checking: 'checking',
  waiting: 'waiting',
  held: 'held',
  crashed: 'restarting',
  'gave-up': 'crashed',
  stopped: 'stopped'
}

// "Menu held", "Menu crashed: port 34875 is in use by another process (old rojo?)", "Menu reconnect Rojo".
export function placeServeText(p: RojoPlaceStatus, long = false): string {
  const word = p.state === 'serving' && p.reconnect ? 'reconnect Rojo' : PLACE_WORD[p.state]
  return `${p.name} ${word}${long && p.port ? ` (:${p.port})` : ''}${long && p.error ? `: ${p.error}` : ''}`
}

function attentionOf(s: ServiceStatus): RojoPlaceStatus[] {
  return (s.places ?? []).filter((p) => (!p.primary && p.state !== 'serving') || p.reconnect)
}

function withPlaces(view: ServeView, s: ServiceStatus): ServeView {
  const attention = attentionOf(s)
  if (!s.places?.length) return view
  const lines = s.places.map((p) => `${p.primary ? '● ' : '○ '}${placeServeText(p, true)}`).join('\n')
  const primary = s.places.find((p) => p.primary)
  const parts = attention.map((p) => (p.primary ? 'reconnect Rojo' : placeServeText(p)))
  const label = attention.length && view.kind === 'running' ? `${view.label}${primary ? ` ${primary.name}` : ''} · ${parts.join(' · ')}` : view.label
  return { ...view, label, title: `${view.title}\n${lines}`, ...(attention.length ? { attention } : {}) }
}

// "default.project.json: 2 conflicts: resolve or serve anyway (default.project.json)" -> the reason.
function holdReason(s: ServiceStatus): string {
  return (s.detail ?? '').replace(/\s*\([^)]*\.project\.json\)$/, '')
}

export function serveView(s: ServiceStatus | undefined, port: number): ServeView {
  if (!s) return { kind: 'stopped', label: 'Serve', title: 'Start rojo serve' }
  return withPlaces(baseView(s, port), s)
}

function baseView(s: ServiceStatus, port: number): ServeView {
  if (s.hold?.gate === 'blocked') {
    return { kind: 'held', label: 'Held', title: `Rojo is held for ${s.hold.file}: ${holdReason(s) || 'Studio sync conflicts'}. Click to resolve or serve anyway` }
  }
  if (s.hold?.gate === 'waiting') {
    const why = s.hold.reason === 'unlinked' ? "Studio's open place isn't linked to this project" : s.hold.reason === 'plugin' ? 'Studio runs an older Forge Bridge plugin (restart Studio)' : "no Studio sync check yet"
    return { kind: 'waiting', label: 'Waiting', title: `Rojo waits for Studio's first sync check of ${s.hold.file}: ${why}. Click for options` }
  }
  if (s.hold?.gate === 'checking') {
    return { kind: 'checking', label: 'Checking', title: `Rojo waits for the Studio sync check of ${s.hold.file}. Click for options` }
  }
  if (s.state === 'running') return { kind: 'running', label: 'Serving', title: `Rojo is serving on :${port} · click to restart` }
  if (s.state === 'crashed' && s.gaveUp) return { kind: 'failed', label: 'Crashed', title: `${s.detail ?? 'Rojo keeps crashing'} · click to restart` }
  if (s.state === 'crashed') return { kind: 'crashed', label: 'Restarting', title: `${s.detail ?? 'Rojo crashed'} · click to restart now` }
  if (s.state === 'starting') return { kind: 'starting', label: 'Starting', title: s.detail ?? 'Starting rojo serve' }
  return { kind: 'stopped', label: 'Serve', title: s.state === 'missing' ? s.detail ?? 'rojo not found' : 'Start rojo serve' }
}

// One-off notices when rojo's status changes (the titlebar shows them as toasts). `announced` is the
// restart count already announced (restarts resets to 0 when the user starts rojo).
export type ServeNotice =
  | { kind: 'restarted' }
  | { kind: 'gave-up'; detail: string }
  | { kind: 'held'; file: string; detail: string }
  // Waiting because Studio has a place open that Forge cannot check (not linked, or an old plugin).
  | { kind: 'unchecked'; file: string; reason: 'unlinked' | 'plugin'; detail: string }

export function serveNotice(prev: ServiceStatus | undefined, next: ServiceStatus | undefined, announced: number): { notice: ServeNotice | null; announced: number } {
  if (!next) return { notice: null, announced: 0 }
  const base = Math.min(announced, next.restarts)
  if (next.hold?.gate === 'blocked' && prev?.hold?.gate !== 'blocked') return { notice: { kind: 'held', file: next.hold.file, detail: holdReason(next) }, announced: base }
  const reason = next.hold?.gate === 'waiting' ? next.hold.reason : undefined
  if ((reason === 'unlinked' || reason === 'plugin') && !(prev?.hold?.gate === 'waiting' && prev.hold.reason === reason)) {
    return { notice: { kind: 'unchecked', file: next.hold!.file, reason, detail: holdReason(next) }, announced: base }
  }
  if (next.gaveUp && !prev?.gaveUp) return { notice: { kind: 'gave-up', detail: next.detail ?? '' }, announced: next.restarts }
  if (next.state === 'running' && next.restarts > base) return { notice: { kind: 'restarted' }, announced: next.restarts }
  return { notice: null, announced: base }
}
