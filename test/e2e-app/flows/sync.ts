// Forge Sync against the real app's Forge Bridge (127.0.0.1:34877): the suite plays the Studio
// plugin over HTTP the way test/syncE2E.test.ts does, but through the running app, and checks the
// disk, the gate pill and the "Commit teammate edits" button. Also the Sync settings and the Studio
// check states with no Studio.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPlaces, placeFor } from '../../../src/main/services/sync/mapping.ts'
import { studioFromDisk } from '../../syncFixture.ts'
import { BRIDGE_PORT } from '../lib/app.ts'
import { git, INVENTORY_SERVICE } from '../lib/project.ts'
import { check, CENTER, openPage, showSide, waitText } from '../lib/ui.ts'
import type { Flow } from './types.ts'

const BASE = `http://127.0.0.1:${BRIDGE_PORT}/forge-bridge`
// Listed in the fixture's tools/studio-sync.json placeIds; an unlisted published place gets sync off.
const PLACE_ID = 123
// The plugin's node ids are short hashes.
const short = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 16)
const INVENTORY_PATH = ['ServerScriptService', 'Server', 'Features', 'Inventory', 'InventoryService']
// A cutscene module with child modules under the client's InventoryController module (the shape of the
// GenTree bug report: OnboardingController.WakeUpCutscene).
const CUTSCENE = ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client', 'Controllers', 'InventoryController', 'Cutscene']
const CUTSCENE_DIR = 'src/client/Client/Controllers/InventoryController/Cutscene'
const CUTSCENE_NODES = [
  { id: 'cut', path: CUTSCENE, className: 'ModuleScript', source: 'return "cutscene"\n' },
  { id: 'cut-body', path: [...CUTSCENE, 'Body'], className: 'ModuleScript', source: 'return "body"\n' },
  { id: 'cut-props', path: [...CUTSCENE, 'Props'], className: 'ModuleScript', source: 'return "props"\n' },
  { id: 'cut-toon', path: [...CUTSCENE, 'Props', 'Toon'], className: 'ModuleScript', source: 'return "toon"\n' }
]
const CUTSCENE_FILES = ['init.luau', 'Body.luau', 'Props/init.luau', 'Props/Toon.luau'].map((f) => `${CUTSCENE_DIR}/${f}`)

async function json(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
  return (await r.json()) as Record<string, unknown>
}

// The app's rojo service status (hold = the Forge Sync gate).
async function rojoStatus(page: import('../lib/app.ts').Page): Promise<{ state: string; detail?: string; pid?: number; hold?: { gate: string; reason?: string } }> {
  return page.evaluate(() => window.harness.getServices().then((list) => list.find((s) => s.id === 'rojo')))
}

// A fake `rojo` in the sandbox's ~/.rokit/bin (found first by the app's tool lookup): records every
// run like `rojo serve` and stays up. Not on Windows (sh script).
function fakeRojo(home: string): { serves: () => string[]; remove: () => void } | null {
  if (process.platform === 'win32') return null
  const bin = join(home, '.rokit', 'bin')
  const log = join(home, 'rojo-runs.log')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'rojo'), `#!/bin/sh\necho "$@" >> '${log}'\necho "Rojo server listening: Port: 34872"\nexec sleep 600\n`)
  chmodSync(join(bin, 'rojo'), 0o755)
  return {
    serves: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('serve')) : []),
    remove: () => rmSync(join(bin, 'rojo'), { force: true })
  }
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

// The place row's gate tag in the Forge Sync section.
async function gateText(page: import('../lib/app.ts').Page): Promise<string> {
  return (await page.locator('aside.side .vsec.fs .fs-place .tag').first().innerText().catch(() => '')).trim()
}

export const syncFlows: Flow[] = [
  {
    name: 'forge-sync',
    title: 'Forge Sync: fake Studio plugin edit lands on disk, gate pill clears, commit',
    needs: ['bridgePort'],
    timeoutMs: 60_000,
    async run({ page, root, sandbox, note }) {
      // rojo serve with Forge Sync on: it must not serve before Studio's first sync check clears.
      const rojo = fakeRojo(sandbox.home)
      try {
        await forgeSyncFlow({ page, root, note, rojo })
      } finally {
        await page.evaluate(() => window.harness.stopService('rojo')).catch(() => undefined)
        rojo?.remove()
      }
    }
  },
  {
    name: 'sync-settings',
    title: 'Settings > Sync: engine switch Forge / Project script / Off',
    async run({ page }) {
      await openPage(page, 'Settings')
      await page.locator('nav.set-nav button', { hasText: 'Sync' }).click()
      const group = page.locator('[role="radiogroup"][aria-label="Studio sync engine"]')
      await group.waitFor({ state: 'visible', timeout: 5000 })
      for (const [label, engine] of [['Project script', 'project'], ['Off', 'off'], ['Forge (recommended)', 'forge']] as const) {
        await group.getByRole('radio', { name: label }).click()
        await page.waitForFunction((e: string) => window.harness.syncStatus().then((s) => s.engine === e), engine, { timeout: 5000 }).catch(() => undefined)
        const s = await page.evaluate(() => window.harness.syncStatus())
        check(s.engine === engine, `engine is ${s.engine} after choosing "${label}"`)
        check((await group.getByRole('radio', { name: label }).getAttribute('aria-checked')) === 'true', `"${label}" not shown as checked`)
      }
      const gateSwitch = page.getByLabel('Check Studio before Rojo serves')
      check(await gateSwitch.count(), 'no "Check Studio before Rojo serves" switch with the Forge engine')
    }
  }
]

async function forgeSyncFlow({ page, root, note, rojo }: { page: import('../lib/app.ts').Page; root: string; note: (m: string) => void; rojo: ReturnType<typeof fakeRojo> }): Promise<void> {
  if (rojo) {
    await page.evaluate(() => window.harness.startService('rojo'))
    // No Studio has been checked yet: rojo serve waits for Studio's first sync check.
    await until('rojo held for the first Studio check', async () => (await rojoStatus(page))?.hold?.gate === 'waiting')
    const held = await rojoStatus(page)
    check(held.hold?.reason === 'studio' && !held.pid, `rojo before any Studio check: ${JSON.stringify(held)}`)
    await page.waitForTimeout(500)
    check(rojo.serves().length === 0, `rojo served before Studio's first sync check: ${rojo.serves().join(' | ')}`)
    check(/^waiting/.test((await page.locator('.btn-forge').first().innerText()).trim().toLowerCase()), `Serve button: "${await page.locator('.btn-forge').first().innerText()}"`)
  }
  // The script is open in an editor tab: the Studio edit must show up there too.
  await showSide(page, 'Explorer')
  const filter = page.locator('aside.side input').first()
  await filter.fill('InventoryService')
  const row = page.locator('aside.side [role="treeitem"]', { hasText: 'InventoryService' }).first()
  await row.waitFor({ state: 'visible', timeout: 5000 })
  await row.dblclick()
  await page.locator(`${CENTER} .monaco-editor`).first().waitFor({ state: 'visible', timeout: 15_000 })
  await filter.fill('')
  await showSide(page, 'Source control & Sync')
  await page.locator('aside.side .vsec.fs').waitFor({ state: 'visible', timeout: 10_000 })
  // No Forge Bridge plugin has connected: the section says Studio edits are not syncing.
  await waitText(page, /Not syncing/, { within: 'aside.side .vsec.fs' })
  const ping = await json(`${BASE}/ping`)
  check(typeof ping.now === 'number', `bridge ping: ${JSON.stringify(ping)}`)
  // Other Studio places open at the same time (a VFX scratch place, another game's place): not linked
  // to this project, so no session, nothing written, no conflict cards, no rojo hold.
  const dirtyBefore = git(root, 'status', '--porcelain')
  const vfx = await json(`${BASE}/sync/config?placeId=0&gameId=0&place=VFX%20Scratch&probe=e2e-probe-vfx-0001`)
  check(vfx.enabled === false, `an unlinked unpublished place got a sync session: ${JSON.stringify(vfx)}`)
  const otherGame = await json(`${BASE}/sync/config?placeId=72187156382444&gameId=5&place=FSF&probe=e2e-probe-fsf-0001`)
  check(otherGame.enabled === false, `an unlinked published place got a sync session: ${JSON.stringify(otherGame)}`)
  const forged = await json(`${BASE}/sync/snapshot`, { session: 'not-a-session', place: { placeId: 0, name: 'VFX Scratch' }, seq: 0, final: true, nodes: [{ id: 'x1', path: ['ServerScriptService', 'Server', 'Slash'], className: 'Script', source: 'print(1)' }] })
  check(forged.ok !== true, `a snapshot without a session was taken: ${JSON.stringify(forged)}`)
  await waitText(page, /Not linked: VFX Scratch/, { within: 'aside.side .vsec.fs' })
  await waitText(page, /Not linked: FSF/, { within: 'aside.side .vsec.fs' })
  check((await page.locator('aside.side .vsec.fs .fs-conflict').count()) === 0, 'conflict cards for an unlinked place')
  check(!/held/.test(await gateText(page)), `the project place is held by an unlinked place: ${await gateText(page)}`)
  const unlinkedStatus = await page.evaluate(() => window.harness.syncStatus())
  // No conflicts from them; the project's place waits for a linked check, and says why, loudly.
  check(unlinkedStatus.places.every((p: { gate: string; waitReason?: string; conflicts: number }) => p.gate === 'waiting' && p.waitReason === 'unlinked' && !p.conflicts), `unlinked places: ${JSON.stringify(unlinkedStatus.places)}`)
  const waitCallout = page.locator('aside.side .vsec.fs .fs-wait')
  await waitCallout.waitFor({ state: 'visible', timeout: 10_000 })
  await waitText(page, /(isn't|aren't) linked to this project.*Rojo serve waits/, { within: 'aside.side .vsec.fs .fs-wait' })
  check(await waitCallout.locator('button', { hasText: 'Serve without Studio check' }).count(), 'no "Serve without Studio check" in the unlinked callout')
  check(await waitCallout.locator('button', { hasText: 'Link "VFX Scratch" and check' }).count(), 'no "Link and check" for the unlinked place')
  if (rojo) {
    await until('rojo held for the unlinked place', async () => (await rojoStatus(page))?.hold?.reason === 'unlinked')
    check(rojo.serves().length === 0, `rojo served with only unlinked Studio places open: ${rojo.serves().join(' | ')}`)
  }
  check(git(root, 'status', '--porcelain') === dirtyBefore, 'an unlinked place changed files on disk')
  const cfg = await json(`${BASE}/sync/config?placeId=${PLACE_ID}&gameId=9&place=E2E%20Place`)
  check(cfg.enabled === true, `sync config not enabled: ${JSON.stringify(cfg)}`)
  const session = String(cfg.sessionToken)
  const map = placeFor(await loadPlaces(root), PLACE_ID)
  check(map, 'no place mapping for default.project.json')
  const studio = studioFromDisk(root, map!).map((n) => ({ ...n, id: short(n.id) }))
  check(studio.some((n) => n.path.join('/') === INVENTORY_PATH.join('/')), 'fixture snapshot has no InventoryService')
  // First connect: Studio == disk.
  const chunk = 25
  for (let i = 0, seq = 0; i < studio.length; i += chunk, seq++) {
    const r = await json(`${BASE}/sync/snapshot`, { session, place: { placeId: PLACE_ID, gameId: 9 }, seq, final: i + chunk >= studio.length, nodes: studio.slice(i, i + chunk) })
    check(r.ok === true, `snapshot chunk ${seq}: ${JSON.stringify(r)}`)
  }
  await page.waitForFunction(() => /clear/.test(document.querySelector('aside.side .vsec.fs .fs-place .tag')?.textContent ?? ''), undefined, { timeout: 10_000 }).catch(async () => {
    throw new Error(`gate pill shows "${await gateText(page)}" after a matching snapshot, expected "clear"`)
  })
  if (rojo) {
    // The first check cleared: now rojo serves.
    await until('rojo serving after the first Studio check', async () => rojo.serves().length === 1 && (await rojoStatus(page))?.state === 'running')
    check(!(await rojoStatus(page)).hold, 'rojo still held after the check cleared')
  }
  // A live edit in Studio.
  const node = studio.find((n) => n.path.join('/') === INVENTORY_PATH.join('/'))!
  const text = `${node.source}-- edited in Studio (forge e2e)\n`
  const r = await json(`${BASE}/sync/changes`, { session, place: { placeId: PLACE_ID }, changes: [{ kind: 'source', node: { ...node, source: text } }] })
  check(r.ok === true, `changes: ${JSON.stringify(r)}`)
  let disk = ''
  for (let i = 0; i < 40 && disk !== text; i++) {
    await page.waitForTimeout(100)
    disk = readFileSync(join(root, INVENTORY_SERVICE), 'utf8')
  }
  check(disk === text, 'the Studio edit did not reach disk')
  await page
    .waitForFunction(() => /edited in Studio \(forge e2e\)/.test(document.querySelector('.editor-area .monaco-editor .view-lines')?.textContent?.replace(/\u00a0/g, ' ') ?? ''), undefined, { timeout: 10_000 })
    .catch(() => {
      throw new Error('the open editor tab did not reload the Studio edit from disk')
    })
  await waitText(page, /Recent from Studio/, { within: 'aside.side' })
  const commit = page.locator('aside.side .fs-commit button', { hasText: /Commit teammate edits \(1\)/ })
  await commit.waitFor({ state: 'visible', timeout: 10_000 })
  await commit.click()
  await page.locator('aside.side .fs-commit button', { hasText: /Commit teammate edits \(0\)/ }).waitFor({ timeout: 10_000 })
  const log = git(root, 'log', '-1', '--name-only', '--format=%s')
  check(log.includes(INVENTORY_SERVICE), `last commit does not hold the Studio edit: ${log}`)

  // A cutscene module with child modules created in Studio: written to disk live.
  const [cut, ...cutKids] = CUTSCENE_NODES
  const added = await json(`${BASE}/sync/changes`, { session, place: { placeId: PLACE_ID }, changes: [{ kind: 'added', node: cut, descendants: cutKids }] })
  check(added.ok === true, `changes: ${JSON.stringify(added)}`)
  for (let i = 0; i < 40 && !CUTSCENE_FILES.every((f) => existsSync(join(root, f))); i++) await page.waitForTimeout(100)
  check(CUTSCENE_FILES.every((f) => existsSync(join(root, f))), 'the Studio-made module tree did not reach disk')
  // The disk loses it while Studio is closed (a branch switch); Studio reopens with it: rojo is held
  // and the section offers "Pull to disk" instead of letting Rojo delete it from Studio.
  rmSync(join(root, CUTSCENE_DIR), { recursive: true })
  const again = await json(`${BASE}/sync/config?placeId=${PLACE_ID}&gameId=9&place=E2E%20Place`)
  const withCutscene = [...studio.map((n) => (n.path.join('/') === INVENTORY_PATH.join('/') ? { ...n, source: text } : n)), ...CUTSCENE_NODES]
  for (let i = 0, seq = 0; i < withCutscene.length; i += chunk, seq++) {
    const r2 = await json(`${BASE}/sync/snapshot`, { session: String(again.sessionToken), place: { placeId: PLACE_ID, gameId: 9 }, seq, final: i + chunk >= withCutscene.length, nodes: withCutscene.slice(i, i + chunk) })
    check(r2.ok === true, `snapshot chunk ${seq}: ${JSON.stringify(r2)}`)
  }
  const callout = page.locator('aside.side .vsec.fs .fs-studio-only')
  await callout.waitFor({ state: 'visible', timeout: 10_000 })
  await waitText(page, /4 scripts exist only in Studio, not on disk yet\. Rojo would delete them from Studio when it connects, so rojo serve is held/, { within: 'aside.side .vsec.fs' })
  check(/4 not on disk/i.test(await gateText(page)), `gate pill shows "${await gateText(page)}", expected "4 not on disk"`)
  if (rojo) {
    // The reconnect stopped rojo at its config; held for the Studio-only scripts, it stays down.
    await until('rojo held for the Studio-only scripts', async () => (await rojoStatus(page))?.hold?.gate === 'blocked' && !(await rojoStatus(page))?.pid)
    check(rojo.serves().length === 1, `rojo served while Studio-only scripts were not on disk: ${rojo.serves().join(' | ')}`)
  }
  await callout.locator('button', { hasText: 'Pull to disk (4)' }).click()
  await page.waitForFunction(() => /clear/.test(document.querySelector('aside.side .vsec.fs .fs-place .tag')?.textContent ?? ''), undefined, { timeout: 10_000 }).catch(async () => {
    throw new Error(`gate pill shows "${await gateText(page)}" after Pull to disk, expected "clear"`)
  })
  check(CUTSCENE_FILES.every((f) => existsSync(join(root, f))), 'Pull to disk did not write the module tree')
  check(readFileSync(join(root, `${CUTSCENE_DIR}/Props/Toon.luau`), 'utf8') === 'return "toon"\n', 'Pull to disk wrote the wrong text')
  check((await callout.count()) === 0, 'the Studio-only callout stayed after Pull to disk')
  if (rojo) await until('rojo serving after Pull to disk', async () => rojo.serves().length === 2 && (await rojoStatus(page))?.state === 'running')
  const commitPulled = page.locator('aside.side .fs-commit button', { hasText: /Commit teammate edits \(4\)/ })
  await commitPulled.waitFor({ state: 'visible', timeout: 10_000 })
  await commitPulled.click()
  await page.locator('aside.side .fs-commit button', { hasText: /Commit teammate edits \(0\)/ }).waitFor({ timeout: 10_000 })
  note(`gate ${await gateText(page)}; commit "${log.split('\n')[0]}"; Studio-only cutscene pulled to disk`)
}

// Runs after the labs (needs the VFX preset the vfx-lab flow opened).
export const studioFlows: Flow[] = [
  {
    name: 'studio-check',
    title: 'Studio check with no Studio: clear "not connected" state',
    async run({ page, note }) {
      await openPage(page, 'VFX Lab')
      const detail = page.locator(`${CENTER} .vfx-detail`).first()
      if (!(await detail.count())) {
        const card = page.locator(`${CENTER} .vfx-card`).first()
        check(await card.count(), 'no VFX entry in the library (run vfx-lab first)')
        await card.click()
        await detail.waitFor({ state: 'visible', timeout: 10_000 })
      }
      await detail.locator('[role="tab"]', { hasText: /^studio$/ }).click()
      await page.waitForTimeout(500)
      const text = (await detail.innerText()).replace(/\s+/g, ' ')
      const hit = /(not connected|no studio|open roblox studio|install the forge bridge|connect studio|studio is not)[^.]*/i.exec(text)
      check(hit, `Studio tab shows no clear no-Studio state: ${text.slice(0, 300)}`)
      note(hit![0].slice(0, 140))
      await detail.locator('[role="tab"]', { hasText: /^params$/ }).click()
    }
  }
]
