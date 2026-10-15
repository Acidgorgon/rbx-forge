// Small UI helpers shared by the flows. Selectors lean on aria-labels and visible text so they survive
// styling changes; add a helper here when two flows need the same gesture.

import type { Page } from './app.ts'

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

export class FlowError extends Error {}

// Thrown by a flow that cannot run in this environment (missing native module, port in use...).
// The runner records it as 'skip' with the message; the flow should first check that the app shows
// a clear state for the missing piece.
export class SkipFlow extends Error {}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new FlowError(message)
}

// Activity-bar entry by its aria-label (Explorer, Scripts, VFX Lab, Settings...).
export async function activity(page: Page, label: string): Promise<void> {
  await page.locator(`nav.activity button[aria-label="${label}"]`).click()
}

// Opens a side view (Explorer, Scripts...) and makes sure it ends up open (the buttons toggle).
export async function showSide(page: Page, label: string): Promise<void> {
  const btn = page.locator(`nav.activity button[aria-label="${label}"]`)
  if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click()
  await page.waitForFunction((l: string) => document.querySelector(`nav.activity button[aria-label="${l}"]`)?.getAttribute('aria-pressed') === 'true', label, { timeout: 5000 })
}

// Opens a wide page (VFX Lab, Settings...) and waits for its tab to be active.
export async function openPage(page: Page, label: string): Promise<void> {
  await activity(page, label)
  await page.waitForFunction((l: string) => document.querySelector(`nav.activity button[aria-label="${l}"]`)?.getAttribute('aria-pressed') === 'true', label, { timeout: 5000 })
  await page.waitForTimeout(300)
}

// Visible text somewhere in the given root (default the whole window).
export async function waitText(page: Page, text: string | RegExp, opts: { timeout?: number; within?: string } = {}): Promise<void> {
  const root = opts.within ? page.locator(opts.within) : page
  await root.getByText(text).first().waitFor({ state: 'visible', timeout: opts.timeout ?? 10_000 })
}

export async function hasText(page: Page, text: string | RegExp, within?: string): Promise<boolean> {
  const root = within ? page.locator(within) : page
  return (await root.getByText(text).count()) > 0
}

export async function bodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText)
}

// The editor area's active view (pages and files render here; the bottom panel is outside it).
export const CENTER = '.editor-area'

// Elements wider than the window (horizontal overflow), ignoring scroll containers that are meant to
// scroll sideways (tab strips, code, terminals, canvases).
export async function horizontalOverflow(page: Page): Promise<{ doc: number; win: number; offenders: string[] }> {
  return page.evaluate(() => {
    const win = window.innerWidth
    const doc = document.documentElement.scrollWidth
    const offenders: string[] = []
    const skip = (el: Element) => !!el.closest('.monaco-editor, .xterm, canvas, .tabs, .tab-strip, pre, code, [data-scroll-x]')
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0 || skip(el)) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      // Clipped by an ancestor that hides or scrolls overflow: fine.
      let p = el.parentElement
      let clipped = false
      while (p && p !== document.body) {
        const s = getComputedStyle(p)
        if (/(hidden|auto|scroll|clip)/.test(s.overflowX) && p.getBoundingClientRect().right <= win + 1) {
          clipped = true
          break
        }
        p = p.parentElement
      }
      if (!clipped && r.right > win + 1) offenders.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} right=${Math.round(r.right)}`)
      if (offenders.length >= 8) break
    }
    return { doc, win, offenders }
  })
}

// Fraction of non-background pixels in a canvas (WebGL canvases are read through a screenshot).
export async function canvasInk(page: Page, selector: string): Promise<number> {
  const canvas = page.locator(selector).first()
  await canvas.waitFor({ state: 'visible', timeout: 10_000 })
  const png: Buffer = await canvas.screenshot()
  return page.evaluate(async (b64: string) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const bg = [d[0], d[1], d[2]]
    let ink = 0
    for (let i = 0; i < d.length; i += 16) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 30) ink++
    }
    return ink / (d.length / 16)
  }, png.toString('base64'))
}

// Clicks a button by its accessible name (exact text by default).
export async function clickButton(page: Page, name: string | RegExp, within?: string): Promise<void> {
  const root = within ? page.locator(within) : page
  await root.getByRole('button', { name, exact: typeof name === 'string' }).first().click()
}

export async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press(`${mod}+K`)
  const input = page.locator('.palette input').first()
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await input.fill(`>${query}`)
}

// Settings shows one category at a time: click a section in the left rail (Appearance, Editor, Usage...).
export async function settingsSection(page: Page, label: string): Promise<void> {
  await page.locator('nav.set-nav button', { hasText: label }).first().click()
}

// Settings > Appearance > Theme (Dark / Light / System).
export async function setTheme(page: Page, label: 'Dark' | 'Light' | 'System'): Promise<void> {
  await settingsSection(page, 'Appearance')
  await page.locator('#set-appearance [role="radio"]', { hasText: label }).first().click()
}

// Closes the bottom panel (more room for pages); no-op when it is closed.
export async function closeBottom(page: Page): Promise<void> {
  if (await page.locator('.app.bottom-off').count()) return
  await page.locator('section.panel.bottom .bp-head button[title^="Close"]').click()
  await page.locator('.app.bottom-off').waitFor({ state: 'attached', timeout: 5000 })
}

// Closes every toast (so a later check does not read an earlier flow's message).
export async function dismissToasts(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const x = page.locator('.toast button[aria-label="Dismiss"]').first()
    if (!(await x.count())) return
    // Short timeout: a toast that times out between count() and click() would otherwise hold the
    // click for Playwright's default 30 s.
    await x.click({ timeout: 2000 }).catch(() => undefined)
    await page.waitForTimeout(250)
  }
}

// The "Since your last session" digest opens over the page 3.5 s after a project open or a renderer
// reload; close it so it does not cover buttons. Returns its summary line when it was shown.
export async function dismissDigest(page: Page, waitMs = 6000): Promise<string> {
  const d = page.locator('section.qol-digest[aria-label="Since you were away"]')
  const shown = await d.waitFor({ state: 'visible', timeout: waitMs }).then(() => true, () => false)
  if (!shown) return ''
  const sub = (await d.locator('.qol-digest-sub').innerText().catch(() => '')).replace(/\s+/g, ' ')
  await d.getByRole('button', { name: 'Got it' }).click()
  await d.waitFor({ state: 'hidden', timeout: 5000 })
  return sub
}
