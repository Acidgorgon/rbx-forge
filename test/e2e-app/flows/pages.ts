// Every wide page opens without errors; Settings sections; Memory; theme; narrow window.
// PAGES is the table to extend when a new activity-bar page lands (label = the button's aria-label,
// expect = text the page shows once loaded).

import { horizontalOverflow, check, CENTER, mod, openPage, setTheme, SkipFlow, waitText } from '../lib/ui.ts'
import { setWindowSize, type Page } from '../lib/app.ts'
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
  { label: 'Thumbnail Lab', expect: /Thumbnail/i, narrow: true },
  { label: 'UI Motion Lab', expect: /Motion/i, narrow: true },
  { label: 'UI Preview (stories)', expect: /stor/i, narrow: true },
  { label: 'Memory & skills', expect: /Memory/i, narrow: true },
  { label: 'Settings', expect: /Settings/i, narrow: true }
]

// Settings > Labs model dropdowns (pages/settings/LabModelSelect.tsx), shared with the provider flow in ai.ts.
const LABS = '#set-labs'
export type LabsTierLabel = 'Cheap' | 'Default' | 'Critic'

export async function openLabsSettings(page: Page): Promise<void> {
  await openPage(page, 'Settings')
  await page.locator('nav.set-nav button', { hasText: 'Labs' }).click()
  await labsTier(page, 'Cheap').waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForFunction(() => !(document.querySelector('#set-labs button[aria-label="Cheap model for the Labs"]') as HTMLButtonElement | null)?.disabled, undefined, { timeout: 5000 })
}

export function labsTier(page: Page, tier: LabsTierLabel) {
  return page.locator(`${LABS} button[aria-label="${tier} model for the Labs"]`)
}

// Opens a tier's dropdown and returns its list.
export async function openLabsDropdown(page: Page, tier: LabsTierLabel) {
  const pop = page.locator(`${LABS} [role="listbox"][aria-label="${tier} model"]`)
  if (!(await pop.isVisible())) await labsTier(page, tier).click()
  await pop.waitFor({ state: 'visible', timeout: 3000 })
  return pop
}

export async function waitLabModels(page: Page, ok: (m: Record<string, string | undefined>) => boolean, message: string): Promise<void> {
  let last: Record<string, string | undefined> = {}
  for (const end = Date.now() + 5000; Date.now() < end; await page.waitForTimeout(100)) {
    last = (await page.evaluate(() => window.harness.getLabModels())) as Record<string, string | undefined>
    if (ok(last)) return
  }
  throw new Error(`${message}: ${JSON.stringify(last)}`)
}

export const SETTINGS_SECTIONS = ['Appearance', 'Default model', 'Chat', 'Providers', 'Usage', 'Budgets', 'Labs', 'Integrations', 'Places', 'Sync', 'Toolchain', 'Notifications', 'Updates']

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
    name: 'quiet-pages',
    title: 'Analytics with no key: calm empty state, no Roblox calls; Packages: at most one GitHub rate-limit line',
    timeoutMs: 60_000,
    async run({ page, note }) {
      await openPage(page, 'Analytics')
      await page.locator(`${CENTER} [aria-label="Analytics needs a key"]`).waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
        throw new Error('no "add an Open Cloud key" empty state on Analytics without a key')
      })
      check(!(await page.locator(`${CENTER} .kpi.skeleton`).count()), 'Analytics still shows loading KPIs without a key')
      await openPage(page, 'Packages (Wally, Rokit)')
      await page.locator(`${CENTER} [role="tab"]`, { hasText: 'Tools' }).first().click()
      await page.waitForTimeout(8000) // the release checks (GitHub) run now
      const logs = (await page.evaluate(() => window.harness.getLogs())) as { text: string; stream: string }[]
      const analytics = logs.filter((l) => /\[analytics\]/.test(l.text))
      check(analytics.length === 0, `analytics logged without a key: ${analytics[0]?.text}`)
      const rate = logs.filter((l) => /GitHub API rate limit/.test(l.text))
      check(rate.length <= 1, `${rate.length} GitHub rate-limit log lines`)
      if (rate.length) {
        const shown = await page.locator(`${CENTER} [role="note"]`, { hasText: /GitHub rate limited.*retry at/ }).count()
        check(shown > 0, 'rate limited, but the Tools tab does not say until when')
      }
      note(rate.length ? `GitHub rate limited (1 log line, note on the Tools tab)` : 'GitHub reachable or offline: no rate-limit line')
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
    name: 'ui-preview-900',
    title: 'UI Preview at 900px with the Assistant open: usable stage, panels as tabs, console wraps normally',
    timeoutMs: 60_000,
    async run({ app, page, shot, note }) {
      await setWindowSize(app, 900, 800)
      try {
        await page.waitForFunction(() => window.innerWidth <= 900, undefined, { timeout: 5000 })
        if ((await page.locator('aside.panel.right').getAttribute('aria-hidden')) === 'true') await page.keyboard.press(`${mod}+L`)
        await openPage(page, 'UI Preview (stories)')
        const wrap = page.locator(`${CENTER} .uip-wrap`)
        await wrap.waitFor({ state: 'visible', timeout: 10_000 })
        const w = (await wrap.boundingBox())!.width
        const main = page.locator(`${CENTER} .uip-main`)
        if (w <= 720) {
          const tabs = page.locator(`${CENTER} .uip-narrow-tabs`)
          check(await tabs.isVisible(), `editor area ${Math.round(w)}px wide but the pane tabs are hidden`)
          await tabs.getByRole('tab', { name: 'Preview' }).click()
          check(await main.isVisible(), 'the Preview tab does not show the stage')
          const mw = (await main.boundingBox())!.width
          check(mw >= w - 24, `stage pane is ${Math.round(mw)}px of ${Math.round(w)}px`)
          await tabs.getByRole('tab', { name: 'Stories' }).click()
          await page.locator(`${CENTER} .uip-side`).waitFor({ state: 'visible', timeout: 3000 })
          check(!(await main.isVisible()), 'Stories and Preview are both shown in narrow mode')
          await shot('stories')
          const story = page.locator(`${CENTER} .uip-story`).first()
          if (await story.count()) {
            await story.click()
            await main.waitFor({ state: 'visible', timeout: 3000 })
          } else await tabs.getByRole('tab', { name: 'Preview' }).click()
          await tabs.getByRole('tab', { name: /Controls|Inspector/ }).click()
          await page.locator(`${CENTER} .uip-right`).waitFor({ state: 'visible', timeout: 3000 })
          await tabs.getByRole('tab', { name: 'Preview' }).click()
          note(`editor area ${Math.round(w)}px: one pane at a time (Stories / Preview / Controls)`)
        } else {
          const mw = (await main.boundingBox())!.width
          check(mw >= 320, `stage column is only ${Math.round(mw)}px wide`)
          note(`editor area ${Math.round(w)}px: three columns, stage ${Math.round(mw)}px`)
        }
        // Console lines: the message column must not collapse to a few characters.
        const narrowest = await page.evaluate(() => Math.min(...[...document.querySelectorAll('.editor-area .uip-msg')].map((m) => m.getBoundingClientRect().width).filter((x) => x > 0), Infinity))
        if (narrowest !== Infinity) check(narrowest >= 120, `a console message is only ${Math.round(narrowest)}px wide`)
        const o = await horizontalOverflow(page)
        check(o.doc <= o.win + 1 && !o.offenders.length, `overflow: ${o.offenders.slice(0, 3).join(', ')}`)
        await shot('preview')
      } finally {
        await setWindowSize(app, 1400, 900)
      }
    }
  },
  {
    name: 'digest-900',
    title: 'Away digest is an inline banner: at 900px it covers no lab button (VFX, Animation, Ability, Thumbnail, UI Motion)',
    timeoutMs: 90_000,
    async run({ app, page, shot, note }) {
      await setWindowSize(app, 900, 800)
      try {
        await page.waitForFunction(() => window.innerWidth <= 900, undefined, { timeout: 5000 })
        await openPage(page, 'VFX Lab')
        // The "Show digest" command (the automatic one is answered once per project open).
        await page.evaluate(() => window.dispatchEvent(new CustomEvent('forge:show-digest')))
        const d = page.locator('section.qol-digest')
        const shown = await d.waitFor({ state: 'visible', timeout: 8000 }).then(() => true, () => false)
        if (!shown) throw new SkipFlow('the digest had nothing to show (no Studio edits, commits or lab runs since the last session)')
        check(await page.locator(`${CENTER} section.qol-digest`).count(), 'the digest is not inside the editor area')
        const bad: string[] = []
        for (const label of ['VFX Lab', 'Animation Lab', 'Ability Composer', 'Thumbnail Lab', 'UI Motion Lab']) {
          await openPage(page, label)
          await page.waitForTimeout(300)
          const hits = await covered(page)
          if (hits.length) bad.push(`${label}: ${hits.slice(0, 3).join(', ')}`)
          await shot(label.split(' ')[0].toLowerCase())
        }
        note(`digest: ${(await d.locator('.qol-digest-sub').innerText()).replace(/\s+/g, ' ')}`)
        await d.getByRole('button', { name: 'Got it' }).click()
        await d.waitFor({ state: 'hidden', timeout: 5000 })
        check(bad.length === 0, `digest covers buttons: ${bad.join(' | ')}`)
      } finally {
        await setWindowSize(app, 1400, 900)
      }
    }
  },
  {
    name: 'labs-settings',
    title: 'Settings > Labs: model tier dropdowns (Auto, Custom…, search), decision gates / models switches',
    async run({ page }) {
      await openLabsSettings(page)
      const sec = page.locator(LABS)
      const cheap = labsTier(page, 'Cheap')
      // Every tier starts on Auto, and the button says what Auto is.
      for (const t of ['Cheap', 'Default', 'Critic'] as const) {
        check((await labsTier(page, t).getAttribute('data-kind')) === 'auto', `${t} does not start on Auto`)
        check(/^Auto\b/.test((await labsTier(page, t).innerText()).trim()), `${t} button: ${await labsTier(page, t).innerText()}`)
      }
      // Open: Auto first (selected), then provider groups, then Custom… last.
      let pop = await openLabsDropdown(page, 'Cheap')
      const kinds = await pop.locator('[role="option"]').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-kind')))
      check(kinds[0] === 'auto' && kinds[kinds.length - 1] === 'custom-edit', `option order: ${kinds.join(', ')}`)
      check((await pop.locator('[role="option"][data-kind="auto"]').getAttribute('aria-selected')) === 'true', 'Auto is not selected')
      check(/provider's cheap tier/.test(await pop.locator('[role="option"][data-kind="auto"]').innerText()), 'Auto entry does not say what it means')
      // Custom…: reveals the text field; any id saves as typed.
      await pop.locator('[role="option"][data-kind="custom-edit"]').click()
      const custom = sec.locator('input[aria-label="Cheap custom model id for the Labs"]')
      await custom.waitFor({ state: 'visible', timeout: 3000 })
      await custom.fill('e2e-cheap-model')
      await custom.press('Enter')
      await waitLabModels(page, (m) => m.cheap === 'e2e-cheap-model', 'Custom… id not saved')
      await page.waitForFunction(() => document.querySelector('#set-labs button[aria-label="Cheap model for the Labs"]')?.getAttribute('data-kind') === 'custom', undefined, { timeout: 3000 })
      check((await cheap.innerText()).includes('Custom: e2e-cheap-model'), `custom value shows as ${await cheap.innerText()}`)
      // A stored custom id shows as the selected "Custom: <id>" entry; Auto clears it (empty string).
      pop = await openLabsDropdown(page, 'Cheap')
      const sel = pop.locator('[role="option"][aria-selected="true"]')
      check((await sel.count()) === 1 && (await sel.innerText()).includes('Custom: e2e-cheap-model'), 'the custom id is not the selected entry')
      await pop.locator('[role="option"][data-kind="auto"]').click()
      await waitLabModels(page, (m) => !m.cheap, 'Auto did not clear the cheap tier')
      await custom.waitFor({ state: 'hidden', timeout: 3000 })
      // Typing an unlisted id in the dropdown's search and pressing Enter uses it as a custom id.
      pop = await openLabsDropdown(page, 'Critic')
      await pop.locator('.mpick-search input').fill('e2e-critic-id')
      await pop.locator('.mpick-search input').press('Enter')
      await waitLabModels(page, (m) => m.critic === 'e2e-critic-id', 'typed id not saved')
      pop = await openLabsDropdown(page, 'Critic')
      await pop.locator('[role="option"][data-kind="auto"]').click()
      await waitLabModels(page, (m) => !m.critic, 'Auto did not clear the critic tier')
      // Escape closes the list without changing anything.
      pop = await openLabsDropdown(page, 'Default')
      await page.keyboard.press('Escape')
      await pop.waitFor({ state: 'hidden', timeout: 3000 })
      const left = await page.evaluate(() => window.harness.getLabModels())
      check(Object.keys(left).length === 0, `Labs models not back to auto: ${JSON.stringify(left)}`)
      // Settings search still finds the tiers by name.
      const search = page.locator('input[aria-label="Search settings"]')
      await search.fill('critic model')
      const hits = page.locator('ul.set-hits .set-hit-t')
      await hits.first().waitFor({ state: 'visible', timeout: 3000 })
      const texts = await hits.allInnerTexts()
      check(texts.some((t: string) => /Critic model for the Labs/.test(t)), `search "critic model" hits: ${texts.join(' | ')}`)
      await search.fill('cheap')
      await page.waitForFunction(() => [...document.querySelectorAll('ul.set-hits .set-hit-t')].some((e) => e.textContent === 'Cheap'), undefined, { timeout: 3000 })
      await search.fill('')
      await page.locator('nav.set-nav button', { hasText: 'Labs' }).click()
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

// Visible buttons of the current page whose box overlaps the digest's box.
async function covered(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const d = document.querySelector('section.qol-digest')
    if (!d) return []
    const r = d.getBoundingClientRect()
    const out: string[] = []
    for (const b of document.querySelectorAll('.editor-area .view button')) {
      if (d.contains(b)) continue
      const q = b.getBoundingClientRect()
      if (!q.width || !q.height) continue
      const x = Math.min(r.right, q.right) - Math.max(r.left, q.left)
      const y = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top)
      if (x > 2 && y > 2) out.push((b.textContent ?? '').trim().slice(0, 30) || b.getAttribute('aria-label') || 'button')
    }
    return out
  })
}
