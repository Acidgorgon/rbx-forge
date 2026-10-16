// Model Lab: with no model, Generate starts from the template (Lune preview, part count, thumbnail,
// rename, delete); after 'fake-provider', a prompt + a reference image -> the fake model's BlockyKit
// script -> the preview -> a critic round on the preview snapshots (the fake critic keeps it).

import { check, CENTER, dismissToasts, openPage, SkipFlow, canvasInk } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { ModelEntry } from '../../../src/shared/model/types.ts'
import type { Flow } from './types.ts'

// An 8 x 8 red PNG (the reference image the AI flow attaches).
const RED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4YWODFTEMLQkAZZlQAVIPr1MAAAAASUVORK5CYII=', 'base64')

const count = (page: Page) => page.evaluate(() => window.harness.modelList().then((l) => l.length))

// Waits for the detail's part count; returns it, or throws SkipFlow when the preview needs Lune.
async function partCount(page: Page): Promise<number> {
  const detail = page.locator(`${CENTER} [data-testid="model-detail"]`)
  await detail.waitFor({ state: 'visible', timeout: 30_000 })
  const hud = detail.locator('[data-testid="model-part-count"]')
  await hud.waitFor({ state: 'visible', timeout: 30_000 })
  const status = await page.evaluate(() => window.harness.modelStatus())
  if (!status.lune.available) {
    const err = (await detail.locator('.vfx-canvas-err').innerText().catch(() => '')).replace(/\s+/g, ' ')
    check(/Lune/i.test(err), `no-Lune build message is unclear: "${err}"`)
    throw new SkipFlow(`Model Lab preview needs Lune (set LUNE_PATH); the preview says "${err.slice(0, 120)}"`)
  }
  for (let i = 0; i < 60; i++) {
    const n = Number((await hud.innerText()).replace(/[^\d]/g, ''))
    if (n > 0) return n
    await page.waitForTimeout(250)
  }
  throw new Error(`the part count stayed at 0: ${(await detail.innerText()).slice(0, 300)}`)
}

export const modelFlows: Flow[] = [
  {
    name: 'model-lab-no-key',
    title: 'Model Lab with no model: Generate uses the egg template, Lune preview with a part count, rename, delete',
    timeoutMs: 120_000,
    async run({ page, note, shot }) {
      await dismissToasts(page)
      await openPage(page, 'Model Lab')
      const before = await count(page)
      await page.locator(`${CENTER} [data-testid="model-template-egg"]`).click()
      await page.locator(`${CENTER} [data-testid="model-prompt"]`).fill('pig egg')
      await page.locator(`${CENTER} [data-testid="model-generate"]`).click()
      for (let i = 0; i < 120 && (await count(page)) <= before; i++) await page.waitForTimeout(250)
      check((await count(page)) === before + 1, 'Generate saved no model')
      const toast = (await page.locator('.toast').allInnerTexts()).join(' ').replace(/\s+/g, ' ')
      check(/No AI model is set up/.test(toast), `no "No AI model" note after Generate without a provider: "${toast.slice(0, 200)}"`)
      const n = await partCount(page)
      check(n > 100 && n < 2500, `egg template part count ${n}`)
      const ink = await canvasInk(page, `${CENTER} [data-testid="model-detail"] canvas`)
      check(ink > 0.02, `the 3D preview looks empty (ink ${ink.toFixed(3)})`)
      await shot('egg')
      // The preview's snapshot becomes the library thumbnail.
      await page.locator(`${CENTER} [data-testid="model-card"] img`).first().waitFor({ state: 'visible', timeout: 15_000 })
      // Rename (click the title), then delete with the confirm dialog.
      const detail = page.locator(`${CENTER} [data-testid="model-detail"]`)
      await detail.locator('button.model-title').click()
      const nameBox = detail.getByLabel('Model name')
      await nameBox.fill('E2E Pig Egg')
      await nameBox.press('Enter')
      await page.locator(`${CENTER} [data-testid="model-card"]`, { hasText: 'E2E Pig Egg' }).waitFor({ timeout: 10_000 })
      page.once('dialog', (d: { accept(): Promise<void> }) => void d.accept())
      await detail.getByRole('button', { name: /Delete/ }).click()
      for (let i = 0; i < 40 && (await count(page)) > before; i++) await page.waitForTimeout(250)
      check((await count(page)) === before, 'Delete left the model in the library')
      note(`egg template: ${n} parts, ink ${ink.toFixed(2)}; renamed and deleted`)
    }
  }
]

export const modelAiFlows: Flow[] = [
  {
    name: 'model-lab-ai',
    title: 'Model Lab with the fake model: prompt + reference -> BlockyKit script -> preview -> critic round on snapshots',
    timeoutMs: 180_000,
    async run({ page, fake, note, shot }) {
      await dismissToasts(page)
      await openPage(page, 'Model Lab')
      const status = await page.evaluate(() => window.harness.modelStatus())
      if (!status.lune.available) throw new SkipFlow('the Model Lab preview needs Lune (set LUNE_PATH)')
      check(status.vision, 'the Model Lab does not see the fake provider')
      await page.evaluate(() => window.harness.modelSetSettings({ critic: true, rounds: 1 }))
      await page.reload()
      await page.locator('nav.activity').waitFor({ state: 'visible', timeout: 30_000 })
      await openPage(page, 'Model Lab')
      await page.locator(`${CENTER} [data-testid="model-template-guard"]`).click()
      await page.locator(`${CENTER} [data-testid="model-prompt"]`).fill('spiky ice wolf guard')
      await page.locator(`${CENTER} .model-make input[type="file"]`).setInputFiles({ name: 'ref.png', mimeType: 'image/png', buffer: RED_PNG })
      await page.locator(`${CENTER} [data-testid="model-refs"] img`).waitFor({ state: 'visible', timeout: 5000 })
      const sent = fake.requests.length
      await page.locator(`${CENTER} [data-testid="model-generate"]`).click()
      await page.locator(`${CENTER} [data-testid="model-progress"]`).waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator(`${CENTER} [data-testid="model-progress"]`).waitFor({ state: 'detached', timeout: 150_000 })
      const reqs = fake.requests.slice(sent)
      const write = reqs.find((r) => r.rule === 'model-lab-write')
      check(write, `no Model Lab script request reached the fake model (${reqs.map((r) => r.rule).join(', ')})`)
      check(/Kit:wireGuard\(/.test(write.system) && /Make: spiky ice wolf guard/.test(write.user) && /1 reference image attached/.test(write.user), 'the script request lacks the kit API, the prompt or the reference')
      const n = await partCount(page)
      const list: ModelEntry[] = await page.evaluate(() => window.harness.modelList())
      const entry = list.find((e) => e.prompt === 'spiky ice wolf guard')
      check(entry, 'the generated model is not in the library')
      check(entry.origin === 'ai' && /FAKE-MODEL-LAB/.test(entry.script), `the saved script is not the fake model's (${entry.origin})`)
      check(entry.refs.length === 1, 'the reference image was not kept with the model')
      const critic = reqs.find((r) => r.rule === 'model-lab-critic')
      if (critic) {
        check(entry.critic?.length === 1 && entry.critic[0].frames.length === 3 && !entry.critic[0].changed, `critic round not recorded: ${JSON.stringify(entry.critic)}`)
        await page.locator(`${CENTER} [data-testid="model-detail"] [role="tab"]`, { hasText: 'critic' }).click()
        await page.locator(`${CENTER} .model-round`).first().waitFor({ state: 'visible', timeout: 5000 })
        await page.locator(`${CENTER} .model-frames img`).first().waitFor({ state: 'visible', timeout: 10_000 })
      } else {
        const why = entry.critic?.[0]?.error ?? (await page.locator('.toast').allInnerTexts()).join(' ')
        note(`no critic request (offscreen capture unavailable?): ${why.slice(0, 160)}`)
      }
      await shot('guard')
      note(`fake guard script: ${n} parts; critic ${critic ? 'kept it after 3 snapshots' : 'skipped'}`)
    }
  }
]
