// Art page fullscreen viewer: two concepts written into art/concepts, then the lightbox opened from
// the detail's Fullscreen button, the preview, a thumbnail double-click and F; zoom to 100%, step with
// the arrow keys, and close with Esc and the close button. A long reference file name truncates in its
// chip instead of running over "+ Reference image". No image backend is needed.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '../../../src/main/services/vfx/textures/png.ts'
import { check, CENTER, openPage } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A w x h PNG: a transparent field with an opaque block in the middle (reads on any backdrop).
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x < w / 4 || x > (w * 3) / 4 || y < h / 4 || y > (h * 3) / 4) continue
      data.set([...rgb, 255], (y * w + x) * 4)
    }
  return encodePng({ width: w, height: h, data })
}

const LB = '[data-testid="lightbox"]'

async function open(page: Page, how: () => Promise<void>, label: string): Promise<void> {
  await how()
  await page.locator(LB).waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
    throw new Error(`the fullscreen viewer did not open from ${label}`)
  })
  await page.locator(`${LB} .lb-stage img`).waitFor({ state: 'visible', timeout: 5000 })
}

async function closeWithEsc(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.locator(LB).waitFor({ state: 'detached', timeout: 3000 }).catch(() => {
    throw new Error('Esc did not close the fullscreen viewer')
  })
}

export const artFlows: Flow[] = [
  {
    name: 'art-lightbox',
    title: 'Art: a concept opens fullscreen (button, preview, double-click, F), zooms to 100%, steps, closes with Esc',
    async run({ page, root, shot, note }) {
      const dir = join(root, 'art', 'concepts', today())
      mkdirSync(dir, { recursive: true })
      // The second has the long name that once ran over the "+ Reference image" button.
      const LONG = 'need-couple-fifa-rematch-styled-ui-game-2'
      const files = [join(dir, 'e2e-lightbox-1.png'), join(dir, `${LONG}.png`)]
      writeFileSync(files[0], png(640, 360, [224, 122, 95]))
      writeFileSync(files[1], png(200, 200, [111, 168, 220]))
      try {
        // The page loads the gallery when it opens; re-open once if it was already showing.
        await openPage(page, 'Art (image concepts)')
        const card = page.locator(`${CENTER} .art-card`, { hasText: 'e2e-lightbox-1' })
        if (!(await card.isVisible().catch(() => false))) {
          await openPage(page, 'Settings')
          await openPage(page, 'Art (image concepts)')
        }
        await card.waitFor({ state: 'visible', timeout: 10_000 })
        await card.click()
        const detail = page.locator(`${CENTER} .art-detail`)
        await detail.waitFor({ state: 'visible', timeout: 5000 })
        await detail.scrollIntoViewIfNeeded()
        await shot('detail')

        // Header button: portal on <body>, 640x360 fitted, then 100% with the 1 key, Esc closes.
        await open(page, () => detail.getByRole('button', { name: /Fullscreen/ }).click(), 'the Fullscreen button')
        check(await page.evaluate((s: string) => document.querySelector(s)?.parentElement === document.body, LB), 'the viewer is not portalled into <body>')
        check(/e2e-lightbox-1\.png/.test(await page.locator(`${LB} .lb-name`).innerText()), 'the viewer does not name the concept')
        check(/640×360/.test(await page.locator(`${LB} .lb-detail`).innerText()), 'the viewer does not show the size')
        await page.keyboard.press('1')
        await page.waitForFunction((s: string) => document.querySelector(`${s} .lb-pct`)?.textContent === '100%', LB, { timeout: 3000 })
        // The zoom eases (unless motion is reduced): wait for it to settle at 640px.
        const width = () => page.locator(`${LB} .lb-stage img`).evaluate((img: Element) => Math.round(img.getBoundingClientRect().width))
        await page.waitForFunction((s: string) => Math.abs((document.querySelector(`${s} .lb-stage img`)?.getBoundingClientRect().width ?? 0) - 640) <= 2, LB, { timeout: 3000 }).catch(async () => {
          throw new Error(`at 100% the image is ${await width()}px wide, not 640`)
        })
        // The wheel zooms (in, over the stage), 0 goes back to fit.
        const pct = () => page.locator(`${LB} .lb-pct`).innerText()
        const box = (await page.locator(`${LB} .lb-stage`).boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, -400)
        await page.waitForFunction((s: string) => document.querySelector(`${s} .lb-pct`)?.textContent !== '100%', LB, { timeout: 3000 }).catch(() => {
          throw new Error('the wheel did not zoom')
        })
        check(parseInt(await pct()) > 100, `the wheel zoomed out to ${await pct()}`)
        await page.keyboard.press('0')
        check(await page.locator(`${LB} .lb-seg button[aria-pressed="true"]`, { hasText: 'Fit' }).count(), '0 did not go back to fit')
        // Background cycles checkerboard -> dark -> light (opaque art starts on dark).
        const bg = page.locator(`${LB} button[aria-label^="Background:"]`)
        check((await bg.getAttribute('aria-label')) === 'Background: dark', `opaque art opened on ${await bg.getAttribute('aria-label')}`)
        await bg.click()
        check(await page.locator(`${LB} .lb-stage.lb-light`).count(), 'the background toggle did not switch to light')
        await bg.click()
        check(await page.locator(`${LB} .lb-stage.lb-checker`).count(), 'the background toggle did not switch to the checkerboard')
        await shot('fullscreen')
        await closeWithEsc(page)

        // Preview image; the arrow keys step through the gallery; the close button closes.
        await open(page, () => detail.getByRole('button', { name: 'View fullscreen' }).click(), 'the preview')
        const first = await page.locator(`${LB} .lb-name`).innerText()
        const [at, of] = (await page.locator(`${LB} .lb-count`).innerText()).split('/').map((n: string) => Number(n.trim()))
        check(of >= 2, `the viewer counts ${of} concepts, expected at least 2`)
        const [away, back] = at < of ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight']
        await page.keyboard.press(away)
        await page.waitForFunction(([s, n]: string[]) => document.querySelector(`${s} .lb-name`)?.textContent !== n, [LB, first], { timeout: 3000 }).catch(() => {
          throw new Error(`${away} did not step to another concept`)
        })
        await page.keyboard.press(back)
        await page.waitForFunction(([s, n]: string[]) => document.querySelector(`${s} .lb-name`)?.textContent === n, [LB, first], { timeout: 3000 }).catch(() => {
          throw new Error(`${back} did not step back`)
        })
        await page.locator(`${LB} button[aria-label="Close fullscreen"]`).click()
        await page.locator(LB).waitFor({ state: 'detached', timeout: 3000 })

        // Thumbnail double-click, then F with the concept selected.
        await open(page, () => page.locator(`${CENTER} .art-card`, { hasText: LONG }).dblclick(), 'a thumbnail double-click')
        check((await page.locator(`${LB} .lb-name`).innerText()) === `${LONG}.png`, 'double-click opened another concept')
        await closeWithEsc(page)
        check(await page.locator(`${CENTER} .art-detail`).isVisible(), 'Esc in the viewer also closed the detail pane')
        await open(page, () => page.keyboard.press('f'), 'the F key')
        await closeWithEsc(page)

        // A thumbnail dropped on the prompt box becomes a reference chip: it truncates, keeps the full
        // path as its tooltip, and never overlaps the "+ Reference image" button.
        const compose = page.locator(`${CENTER} .art-compose`)
        const rel = `art/concepts/${today()}/${LONG}.png`
        const dt = await page.evaluateHandle((p: string) => {
          const d = new DataTransfer()
          d.setData('text/x-forge-art', p)
          return d
        }, rel)
        await compose.dispatchEvent('drop', { dataTransfer: dt })
        const chip = compose.locator('.art-ref', { hasText: 'need-couple' })
        await chip.waitFor({ state: 'visible', timeout: 3000 })
        check(((await chip.getAttribute('title')) ?? '').endsWith(`${LONG}.png`), 'the chip tooltip is not the full path')
        const name = chip.locator('.art-ref-name')
        check(await name.evaluate((el: Element) => el.scrollWidth > el.clientWidth || getComputedStyle(el).textOverflow === 'ellipsis'), 'the chip name does not truncate')
        const a = await chip.boundingBox()
        const b = await compose.getByRole('button', { name: /Reference image/ }).boundingBox()
        check(a && b && (a.x + a.width <= b.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1), 'the reference chip overlaps the "+ Reference image" button')
        await chip.scrollIntoViewIfNeeded()
        await shot('ref-chip')
        await chip.getByRole('button', { name: /^Remove/ }).click()
        note('opened from the button, preview, double-click and F; 100% is 640px; arrows step; Esc and × close')
      } finally {
        for (const f of files) rmSync(f, { force: true })
        rmSync(join(dir, 'e2e-lightbox-1.json'), { force: true })
        rmSync(join(dir, 'e2e-lightbox-2.json'), { force: true })
      }
    }
  }
]
