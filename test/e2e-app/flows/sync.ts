// Forge Sync against the real app's Forge Bridge (127.0.0.1:34877): the suite plays the Studio
// plugin over HTTP the way test/syncE2E.test.ts does, but through the running app, and checks the
// disk, the gate pill and the "Commit teammate edits" button. Also the Sync settings and the Studio
// check states with no Studio.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPlaces, placeFor } from '../../../src/main/services/sync/mapping.ts'
import { edit, studioFromDisk } from '../../syncFixture.ts'
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

async function json(url: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
  return (await r.json()) as Record<string, unknown>
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
    async run({ page, root, note }) {
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
      note(`gate ${await gateText(page)}; commit "${log.split('\n')[0]}"`)
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
