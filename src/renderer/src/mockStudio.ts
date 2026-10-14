// Browser-preview mock of StudioApi: a fake Forge Bridge connection and Studio check that returns SVG
// "Studio" and "preview" frames, so the Studio check UI renders without Electron or Studio.
// ?studio=ready (default) | offline | noplugin | outdated | nocapture
import type { HarnessEvents, StudioApi, StudioCheckKind, StudioCheckRecord, StudioStatus } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

function frame(kind: 'studio' | 'preview', label: string, i: number): string {
  const studio = kind === 'studio'
  const bg = studio ? '#20242a' : '#0b0d10'
  const floor = studio ? '#2c3036' : '#14171b'
  const glow = ['#7d6bff', '#4fb4ff', '#ff6b4a', '#ffd166', '#a0ffb0', '#ff8ad8'][i % 6]
  const r = 26 + i * 9
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="300" viewBox="0 0 512 300"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset=".3" stop-color="${glow}" stop-opacity=".9"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient></defs><rect width="512" height="300" fill="${bg}"/><rect y="210" width="512" height="90" fill="${floor}"/><rect x="236" y="120" width="40" height="92" rx="6" fill="${studio ? '#a3a8b0' : '#6b7079'}"/><circle cx="256" cy="106" r="16" fill="${studio ? '#c9a27e' : '#7a7f88'}"/><ellipse cx="${300 + i * 10}" cy="${150 - i * 4}" rx="${r * 1.6}" ry="${r}" fill="url(#g)"/><text x="10" y="290" font-family="monospace" font-size="12" fill="#8b929c">${studio ? 'Roblox Studio' : 'preview'} · ${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export function studioMock(emit: Emit): StudioApi {
  const mode = new URLSearchParams(location.search).get('studio') ?? 'ready'
  let prefer = false
  let installed = mode !== 'noplugin'
  const files = new Map<string, string>()
  const checks = new Map<string, StudioCheckRecord>()
  const status = (): StudioStatus => {
    const connected = installed && (mode === 'ready' || mode === 'nocapture' || mode === 'outdated')
    const base: StudioStatus = {
      state: 'ready',
      message: 'Connected to MyGame · recording "MyGame - Roblox Studio".',
      server: { port: 34877, listening: true },
      plugin: { installed, dir: 'C:\\Users\\acid\\AppData\\Local\\Roblox\\Plugins', file: 'C:\\Users\\acid\\AppData\\Local\\Roblox\\Plugins\\ForgeBridge.rbxmx', ...(installed ? { version: mode === 'outdated' ? 0 : 1 } : {}), bundled: 1, ...(mode === 'outdated' ? { outdated: true } : {}) },
      studio: { connected, ...(connected ? { lastSeen: Date.now(), place: 'MyGame', placeId: 1234, pluginVersion: mode === 'outdated' ? 0 : 1 } : {}) },
      capture: mode === 'nocapture' ? { available: false, hint: 'No Roblox Studio window to record: open Studio and keep its window visible (not minimised) during the check.' } : { available: connected, ...(connected ? { window: 'MyGame - Roblox Studio' } : {}) },
      rojo: 'running',
      prefer
    }
    if (!installed) return { ...base, state: 'no-plugin', message: 'Install the Forge Bridge plugin, then restart Studio (or reload plugins).' }
    if (mode === 'outdated') return { ...base, state: 'plugin-outdated', message: 'The Forge Bridge plugin is older than this Forge; reinstall it and restart Studio.' }
    if (mode === 'offline') return { ...base, state: 'studio-offline', message: 'Open your place in Roblox Studio; the Forge Bridge plugin connects on its own (allow HTTP requests to 127.0.0.1 when Studio asks).' }
    if (mode === 'nocapture') return { ...base, state: 'no-capture', message: base.capture.hint! }
    return base
  }
  const key = (k: StudioCheckKind, id: string) => `${k}:${id}`
  return {
    async studioStatus() {
      return status()
    },
    async studioInstallPlugin() {
      await delay(300)
      installed = true
      const s = status()
      emit('studio:bridge', s)
      return s
    },
    async studioOpenPluginsFolder() {},
    async studioSetPrefer(on) {
      prefer = !!on
      const s = status()
      emit('studio:bridge', s)
      return s
    },
    async studioCheck(kind, id, opts) {
      const s = status()
      if (s.state !== 'ready') throw new Error(s.message)
      const phases: [HarnessEvents['studio:progress']['phase'], string][] = [
        ['waiting', 'waiting for Studio to pick up the job'],
        ['staging', 'building the stage in Studio'],
        ['capturing', kind === 'anim' ? 'posing each beat' : 'playing'],
        ['preview', 'rendering the preview at the same beats'],
        ...(opts?.critique ? ([['critique', 'the critic is looking at the Studio frames']] as [HarnessEvents['studio:progress']['phase'], string][]) : [])
      ]
      for (const [phase, message] of phases) {
        emit('studio:progress', { kind, id, phase, message })
        await delay(350)
      }
      const labels = kind === 'anim' ? ['anticipation', 'peak', 'release', 'recover'] : kind === 'ability' ? ['wind-up', 'anticipation', 'release', 'impact', 'follow-through'] : ['charge', 'release', 'impact', 'dissipate']
      const record: StudioCheckRecord = {
        kind,
        id,
        name: id,
        at: Date.now(),
        ok: true,
        mode: kind === 'anim' ? 'stepped' : 'realtime',
        frames: labels.map((label, i) => {
          const file = `studio/beat-${i + 1}.png`
          const preview = `studio/preview-${i + 1}.png`
          files.set(`${key(kind, id)}:${file}`, frame('studio', label, i))
          files.set(`${key(kind, id)}:${preview}`, frame('preview', label, i))
          return { beat: i, label, t: Math.round((0.2 + i * 0.35) * 100) / 100, file, preview, ...(kind === 'anim' ? {} : { offsetMs: [4, -11, 9, -3, 6][i] }) }
        }),
        marks: kind === 'vfx' ? labels.map((label, i) => ({ label, t: Math.round((0.1 + i * 0.35 + 0.012) * 1000) / 1000 })) : [],
        ...(kind === 'vfx' ? { drift: labels.map((label, i) => ({ label, planned: Math.round((0.1 + i * 0.35) * 100) / 100, actual: Math.round((0.1 + i * 0.35 + 0.012) * 1000) / 1000 })) } : {}),
        window: 'MyGame - Roblox Studio',
        place: 'MyGame',
        crop: { x: 312, y: 96, width: 1280, height: 720 },
        ...(opts?.critique ? { critique: { overall: 6.8, summary: 'In Studio the core reads well but the glow is softer than the preview; the impact ring is lost against the default lighting. Raise LightEmission on Ring and shorten Smoke lifetime.' } } : {}),
        ms: 4200
      }
      checks.set(key(kind, id), record)
      emit('studio:progress', { kind, id, phase: 'done', message: `${record.frames.length} Studio frame(s)` })
      return record
    },
    async studioLastCheck(kind, id) {
      return checks.get(key(kind, id)) ?? null
    },
    async studioFile(kind, id, file) {
      return files.get(`${key(kind, id)}:${file}`) ?? null
    }
  }
}
