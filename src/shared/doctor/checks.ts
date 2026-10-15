// Forge Doctor checks: DoctorInputs (gathered by probes) -> DoctorCheck list. Pure.

import type { DoctorCheck, DoctorInputs, DoctorReport, DoctorStatus } from './types.ts'

const GB = 1024 ** 3
export const DISK_FAIL_BYTES = 1 * GB
export const DISK_WARN_BYTES = 5 * GB
// luau-lsp reads sourcemap.json; older than a day while the project changes = likely stale types.
export const SOURCEMAP_STALE_MS = 24 * 3600_000
// Scopes the Labs and Art use to upload images / animations (Assets API: asset:read + asset:write).
export const OPEN_CLOUD_SCOPES = ['asset:read', 'asset:write']

const gb = (n: number) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`

export function toolchainChecks(i: DoctorInputs): DoctorCheck[] {
  if (!i.toolchain) return [{ id: 'toolchain', group: 'Toolchain', title: 'Toolchain', status: 'skip', detail: 'Toolchain status is not available in this build.' }]
  const out: DoctorCheck[] = []
  const r = i.toolchain.rokit
  out.push(
    r.installed
      ? { id: 'rokit', group: 'Toolchain', title: 'rokit', status: 'ok', detail: `rokit ${r.version ?? ''} installed`.trim() }
      : { id: 'rokit', group: 'Toolchain', title: 'rokit', status: 'fail', detail: 'rokit (the tool manager) is not installed.', fix: { kind: 'action', action: 'installTools', label: 'Install toolchain' } }
  )
  const wanted = ['rojo', 'lune', 'luau-lsp', 'wally', 'blink', 'selene', 'stylua']
  for (const alias of wanted) {
    const t = i.toolchain.tools.find((x) => x.alias === alias)
    if (!t) continue
    const id = `tool-${alias}`
    if (t.state === 'ok') out.push({ id, group: 'Toolchain', title: alias, status: 'ok', detail: `${t.version} (pinned)` })
    else if (t.state === 'other') out.push({ id, group: 'Toolchain', title: alias, status: 'warn', detail: `${t.version} installed; Forge is tested with ${t.pinned}.`, fix: { kind: 'action', action: 'installTools', label: `Pin ${t.pinned}` } })
    else if (t.state === 'external') out.push({ id, group: 'Toolchain', title: alias, status: 'warn', detail: `Found on PATH outside rokit, so its version is not pinned (Forge expects ${t.pinned}).`, fix: { kind: 'action', action: 'installTools', label: 'Install pinned' } })
    else if (t.state === 'broken') out.push({ id, group: 'Toolchain', title: alias, status: 'fail', detail: `rokit lists ${t.version ?? 'it'} but its files are gone.`, fix: { kind: 'action', action: 'installTools', label: 'Repair' } })
    else out.push({ id, group: 'Toolchain', title: alias, status: 'fail', detail: `Not installed (Forge pins ${t.pinned}).`, fix: { kind: 'action', action: 'installTools', label: 'Install' } })
  }
  if (i.python) {
    out.push(
      i.python.available
        ? { id: 'python', group: 'Toolchain', title: 'Python', status: 'ok', detail: `${i.python.version ?? 'python'} (the project's studio-sync engine needs it)` }
        : { id: 'python', group: 'Toolchain', title: 'Python', status: 'fail', detail: "Forge Sync is set to the project's own engine, which runs on Python 3, and Python was not found.", fix: { kind: 'instruction', text: 'Install Python 3 (python.org), or switch Forge Sync to the Forge engine in Settings > Sync.', url: 'https://www.python.org/downloads/' } }
    )
  }
  return out
}

export function gitChecks(i: DoctorInputs): DoctorCheck[] {
  const out: DoctorCheck[] = []
  out.push(
    i.git.available
      ? { id: 'git', group: 'Git', title: 'git', status: 'ok', detail: `git ${i.git.version}` }
      : { id: 'git', group: 'Git', title: 'git', status: 'fail', detail: i.git.hint ?? 'git is not installed.', fix: { kind: 'instruction', text: i.git.hint ?? 'Install git.', url: i.git.downloadUrl ?? 'https://git-scm.com/downloads' } }
  )
  if (!i.gh.available) out.push({ id: 'gh', group: 'Git', title: 'GitHub CLI (gh)', status: 'warn', detail: 'Not installed: "Open pull request" and Join project from GitHub need it.', fix: { kind: 'instruction', text: 'Install the GitHub CLI, then sign in.', command: 'gh auth login', url: 'https://cli.github.com/' } })
  else if (i.gh.authed === false) out.push({ id: 'gh', group: 'Git', title: 'GitHub CLI (gh)', status: 'warn', detail: `gh ${i.gh.version ?? ''} is installed but not signed in.`.replace('  ', ' '), fix: { kind: 'instruction', text: 'Sign in to GitHub in a terminal:', command: 'gh auth login' } })
  else out.push({ id: 'gh', group: 'Git', title: 'GitHub CLI (gh)', status: 'ok', detail: `gh ${i.gh.version ?? ''}${i.gh.authed ? ' · signed in' : ''}`.trim() })
  return out
}

export function studioChecks(i: DoctorInputs, now: number): DoctorCheck[] {
  const out: DoctorCheck[] = []
  if (i.studioInstall === null) {
    out.push({ id: 'studio-install', group: 'Studio', title: 'Roblox Studio', status: 'skip', detail: 'Roblox Studio runs on Windows and macOS; Studio checks are skipped on this system.' })
    return out
  }
  out.push(
    i.studioInstall.installed
      ? { id: 'studio-install', group: 'Studio', title: 'Roblox Studio', status: 'ok', detail: i.studioInstall.path ? `Installed (${i.studioInstall.path})` : 'Installed' }
      : { id: 'studio-install', group: 'Studio', title: 'Roblox Studio', status: 'fail', detail: 'Roblox Studio was not found.', fix: { kind: 'instruction', text: 'Install Roblox Studio from the Creator Hub.', url: 'https://create.roblox.com/docs/studio/setup' } }
  )
  const b = i.bridge
  if (!b) return out
  const p = b.plugin
  if (!p.installed && !b.studio.connected) out.push({ id: 'plugin', group: 'Studio', title: 'Forge Bridge plugin', status: 'fail', detail: 'Not installed: the Studio check and Forge Sync need it.', fix: { kind: 'action', action: 'installPlugin', label: 'Install plugin' } })
  else if (p.outdated || (b.studio.connected && (b.studio.pluginVersion ?? 0) < p.bundled)) {
    const v = b.studio.pluginVersion ?? p.version
    out.push({ id: 'plugin', group: 'Studio', title: 'Forge Bridge plugin', status: 'warn', detail: `Version ${v ?? '?'} is older than this Forge (v${p.bundled}). Reinstall, then restart Studio.`, fix: { kind: 'action', action: 'installPlugin', label: 'Update plugin' } })
  } else out.push({ id: 'plugin', group: 'Studio', title: 'Forge Bridge plugin', status: 'ok', detail: `v${b.studio.pluginVersion ?? p.version ?? p.bundled} (current)` })
  if (i.legacyPlugins.length) out.push({ id: 'legacy-plugin', group: 'Studio', title: 'Legacy StudioSync plugin', status: 'warn', detail: `${i.legacyPlugins.join(', ')} still installed: it writes Studio edits too and fights Forge Sync.`, fix: { kind: 'action', action: 'disableLegacyPlugins', label: 'Disable legacy' } })
  if (b.studio.connected) {
    out.push({ id: 'studio-connected', group: 'Studio', title: 'Studio connection', status: 'ok', detail: `Connected${b.studio.place ? ` to ${b.studio.place}` : ''}` })
    // The plugin reaches Forge over HTTP, so a live connection proves HTTP requests are allowed.
    out.push({ id: 'studio-http', group: 'Studio', title: 'HTTP to localhost', status: 'ok', detail: 'Allowed (the plugin is talking to Forge).' })
  } else {
    const seen = b.studio.lastSeen ? Math.round((now - b.studio.lastSeen) / 60000) : null
    out.push({ id: 'studio-connected', group: 'Studio', title: 'Studio connection', status: 'warn', detail: seen !== null ? `Not connected (last contact ${seen} min ago).` : 'Not connected: open your place in Studio.', fix: { kind: 'instruction', text: 'Open the place in Roblox Studio. The Forge Bridge plugin connects by itself.' } })
    out.push({
      id: 'studio-http',
      group: 'Studio',
      title: 'HTTP to localhost',
      status: seen !== null ? 'ok' : 'warn',
      detail: seen !== null ? 'Allowed the last time Studio was open.' : 'Unknown until the plugin makes contact.',
      ...(seen === null ? { fix: { kind: 'instruction' as const, text: `When Studio asks whether Forge Bridge may make HTTP requests to 127.0.0.1:${b.port}, choose Allow. To change it later: Studio > Plugins > Manage Plugins > Forge Bridge > HTTP permissions.` } } : {})
    })
  }
  return out
}

export function portChecks(i: DoctorInputs): DoctorCheck[] {
  const out: DoctorCheck[] = []
  if (i.bridge && !i.bridge.listening) {
    out.push({ id: 'port-bridge', group: 'Ports', title: `Forge Bridge :${i.bridge.port}`, status: 'fail', detail: `Forge could not listen on 127.0.0.1:${i.bridge.port}${i.bridge.error ? ` (${i.bridge.error})` : ''}. Another Forge window or program holds the port.`, fix: { kind: 'instruction', text: 'Quit other copies of RBX Forge (and anything else on that port), then restart Forge.' } })
  } else if (i.bridge) out.push({ id: 'port-bridge', group: 'Ports', title: `Forge Bridge :${i.bridge.port}`, status: 'ok', detail: 'Listening' })
  for (const p of i.ports) {
    const id = `port-${p.port}`
    if (p.state === 'other') {
      out.push({ id, group: 'Ports', title: `${p.label} :${p.port}`, status: p.expected ? 'fail' : 'warn', detail: `Port ${p.port} is held by another program (another rojo serve?). Rojo cannot serve this place until it is free.`, fix: { kind: 'instruction', text: `Stop the other program on port ${p.port}, or change "servePort" in the project file.`, command: process_hint(p.port) } })
    } else if (p.state === 'free' && p.expected) {
      out.push({ id, group: 'Ports', title: `${p.label} :${p.port}`, status: 'warn', detail: 'Rojo should be serving here but nothing is listening.', fix: { kind: 'action', action: 'startRojo', label: 'Start rojo' } })
    } else if (p.state === 'unknown') out.push({ id, group: 'Ports', title: `${p.label} :${p.port}`, status: 'skip', detail: 'Could not test the port.' })
    else out.push({ id, group: 'Ports', title: `${p.label} :${p.port}`, status: 'ok', detail: p.state === 'ours' ? 'Served by Forge' : 'Free' })
  }
  return out
}

// A command that shows who holds a port (shown with the instruction, never run).
function process_hint(port: number): string {
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN   (Windows: netstat -ano | findstr :${port})`
}

export function syncChecks(i: DoctorInputs): DoctorCheck[] {
  if (!i.sync) return []
  const out: DoctorCheck[] = []
  const s = i.sync
  if (s.engine === 'off') out.push({ id: 'sync-engine', group: 'Sync', title: 'Forge Sync', status: 'warn', detail: 'Off: Studio edits are not written back to the repo, and rojo serve can overwrite them.', fix: { kind: 'open', target: 'settings:set-sync', label: 'Sync settings' } })
  else out.push({ id: 'sync-engine', group: 'Sync', title: 'Forge Sync', status: 'ok', detail: s.engine === 'forge' ? 'Forge engine' : "Project's own engine" })
  const conflicts = s.places.reduce((n, p) => n + p.conflicts, 0)
  const blocked = s.places.filter((p) => p.gate === 'blocked')
  const heldFor = blocked.length ? `rojo is held for ${blocked.map((p) => p.projectFile).join(', ')}` : ''
  if (conflicts || blocked.length) out.push({ id: 'sync-conflicts', group: 'Sync', title: 'Sync conflicts', status: 'fail', detail: conflicts || !blocked.some((p) => p.studioOnly) ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}${heldFor ? `; ${heldFor}` : ''}.` : `${heldFor}: Studio-only scripts are not on disk yet.`, fix: { kind: 'open', target: 'side:sync', label: 'Resolve' } })
  else if (s.engine !== 'off') out.push({ id: 'sync-conflicts', group: 'Sync', title: 'Sync conflicts', status: 'ok', detail: s.places.some((p) => p.gate === 'checking') ? 'Reconciling…' : 'None' })
  const studioOnly = s.places.reduce((n, p) => n + (p.studioOnly ?? 0), 0)
  if (studioOnly) out.push({ id: 'sync-studio-only', group: 'Sync', title: 'Studio-only scripts', status: 'warn', detail: `${studioOnly} script${studioOnly === 1 ? ' exists' : 's exist'} only in Studio, not on disk: Rojo would delete ${studioOnly === 1 ? 'it' : 'them'} from Studio when it connects.`, fix: { kind: 'open', target: 'side:sync', label: 'Pull to disk' } })
  if (s.pendingStudioEdits > 0) out.push({ id: 'sync-pending', group: 'Sync', title: 'Uncommitted Studio edits', status: 'warn', detail: `${s.pendingStudioEdits} file${s.pendingStudioEdits === 1 ? '' : 's'} written from Studio are not committed yet.`, fix: { kind: 'open', target: 'side:sync', label: 'Commit' } })
  return out
}

export function keyChecks(i: DoctorInputs): DoctorCheck[] {
  const out: DoctorCheck[] = []
  for (const k of i.keys) {
    if (k.local) continue
    const id = `key-${k.provider}`
    if (k.set) out.push({ id, group: 'Keys', title: `${k.label} key`, status: 'ok', detail: 'set' })
    else out.push({ id, group: 'Keys', title: `${k.label} key`, status: k.isDefault ? 'fail' : 'skip', detail: k.isDefault ? 'missing (this is your default model provider)' : 'missing', ...(k.isDefault ? { fix: { kind: 'open' as const, target: 'settings:set-providers', label: 'Add key' } } : {}) })
  }
  out.push(
    i.openAiKey
      ? { id: 'key-openai-art', group: 'Keys', title: 'OpenAI key for Art / Thumbnails', status: 'ok', detail: 'set' }
      : { id: 'key-openai-art', group: 'Keys', title: 'OpenAI key for Art / Thumbnails', status: 'warn', detail: 'missing: image generation (Art, VFX textures, thumbnails) is unavailable.', fix: { kind: 'open', target: 'settings:set-providers', label: 'Add key' } }
  )
  const oc = i.openCloud
  if (!oc.set) out.push({ id: 'key-opencloud', group: 'Keys', title: 'Open Cloud key', status: 'warn', detail: 'missing: uploading textures and animations to Roblox needs one (asset:read + asset:write).', fix: { kind: 'open', target: 'page:art', label: 'Add key' } })
  else if (!oc.introspect) out.push({ id: 'key-opencloud', group: 'Keys', title: 'Open Cloud key', status: 'ok', detail: 'set (scopes not checked)' })
  else if ('error' in oc.introspect) out.push({ id: 'key-opencloud', group: 'Keys', title: 'Open Cloud key', status: 'warn', detail: `set; could not check its scopes (${oc.introspect.error}).` })
  else {
    const info = oc.introspect
    const missing = OPEN_CLOUD_SCOPES.filter((s) => !info.scopes.includes(s))
    if (!info.enabled || info.expired) out.push({ id: 'key-opencloud', group: 'Keys', title: 'Open Cloud key', status: 'fail', detail: info.expired ? 'set, but expired.' : 'set, but disabled.', fix: { kind: 'instruction', text: 'Create or re-enable the key on the Creator Hub (Open Cloud > API Keys), then paste it on the Art page.', url: 'https://create.roblox.com/dashboard/credentials' } })
    else if (missing.length) out.push({ id: 'key-opencloud', group: 'Keys', title: 'Open Cloud key', status: 'warn', detail: `set, but missing scope${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`, fix: { kind: 'instruction', text: 'Edit the key on the Creator Hub and add the Assets API with Read and Write.', url: 'https://create.roblox.com/dashboard/credentials' } })
    else out.push({ id: 'key-opencloud', group: 'Keys', title: 'Open Cloud key', status: 'ok', detail: `set · ${OPEN_CLOUD_SCOPES.join(', ')}` })
  }
  return out
}

export function diskChecks(i: DoctorInputs): DoctorCheck[] {
  return i.disk.map((d) => {
    const id = `disk-${d.label.toLowerCase().replace(/\W+/g, '-')}`
    if (d.freeBytes === null) return { id, group: 'Disk' as const, title: d.label, status: 'skip' as const, detail: `Could not read free space for ${d.path}.` }
    if (d.freeBytes < DISK_FAIL_BYTES) return { id, group: 'Disk' as const, title: d.label, status: 'fail' as const, detail: `Only ${gb(d.freeBytes)} free at ${d.path}. Renders, captures and the luau-lsp cache need room.`, fix: { kind: 'instruction' as const, text: 'Free up disk space on that drive.' } }
    if (d.freeBytes < DISK_WARN_BYTES) return { id, group: 'Disk' as const, title: d.label, status: 'warn' as const, detail: `${gb(d.freeBytes)} free at ${d.path}.` }
    return { id, group: 'Disk' as const, title: d.label, status: 'ok' as const, detail: `${gb(d.freeBytes)} free` }
  })
}

export function projectChecks(i: DoctorInputs, now: number): DoctorCheck[] {
  const p = i.project
  if (!p) return [{ id: 'project', group: 'Project', title: 'Project', status: 'skip', detail: 'No project open.' }]
  const out: DoctorCheck[] = []
  if (!p.projectFiles.length) out.push({ id: 'project-files', group: 'Project', title: 'Rojo project files', status: 'fail', detail: 'No *.project.json at the project root: Rojo has nothing to serve.', fix: { kind: 'instruction', text: 'Open the folder that holds default.project.json, or create one with "rojo init".', command: 'rojo init' } })
  for (const f of p.projectFiles) {
    out.push(f.ok ? { id: `pf-${f.file}`, group: 'Project', title: f.file, status: 'ok', detail: f.servePort ? `parses · serves on :${f.servePort}` : 'parses' } : { id: `pf-${f.file}`, group: 'Project', title: f.file, status: 'fail', detail: `Does not parse: ${f.error ?? 'invalid JSON'}`, fix: { kind: 'open', target: `file:${f.file}`, label: 'Open file' } })
  }
  if (p.rokitToml && p.projectToolsMissing.length) out.push({ id: 'project-tools', group: 'Project', title: 'Project tools (rokit.toml)', status: 'warn', detail: `Not installed: ${p.projectToolsMissing.join(', ')}.`, fix: { kind: 'action', action: 'installProjectTools', label: 'rokit install' } })
  else if (p.rokitToml) out.push({ id: 'project-tools', group: 'Project', title: 'Project tools (rokit.toml)', status: 'ok', detail: 'Installed' })
  if (p.wallyToml) out.push(p.packagesInstalled ? { id: 'wally', group: 'Project', title: 'Wally packages', status: 'ok', detail: 'Installed' } : { id: 'wally', group: 'Project', title: 'Wally packages', status: 'fail', detail: 'wally.toml exists but Packages/ is missing: requires of packages fail in Studio.', fix: { kind: 'action', action: 'wallyInstall', label: 'wally install' } })
  if (!p.sourcemap.exists) out.push({ id: 'sourcemap', group: 'Project', title: 'sourcemap.json', status: 'warn', detail: 'Missing: luau-lsp cannot resolve requires and instance types.', fix: { kind: 'action', action: 'sourcemap', label: 'Generate' } })
  else if ((p.sourcemap.ageMs ?? 0) > SOURCEMAP_STALE_MS) out.push({ id: 'sourcemap', group: 'Project', title: 'sourcemap.json', status: 'warn', detail: `${Math.round((p.sourcemap.ageMs ?? 0) / 3600_000)} h old; may be stale if rojo is not running.`, fix: { kind: 'action', action: 'sourcemap', label: 'Regenerate' } })
  else out.push({ id: 'sourcemap', group: 'Project', title: 'sourcemap.json', status: 'ok', detail: 'Present' })
  void now
  return out
}

export function appChecks(i: DoctorInputs): DoctorCheck[] {
  const out: DoctorCheck[] = []
  const u = i.updater
  if (!u || !i.isPackaged || u.state === 'disabled') out.push({ id: 'updater', group: 'App', title: 'Auto-update', status: 'skip', detail: u?.error ?? `This build (v${i.appVersion}) does not update itself.` })
  else if (u.state === 'error') out.push({ id: 'updater', group: 'App', title: 'Auto-update', status: 'warn', detail: `Last check failed: ${u.error ?? 'unknown error'}`, fix: { kind: 'action', action: 'checkUpdates', label: 'Check now' } })
  else if (u.state === 'ready') out.push({ id: 'updater', group: 'App', title: 'Auto-update', status: 'warn', detail: `Version ${u.version ?? '?'} is downloaded; it installs when you restart Forge.` })
  else if (u.state === 'available' || u.state === 'downloading') out.push({ id: 'updater', group: 'App', title: 'Auto-update', status: 'ok', detail: `Update ${u.version ?? ''} ${u.state}`.replace('  ', ' ') })
  else if (u.state === 'idle') out.push({ id: 'updater', group: 'App', title: 'Auto-update', status: 'warn', detail: `v${i.appVersion} · not checked yet`, fix: { kind: 'action', action: 'checkUpdates', label: 'Check now' } })
  else out.push({ id: 'updater', group: 'App', title: 'Auto-update', status: 'ok', detail: `v${i.appVersion} · ${u.state === 'none' ? 'up to date' : u.state}` })
  if (i.screenRecording !== null) {
    const ok = i.screenRecording === 'granted'
    out.push(
      ok
        ? { id: 'screen-recording', group: 'App', title: 'Screen Recording permission', status: 'ok', detail: 'Granted (Studio check captures work).' }
        : { id: 'screen-recording', group: 'App', title: 'Screen Recording permission', status: 'warn', detail: `${i.screenRecording === 'unknown' ? 'Unknown' : 'Not granted'}: the Studio check cannot record the Studio window.`, fix: { kind: 'action', action: 'openScreenRecording', label: 'Open System Settings' } }
    )
  }
  return out
}

export function runChecks(i: DoctorInputs, now: number): DoctorCheck[] {
  return [...toolchainChecks(i), ...gitChecks(i), ...studioChecks(i, now), ...portChecks(i), ...syncChecks(i), ...keyChecks(i), ...diskChecks(i), ...projectChecks(i, now), ...appChecks(i)]
}

export function summarize(checks: DoctorCheck[], meta: { at: number; ms: number; appVersion: string; platform: string }): DoctorReport {
  const counts: Record<DoctorStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 }
  for (const c of checks) counts[c.status]++
  const overall = counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok'
  return { ...meta, checks, counts, overall }
}
