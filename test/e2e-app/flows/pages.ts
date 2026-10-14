// Every wide page opens without errors; Settings sections; Memory; theme; narrow window.
// PAGES is the table to extend when a new activity-bar page lands (label = the button's aria-label,
// expect = text the page shows once loaded).

import { horizontalOverflow, check, CENTER, openPage, setTheme, waitText } from '../lib/ui.ts'
import { setWindowSize } from '../lib/app.ts'
import type { Flow } from './types.ts'

export interface PageSpec {
  label: string
  expect: string | RegExp
  // Checked at 900px wide for horizontal overflow.
  narrow?: boolean
}

export const PAGES: PageSpec[] = [
  { label: 'Group chats', expect: /group chat/i },
  { label: 'Packages (Wally, Rokit)', expect: /Wally|Packages/i, narrow: true },
  { label: 'Release', expect: /Release/i, narrow: true },
  { label: 'Analytics', expect: /Analytics/i },
  { label: 'Art (image concepts)', expect: /Art|concept/i },
  { label: 'VFX Lab', expect: /VFX/i, narrow: true },
  { label: 'Animation Lab', expect: /Animation/i, narrow: true },
  { label: 'Ability Composer', expect: /Ability/i, narrow: true },
  { label: 'UI Preview (stories)', expect: /stor/i, narrow: true },
  { label: 'Memory & skills', expect: /Memory/i, narrow: true },
  { label: 'Settings', expect: /Settings/i, narrow: true }
]

export const SETTINGS_SECTIONS = ['Appearance', 'Default model', 'Chat', 'Providers', 'Budgets', 'Labs', 'Places', 'Sync', 'Toolchain', 'Updates']

export const pageFlows: Flow[] = [
  {
    name: 'pages-open',
    title: 'Every activity-bar page opens without errors',
    timeoutMs: 120_000,
    async run({ page, shot, note }) {
      const slow: string[] = []
      for (const p of PAGES) {
        const t = Date.now()
        await openPage(page, p.label)
        await waitText(page, p.expect, { within: CENTER, timeout: 15_000 }).catch(() => {
          throw new Error(`${p.label}: never showed ${p.expect}`)
        })
        if (Date.now() - t > 3000) slow.push(`${p.label} ${Date.now() - t} ms`)
        await shot(p.label.split(' ')[0].toLowerCase())
      }
      if (slow.length) note(`slow to open: ${slow.join(', ')}`)
    }
  },
  {
    name: 'settings-sections',
    title: 'Settings: every section renders',
    async run({ page }) {
      await openPage(page, 'Settings')
      for (const s of SETTINGS_SECTIONS) {
        await page.locator('nav.set-nav button', { hasText: s }).first().click()
        await page.locator(`.set-sec h2`, { hasText: s }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {
          throw new Error(`Settings section "${s}" has no visible heading`)
        })
      }
    }
  },
  {
    name: 'theme',
    title: 'Theme switch dark / light (Settings and titlebar)',
    async run({ page, shot }) {
      await openPage(page, 'Settings')
      await setTheme(page, 'Light')
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'light', 'data-theme did not become light')
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      await shot('light')
      await setTheme(page, 'Dark')
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'data-theme did not go back to dark')
      const bg2 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      check(bg !== bg2, `body background did not change between themes (${bg})`)
    }
  },
  {
    name: 'narrow-900',
    title: 'Window at 900px: no horizontal overflow on main pages',
    timeoutMs: 120_000,
    async run({ app, page, shot }) {
      await setWindowSize(app, 900, 800)
      await page.waitForFunction(() => window.innerWidth <= 900, undefined, { timeout: 5000 })
      const bad: string[] = []
      try {
        for (const p of PAGES.filter((x) => x.narrow)) {
          await openPage(page, p.label)
          await page.waitForTimeout(400)
          const o = await horizontalOverflow(page)
          await shot(`900-${p.label.split(' ')[0].toLowerCase()}`)
          if (o.doc > o.win + 1 || o.offenders.length) {
            bad.push(`${p.label}: page ${o.doc}px > ${o.win}px; ${o.offenders.slice(0, 3).join(', ')}`)
            await shot(`overflow-${p.label.split(' ')[0].toLowerCase()}`)
          }
        }
      } finally {
        await setWindowSize(app, 1400, 900)
      }
      check(bad.length === 0, bad.join(' | '))
    }
  },
  {
    name: 'labs-settings',
    title: 'Settings > Labs: model tiers save, decision gates / models switches',
    async run({ page }) {
      await openPage(page, 'Settings')
      await page.locator('nav.set-nav button', { hasText: 'Labs' }).click()
      const sec = page.locator('#set-labs')
      const tier = sec.locator('input[aria-label$="model for the Labs"]').first()
      await tier.waitFor({ state: 'visible', timeout: 5000 })
      await page.waitForFunction(() => !(document.querySelector('#set-labs input[aria-label$="model for the Labs"]') as HTMLInputElement | null)?.disabled, undefined, { timeout: 5000 })
      await tier.fill('e2e-cheap-model')
      await tier.press('Enter')
      await page.waitForTimeout(400)
      const saved = (await page.evaluate(() => window.harness.getLabModels())) as unknown as Record<string, string>
      check(Object.values(saved).includes('e2e-cheap-model'), `tier not saved: ${JSON.stringify(saved)}`)
      await tier.fill('')
      await tier.press('Enter')
      for (const group of ['Decision gates', 'Decision models']) {
        const g = sec.locator(`[role="group"][aria-label="${group}"]`)
        for (const mode of ['On', 'Off', 'Shadow']) {
          await g.getByRole('button', { name: mode, exact: true }).click()
          await page.waitForFunction(([gr, m]: string[]) => document.querySelector(`#set-labs [role="group"][aria-label="${gr}"] button[aria-pressed="true"]`)?.textContent === m, [group, mode], { timeout: 5000 })
        }
      }
      const view = await page.evaluate(() => window.harness.labGatingView())
      check(view.settings.gates === 'shadow' && view.settings.models === 'shadow', `gating settings ${JSON.stringify(view.settings)}`)
    }
  },
  {
    name: 'memory',
    title: 'Memory page: new memory saves, lists and searches',
    async run({ page }) {
      await openPage(page, 'Memory & skills')
      await page.locator(`${CENTER} button.primary`, { hasText: 'New' }).click()
      await page.locator(`${CENTER} input[placeholder="kebab-case-name"]`).fill('e2e-memory-note')
      await page.locator(`${CENTER} input[placeholder^="One line"]`).fill('Forge e2e test memory')
      await page.locator(`${CENTER} textarea[aria-label="Body"]`).fill('The click-through suite wrote this.')
      await page.locator(`${CENTER} button.primary`, { hasText: 'Save' }).click()
      await page.locator(`${CENTER} [role="listbox"][aria-label="Memories"] [role="option"]`, { hasText: 'e2e-memory-note' }).waitFor({ timeout: 10_000 })
      await page.locator(`${CENTER} input[aria-label="Search memories and skills"]`).fill('e2e-memory')
      await page.waitForTimeout(500)
      const rows = await page.locator(`${CENTER} [role="listbox"][aria-label="Memories"] [role="option"]`).count()
      check(rows >= 1, 'search hid the new memory')
      const list = await page.evaluate(() => window.harness.memoryList())
      check(JSON.stringify(list).includes('e2e-memory-note'), 'memoryList does not include the new memory')
    }
  }
]
