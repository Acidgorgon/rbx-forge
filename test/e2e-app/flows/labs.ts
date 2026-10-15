// The labs: VFX Lab, textures, Animation Lab, Ability Composer, Video references, UI Preview.

import { PLUGIN_VERSION } from '../../../src/shared/studio/plugin.ts'
import { SEL_DATA_TAG, SEL_PROGRESS_TAG } from '../../../src/shared/vfx/studioImport.ts'
import { BRIDGE_PORT } from '../lib/app.ts'
import { canvasInk, check, CENTER, closeBottom, dismissToasts, openPage, SkipFlow } from '../lib/ui.ts'
import type { Flow } from './types.ts'

const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}/forge-bridge`

async function bridgeJson(url: string, body?: unknown): Promise<Record<string, any>> {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) })
  return (await r.json()) as Record<string, any>
}

// What the Studio import module sends for a selected VFX folder (Studio's JSON shape): effect
// Models, duplicate names, a loose Part with a Trail, one effect twice under two names.
function studioPackMessages(): string[] {
  let id = 0
  const n = (className: string, name: string, children: unknown[] = [], props: Record<string, unknown> = {}) => ({ id: `s${++id}`, className, name, props: Object.keys(props).length ? props : [], children })
  const emitter = (rate: number, color: number[]) => n('ParticleEmitter', 'Sparks', [], { Rate: rate, Color: [{ t: 0, c: color }, { t: 1, c: color }], Size: [{ t: 0, v: 1, e: 0 }, { t: 1, v: 0, e: 0 }], Lifetime: [0.4, 0.8], LightEmission: 1 })
  const model = (name: string, rate: number, color = [1, 0.5, 0.1]) => n('Model', name, [n('Part', 'Root', [n('Attachment', 'At', [emitter(rate, color)])], { Transparency: 1, Size: [1, 1, 1], CFrame: [0, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] })])
  const kids = [model('AuraImpact', 11), model('Barrage', 12, [0.2, 0.6, 1]), model('Slash', 13), model('Slash', 14), model('Slash', 15), model('Impact', 16), model('Impact', 17), model('QuickDash', 18, [1, 1, 1]), model('ActivateFX', 19, [0.7, 0.3, 1])]
  const a0 = n('Attachment', 'A0', [], { CFrame: [0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] })
  const a1 = n('Attachment', 'A1', [], { CFrame: [0, -1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] })
  kids.push(n('Part', 'Trail', [a0, a1, n('Trail', 'Trail', [], { Attachment0: a0.id, Attachment1: a1.id, Lifetime: 0.3 })], { Transparency: 1, Size: [1, 1, 1], CFrame: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }))
  for (let i = 1; i <= 3; i++) kids.push(model(`Extra${i}`, 30 + i))
  kids.push(model('Copy of Barrage', 12, [0.2, 0.6, 1]))
  const payload = JSON.stringify({ kind: 'nodes', roots: [n('Folder', 'VFX', kids)], paths: ['ReplicatedStorage.VFX'], count: id, truncated: false })
  const pieces: string[] = []
  for (let i = 0; i < payload.length; i += 4000) pieces.push(payload.slice(i, i + 4000))
  return [`${SEL_PROGRESS_TAG} ${kids.length}/${kids.length} Copy of Barrage`, ...pieces.map((p, i) => `${SEL_DATA_TAG} ${i + 1}/${pieces.length} ${p}`)]
}

// What a lab says when no model provider is configured (the no-key flows assert one of these).
export const NO_PROVIDER = /no (model )?provider|api key|add a model|not configured|no model|set up a (model|provider)|could not (restate|reach)|provider/i

export const labFlows: Flow[] = [
  {
    name: 'vfx-lab',
    title: 'VFX Lab: load a preset, preview renders, edit params, timeline',
    timeoutMs: 90_000,
    async run({ page, shot, note }) {
      await openPage(page, 'VFX Lab')
      await closeBottom(page)
      await page.locator(`${CENTER} .vfx-examples button`, { hasText: 'Hollow Purple' }).click()
      const canvas = `${CENTER} .vfx-detail canvas`
      await page.locator(canvas).first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator(canvas).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(1500)
      const ink = await canvasInk(page, canvas)
      check(ink > 0.02, `preview canvas looks blank (${(ink * 100).toFixed(1)}% non-background)`)
      note(`preview ink ${(ink * 100).toFixed(0)}%`)
      // Timeline: keyboard scrub moves the playhead.
      const tl = page.getByRole('slider', { name: 'Timeline' }).first()
      if (await tl.count()) {
        await tl.focus()
        await tl.press('Home')
        const t0 = Number(await tl.getAttribute('aria-valuenow'))
        await tl.press('End')
        const t1 = Number(await tl.getAttribute('aria-valuenow'))
        check(t1 > t0, `timeline End did not move the playhead (${t0} -> ${t1})`)
        await tl.press('PageUp')
      } else note('no timeline strip on this preset')
      // Params: change the first numeric param and see it stick.
      await page.locator(`${CENTER} [role="tab"]`, { hasText: /^params$/ }).click()
      const num = page.locator(`${CENTER} .vfx-num input[type="number"]`).first()
      await num.waitFor({ state: 'visible', timeout: 5000 })
      const label = await num.getAttribute('aria-label')
      const before = Number(await num.inputValue())
      const next = Math.round((before + (before >= 1 ? 1 : 0.1)) * 1000) / 1000
      await num.fill(String(next))
      await num.press('Tab')
      await page.waitForTimeout(500)
      const after = Number(await num.inputValue())
      check(Math.abs(after - next) < 1e-6, `param ${label} did not take ${next} (shows ${after})`)
      await shot('params')
      // Script tab renders.
      await page.locator(`${CENTER} [role="tab"]`, { hasText: /^script/ }).click()
      await page.waitForTimeout(400)
      await page.locator(`${CENTER} [role="tab"]`, { hasText: /^params$/ }).click()
    }
  },
  {
    name: 'vfx-refine-no-key',
    title: 'VFX Lab with no model: Refine runs on the automatic checks (no crash)',
    timeoutMs: 90_000,
    async run({ page, shot, note }) {
      await openPage(page, 'VFX Lab')
      const refine = page.locator(`${CENTER} button`, { hasText: /^\s*Refine\s*$/ }).first()
      check(await refine.count(), 'no Refine button (preset not open?)')
      await refine.click()
      // Done (iterations listed) or stopped with an error toast.
      const failed = page.locator('.toast', { hasText: /Refine (stopped|failed)/ }).first()
      const done = page.locator(`${CENTER} [role="tab"]`, { hasText: /^iterations · \d+/ }).first()
      await Promise.race([failed.waitFor({ timeout: 60_000 }), done.waitFor({ timeout: 60_000 })])
      await shot('refine')
      if (await failed.isVisible().catch(() => false)) {
        const logs = await page.evaluate(() => window.harness.getLogs())
        const vfx = logs.filter((l: { text: string }) => /\[vfx\]|\[gating\]/.test(l.text)).slice(-5).map((l: { text: string }) => l.text)
        throw new Error(`Refine with no model failed: ${(await failed.innerText()).replace(/\s+/g, ' ')} ${vfx.join(' / ')}`)
      }
      note(`refined: ${(await done.innerText()).trim()}`)
    }
  },
  {
    name: 'textures',
    title: 'VFX Lab textures: procedural generator previews and adds a texture',
    timeoutMs: 60_000,
    async run({ page, note }) {
      await openPage(page, 'VFX Lab')
      await page.locator(`${CENTER} [role="tab"]`, { hasText: /^textures$/ }).click()
      const gen = page.locator(`${CENTER} section[aria-label="Make a texture"]`)
      await gen.waitFor({ state: 'visible', timeout: 10_000 })
      const shapes = gen.locator('[aria-label="Shape"] button')
      check((await shapes.count()) > 1, 'no procedural shapes listed')
      await shapes.nth(1).click()
      const img = gen.locator('.tex-live img')
      await img.waitFor({ state: 'visible', timeout: 10_000 })
      const src1 = await img.getAttribute('src')
      // A parameter slider changes the live preview.
      const slider = gen.locator('.tex-opts input[type="range"]').first()
      await slider.focus()
      for (let i = 0; i < 5; i++) await slider.press('ArrowRight')
      await page.waitForFunction((before: string | null) => document.querySelector('section[aria-label="Make a texture"] .tex-live img')?.getAttribute('src') !== before, src1, { timeout: 5000 })
      const cards = page.locator(`${CENTER} .tex-card`)
      const n0 = await cards.count()
      await gen.getByRole('button', { name: /Add texture/ }).click()
      await page.waitForFunction((n: number) => document.querySelectorAll('.editor-area .tex-card').length > n, n0, { timeout: 15_000 })
      note(`textures: ${n0} -> ${await cards.count()}`)
      check(!(await gen.locator('[aria-pressed="true"]', { hasText: /AI/ }).count()), 'AI generator should not be selectable without an OpenAI key')
      await page.locator(`${CENTER} [role="tab"]`, { hasText: /^effects$/ }).click()
    }
  },
  {
    name: 'anim-lab',
    title: 'Animation Lab: R6/R15 switch, example clip preview renders',
    timeoutMs: 90_000,
    async run({ page, note }) {
      await openPage(page, 'Animation Lab')
      await closeBottom(page)
      const rig = page.locator(`${CENTER} [role="radiogroup"][aria-label="Rig for new clips"]`)
      await rig.waitFor({ state: 'visible', timeout: 10_000 })
      const sub = page.locator(`${CENTER} .page-head .sub`).first()
      await rig.getByRole('radio', { name: 'R6' }).click()
      await page.waitForFunction(() => /^R6 ·/.test(document.querySelector('.editor-area .page-head .sub')?.textContent ?? ''), undefined, { timeout: 5000 })
      await page.locator(`${CENTER} .vfx-examples button`, { hasText: 'Dash punch' }).click()
      const canvas = `${CENTER} .vfx-detail canvas`
      await page.locator(canvas).first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator(canvas).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(1500)
      const ink = await canvasInk(page, canvas)
      check(ink > 0.01, `R6 clip preview looks blank (${(ink * 100).toFixed(1)}%)`)
      check(await page.locator(`${CENTER} .anim-rig-b`, { hasText: 'R6' }).count(), 'the R6 example has no R6 badge')
      await rig.getByRole('radio', { name: 'R15' }).click()
      await page.waitForFunction(() => /^R15 ·/.test(document.querySelector('.editor-area .page-head .sub')?.textContent ?? ''), undefined, { timeout: 5000 })
      note(`${(await sub.innerText()).trim()}; preview ink ${(ink * 100).toFixed(0)}%`)
    }
  },
  {
    name: 'ability',
    title: 'Ability Composer: example move opens with a rendering preview',
    timeoutMs: 90_000,
    async run({ page, note }) {
      await openPage(page, 'Ability Composer')
      await closeBottom(page)
      await page.locator(`${CENTER} .vfx-examples button, ${CENTER} button.badge-o`, { hasText: 'Hollow Purple' }).first().click()
      await page.locator(`${CENTER} .ab-detail`).first().waitFor({ state: 'visible', timeout: 15_000 })
      const canvas = `${CENTER} .ab-detail canvas`
      await page.locator(canvas).first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(1500)
      const ink = await canvasInk(page, canvas)
      check(ink > 0.01, `ability preview looks blank (${(ink * 100).toFixed(1)}%)`)
      note(`preview ink ${(ink * 100).toFixed(0)}%`)
    }
  },
  {
    name: 'video-ref',
    title: 'Video reference import dialog opens and closes',
    async run({ page }) {
      await openPage(page, 'VFX Lab')
      await page.locator(`${CENTER} button`, { hasText: 'Video ref' }).first().click()
      const dialog = page.locator('[role="dialog"][aria-label="Import a video reference"]')
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      check(await dialog.getByLabel('Choose a clip').count(), 'no "Choose a clip" control')
      await dialog.getByLabel('Close').first().click()
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
    }
  },
  {
    name: 'ui-preview',
    title: 'UI Preview: open the Counter story, click it in Interact mode',
    timeoutMs: 90_000,
    async run({ page, note }) {
      await openPage(page, 'UI Preview (stories)')
      // A narrow editor area shows one pane at a time: pick the Stories tab.
      const tabs = page.locator(`${CENTER} .uip-narrow-tabs`)
      if (await tabs.isVisible().catch(() => false)) await tabs.getByRole('tab', { name: 'Stories' }).click()
      const story = page.locator(`${CENTER} .uip-story`, { hasText: 'Counter' }).first()
      await story.waitFor({ state: 'visible', timeout: 15_000 })
      if (await page.locator(`${CENTER} .uip-hint`).isVisible().catch(() => false)) {
        const hint = (await page.locator(`${CENTER} .uip-hint`).innerText()).trim()
        check(/lune/i.test(hint), `no-Lune hint is unclear: ${hint}`)
        throw new SkipFlow(`Lune not available (set LUNE_PATH); page shows: "${hint}"`)
      }
      await story.click()
      await page.locator(`${CENTER} .uip-group button, ${CENTER} [aria-label="Mode"] button`, { hasText: 'Interact' }).first().click()
      const btn = page.locator(`${CENTER} .uip-stage .uip-node.uip-btn`).first()
      await btn.waitFor({ state: 'visible', timeout: 30_000 })
      await page.waitForFunction(() => /Clicks: 0/.test(document.querySelector('.editor-area .uip-stage')?.textContent ?? ''), undefined, { timeout: 15_000 })
      await btn.click()
      await page.waitForFunction(() => /Clicks: 1/.test(document.querySelector('.editor-area .uip-stage')?.textContent ?? ''), undefined, { timeout: 15_000 })
      note('Counter went 0 -> 1 on click')
    }
  },
  {
    name: 'labs-make-no-key',
    title: 'Animation Lab / Ability Composer Make with no model: built-in draft or a clear message',
    timeoutMs: 120_000,
    async run({ page, note }) {
      const cases = [
        { page: 'Animation Lab', input: 'input[aria-label="Animation to make"]', list: () => page.evaluate(() => window.harness.animList().then((l) => l.length)) },
        { page: 'Ability Composer', input: 'input[aria-label="Move to make"]', list: () => page.evaluate(() => window.harness.abilityList().then((l) => l.length)) }
      ]
      for (const c of cases) {
        await dismissToasts(page)
        await openPage(page, c.page)
        const before: number = await c.list()
        await page.locator(`${CENTER} ${c.input}`).fill('a quick jab')
        await page.locator(`${CENTER} ${c.input}`).press('Enter')
        let after = before
        let toast = ''
        for (let i = 0; i < 120 && after <= before && !toast; i++) {
          await page.waitForTimeout(500)
          after = await c.list()
          toast = (await page.locator('.toast', { hasText: /Could not|failed/i }).allInnerTexts()).join(' ').replace(/\s+/g, ' ')
        }
        if (toast) {
          check(!/undefined|TypeError|Cannot read/i.test(toast), `${c.page}: crash-like error: ${toast}`)
          note(`${c.page}: ${toast.slice(0, 160)}`)
        } else {
          check(after > before, `${c.page}: Make did nothing for 60 s (no entry, no message)`)
          note(`${c.page}: drafted without a model (${before} -> ${after})`)
        }
      }
    }
  },
  {
    name: 'vfx-studio-import',
    title: 'VFX Lab: Import from Studio (fake plugin) -> review (named from tags) -> import, learn offer, select + delete + undo, duplicates, Make remixes an imported effect',
    needs: ['bridgePort'],
    timeoutMs: 120_000,
    async run({ page, shot, note }) {
      await openPage(page, 'VFX Lab')
      await closeBottom(page)
      await dismissToasts(page)
      const before = (await page.evaluate(() => window.harness.vfxList())).length
      // The fake Forge Bridge plugin: a held poll (Studio connected) that receives the read job.
      const poll = bridgeJson(`${BRIDGE}/poll?v=${PLUGIN_VERSION}&place=VFX%20Pack&placeId=0`)
      await page.waitForTimeout(400)
      await page.locator(`${CENTER} [data-testid="vfx-import-studio"]`).click()
      const got = await poll
      check(got.job?.entry === 'ForgeVfxRead', `the plugin got ${JSON.stringify(got).slice(0, 200)}`)
      check(!/:Destroy\(|Selection:Set/.test(got.job.modules[0].source), 'the read job changes the place')
      const post = (ev: unknown) => bridgeJson(`${BRIDGE}/event/${got.job.id}`, ev)
      await post({ type: 'accepted' })
      for (const m of studioPackMessages()) await post({ type: 'log', message: m })
      await post({ type: 'done', marks: [] })
      const lastSeen = Date.now()
      // The review: one row per effect, duplicate names numbered, the repeated effect unchecked.
      const rows = page.locator(`${CENTER} [data-testid="vfx-import-row"]`)
      await rows.first().waitFor({ state: 'visible', timeout: 15_000 })
      check((await rows.count()) === 14, `review rows: ${await rows.count()}`)
      const names = await rows.locator('input[aria-label="Name"]').evaluateAll((els: HTMLInputElement[]) => els.map((e) => e.value))
      // Named from their tags by default ("AuraImpact" -> "Aura Impact"; the loose "Trail" part is its
      // own row), duplicate original names numbered; the original name shows as "from: ...".
      check(names.includes('Slash (3)') && names.includes('Impact (2)') && names.includes('Aura Impact') && names.some((x: string) => /Trail$/.test(x)), `review names: ${names.join(', ')}`)
      check(await rows.filter({ hasText: 'from: AuraImpact' }).count() === 1, 'the review does not show the original name')
      // The toggle switches the review to the original names and back.
      const tagToggle = page.locator(`${CENTER} [data-testid="vfx-import-tagnames"]`)
      check(await tagToggle.isChecked(), '"Name effects from tags" is off by default')
      await tagToggle.uncheck()
      check((await rows.locator('input[aria-label="Name"]').evaluateAll((els: HTMLInputElement[]) => els.map((e) => e.value))).includes('AuraImpact'), 'toggle off keeps the tag names')
      await tagToggle.check()
      check((await rows.locator('input[aria-label="Name"]').evaluateAll((els: HTMLInputElement[]) => els.map((e) => e.value))).includes('Aura Impact'), 'toggle on does not name from tags')
      check(await rows.filter({ hasText: /same effect as/ }).count() === 1, 'the repeated effect is not marked')
      await shot('review')
      await page.locator(`${CENTER} [data-testid="vfx-import-commit"]`).click()
      await page.locator(`${CENTER} [data-testid="vfx-learn-offer"]`).waitFor({ state: 'visible', timeout: 20_000 })
      const after = (await page.evaluate(() => window.harness.vfxList())).length
      check(after - before === 13, `imported ${after - before} (expected 13)`)
      note(`library ${before} -> ${after}`)
      const aura = (await page.evaluate(() => window.harness.vfxList())).find((e: { sourceName?: string }) => e.sourceName === 'AuraImpact') as { name: string; nameFrom?: string } | undefined
      check(aura?.name === 'Aura Impact' && aura.nameFrom === 'tags', `AuraImpact imported as ${JSON.stringify(aura)}`)
      check(await page.locator(`${CENTER} [data-testid="vfx-card-from"]`, { hasText: 'from: AuraImpact' }).count() === 1, 'the card does not show the original name')
      await dismissToasts(page)
      // Select two cards (Ctrl-click), delete them, undo. "Extra1".. are named from their tags now:
      // the search finds them by their original names.
      const cards = page.locator(`${CENTER} .vfx-card`)
      await page.locator(`${CENTER} .vfx-lib-head input`).fill('Extra')
      await page.waitForTimeout(300)
      check((await cards.count()) === 3, `search Extra shows ${await cards.count()}`)
      await cards.nth(0).click({ modifiers: ['Control'] })
      await cards.nth(1).click({ modifiers: ['Control'] })
      await page.locator(`${CENTER} [data-testid="vfx-delete-selected"]`).click()
      await page.waitForFunction(() => document.querySelectorAll('.editor-area .vfx-card').length === 1, undefined, { timeout: 10_000 })
      await page.locator('.toast button', { hasText: 'Undo' }).first().click()
      await page.waitForFunction(() => document.querySelectorAll('.editor-area .vfx-card').length === 3, undefined, { timeout: 10_000 })
      await page.locator(`${CENTER} .vfx-lib-head input`).fill('')
      await dismissToasts(page)
      // Find duplicates: none (the repeat was not imported).
      await page.locator(`${CENTER} button`, { hasText: 'Find duplicates' }).click()
      await page.locator(`${CENTER} section[aria-label="Duplicates"]`, { hasText: /no duplicates|imported more than once/ }).waitFor({ timeout: 10_000 })
      const dupText = await page.locator(`${CENTER} section[aria-label="Duplicates"]`).innerText()
      check(/no duplicates/.test(dupText), `duplicates: ${dupText.replace(/\s+/g, ' ')}`)
      await page.locator(`${CENTER} button[aria-label="Close duplicates"]`).click()
      // Tag filters by group.
      check(await page.locator(`${CENTER} .vfx-tag-groups [role="group"]`).count() >= 1, 'no tag filter rows')
      // Make (single, 3 variations) remixes one of the imported slashes and keeps the best variation.
      await page.locator(`${CENTER} .vfx-mode button`, { hasText: /^single$/ }).click()
      await page.locator(`${CENTER} [data-testid="vfx-variations"] button`, { hasText: /^3$/ }).click()
      await page.locator(`${CENTER} input[aria-label="Effect to make"]`).fill('orange slash')
      await page.locator(`${CENTER} .vfx-make-row button.primary`).click()
      const isMade = (e: { origin?: string; kind?: string }) => e.kind === 'generated' && e.origin === 'orange slash'
      await page
        .waitForFunction(() => window.harness.vfxList().then((l: { origin?: string; kind?: string }[]) => l.some((e) => e.kind === 'generated' && e.origin === 'orange slash')), undefined, { timeout: 45_000, polling: 500 })
        .catch(() => null)
      const made = (await page.evaluate(() => window.harness.vfxList())).find(isMade) as { id: string; basedOn?: string[]; pick?: { of: number } } | undefined
      check(!!made, 'Make did not save the effect')
      check(!!made!.basedOn?.length, 'the made effect is not based on a library effect')
      check(made!.pick?.of === 3, `variations: ${JSON.stringify(made!.pick)}`)
      await page.evaluate((id: string) => window.harness.vfxCancel(id), made!.id)
      await page.locator(`${CENTER} .vfx-detail [role="tab"]`, { hasText: /^info$/ }).click()
      const from = page.locator(`${CENTER} [data-testid="vfx-made-from"]`)
      await from.waitFor({ state: 'visible', timeout: 10_000 })
      check(/Slash/.test(await from.innerText()), `made from: ${await from.innerText()}`)
      await shot('made-from')
      note(`made ${made!.id} from ${made!.basedOn!.join(', ')}`)
      await page.evaluate((id: string) => window.harness.vfxTrash([id]), made!.id)
      await dismissToasts(page)
      // Clean up what this flow added (the trash is emptied on the next start).
      const ids = (await page.evaluate(() => window.harness.vfxList())).filter((e: { origin?: string }) => (e.origin ?? '').startsWith('ReplicatedStorage.VFX')).map((e: { id: string }) => e.id)
      await page.evaluate((x: string[]) => window.harness.vfxTrash(x), ids)
      await dismissToasts(page)
      // Later flows expect no Studio: wait until the fake plugin no longer counts as connected.
      await page.waitForTimeout(Math.max(0, lastSeen + 16_000 - Date.now()))
    }
  }
]
