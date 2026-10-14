// The labs: VFX Lab, textures, Animation Lab, Ability Composer, Video references, UI Preview.

import { canvasInk, check, CENTER, closeBottom, dismissToasts, openPage, SkipFlow } from '../lib/ui.ts'
import type { Flow } from './types.ts'

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
  }
]
