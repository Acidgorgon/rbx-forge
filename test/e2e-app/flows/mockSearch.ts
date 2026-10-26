// Mock-renderer flow (test/e2e-app/mock.ts): the Search view on the browser mocks (mocks/mockSearch.ts
// searches the mock files with the app's own matcher). Ctrl+Shift+F opens it, typing searches, Match Case
// / Whole Word / regex (an invalid one shows inline), include / exclude globs, a click opens the file with
// the match selected, the replacement preview, Replace All asks first and reports, a file with unsaved
// edits is left alone, the editor's selection seeds the query, and the palette lists both commands.

import { check, CENTER, mod, palette } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { MockFlow } from './mockArt.ts'

const SIDE = 'aside.side'
const SHARED_INVENTORY = 'src/shared/Features/Inventory/init.luau'

const box = (page: Page, label: string) => page.locator(`${SIDE} input[aria-label="${label}"]`)

async function paths(page: Page): Promise<string[]> {
  return page.locator(`${SIDE} .srch-group`).evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-path') ?? ''))
}

// Waits for the search to settle on a number of result files.
async function results(page: Page, files: number): Promise<void> {
  await page.waitForFunction(
    (n: number) => document.querySelectorAll('aside.side .srch-group').length === n && document.querySelector('aside.side .srch-results')?.getAttribute('aria-busy') === 'false',
    files,
    { timeout: 8000 }
  )
}

async function pressToggle(page: Page, name: string): Promise<void> {
  await page.locator(`${SIDE} button[aria-label^="${name}"]`).first().click()
}

export const mockSearchFlows: MockFlow[] = [
  {
    name: 'search-panel',
    title: 'Search (mock): Ctrl+Shift+F, toggles, regex error, globs, open at the match, replace preview, Replace All confirm, unsaved file skipped, selection seeds the query',
    async run({ page, shot, note }) {
      // The "since your last session" card covers the editor.
      await page.locator('.qol-digest-foot').waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined)
      if (await page.locator('.qol-digest-foot').count()) await page.locator('.qol-digest-foot').getByRole('button', { name: 'Got it' }).click()

      // Ctrl+Shift+F opens the view with the search box focused.
      await page.keyboard.press(`${mod}+Shift+F`)
      await page.waitForFunction(() => document.querySelector('nav.activity button[aria-label="Search"]')?.getAttribute('aria-pressed') === 'true', undefined, { timeout: 5000 })
      const find = box(page, 'Search')
      await find.waitFor({ state: 'visible', timeout: 5000 })
      check(await find.evaluate((el: HTMLElement) => document.activeElement === el), 'the search box is not focused')
      check((await page.locator(`${SIDE}`).innerText()).includes('Type to search'), 'no hint before the first search')

      // Typing searches (debounced): groups per file, a count, the line number and the highlighted match.
      await find.fill('DEFAULT_CAPACITY')
      await results(page, 1)
      check((await paths(page))[0] === SHARED_INVENTORY, `unexpected result file ${await paths(page)}`)
      check((await page.locator(`${SIDE} .srch-sum`).innerText()).startsWith('2 results in 1 file'), `summary: ${await page.locator(`${SIDE} .srch-sum`).innerText()}`)
      const lines = await page.locator(`${SIDE} .srch-match .srch-ln`).allInnerTexts()
      check(lines.length === 2 && lines.every((l: string) => /^\d+$/.test(l)), `line numbers: ${lines}`)
      check((await page.locator(`${SIDE} .srch-match mark`).first().innerText()) === 'DEFAULT_CAPACITY', 'the match is not highlighted')
      await shot('results')

      // Match Case, Whole Word and the toggles' state.
      await find.fill('default_capacity')
      await results(page, 1)
      await pressToggle(page, 'Match Case')
      await results(page, 0)
      check((await page.locator(`${SIDE}`).innerText()).includes('No results found'), 'no "No results found" for a case miss')
      await pressToggle(page, 'Match Case')
      await results(page, 1)
      await pressToggle(page, 'Match Case')
      await find.fill('CAPACITY')
      await results(page, 1)
      await pressToggle(page, 'Match Whole Word')
      await results(page, 0)
      await pressToggle(page, 'Match Whole Word')
      await pressToggle(page, 'Match Case')

      // A regular expression that does not compile shows under the box and does not crash.
      await pressToggle(page, 'Use Regular Expression')
      await find.fill('(')
      await page.locator(`${SIDE} [role="alert"]`, { hasText: /Invalid regular expression/ }).waitFor({ state: 'visible', timeout: 5000 })
      await find.fill('DEFAULT_(CAPACITY)')
      await results(page, 1)
      check(!(await page.locator(`${SIDE} [role="alert"]`).count()), 'the regex error stayed after a valid query')

      // Files to include / exclude (under the ellipsis).
      await pressToggle(page, 'Use Regular Expression')
      await find.fill('Inventory')
      await page.waitForFunction(() => document.querySelectorAll('aside.side .srch-group').length >= 3 && document.querySelector('aside.side .srch-results')?.getAttribute('aria-busy') === 'false', undefined, { timeout: 8000 })
      const all = (await paths(page)).length
      check(all >= 3, `only ${all} files mention Inventory`)
      await pressToggle(page, 'Toggle Search Details')
      await page.locator(`${SIDE} #srch-include`).fill('src/server')
      await page.waitForFunction(() => [...document.querySelectorAll('aside.side .srch-group')].every((g) => g.getAttribute('data-path')?.startsWith('src/server/')) && document.querySelectorAll('aside.side .srch-group').length > 0, undefined, { timeout: 8000 })
      await page.locator(`${SIDE} #srch-exclude`).fill('*.server.luau')
      await page.waitForFunction(() => [...document.querySelectorAll('aside.side .srch-group')].every((g) => !g.getAttribute('data-path')?.endsWith('.server.luau')), undefined, { timeout: 8000 })
      check((await paths(page)).every((p) => p.startsWith('src/server/') && !p.endsWith('.server.luau')), `globs: ${await paths(page)}`)
      await page.locator(`${SIDE} #srch-include`).fill('')
      await page.locator(`${SIDE} #srch-exclude`).fill('')
      await pressToggle(page, 'Toggle Search Details')

      // Replace: the preview strikes the match and shows the new text; Replace All asks first.
      await find.fill('DEFAULT_(CAPACITY)')
      await pressToggle(page, 'Use Regular Expression')
      await pressToggle(page, 'Toggle Replace')
      const replaceBox = box(page, 'Replace')
      await replaceBox.fill('MAX_$1')
      await results(page, 1)
      await page.locator(`${SIDE} .srch-match ins`).first().waitFor({ state: 'visible', timeout: 5000 })
      check((await page.locator(`${SIDE} .srch-match ins`).first().innerText()) === 'MAX_CAPACITY' && (await page.locator(`${SIDE} .srch-match del`).first().innerText()) === 'DEFAULT_CAPACITY', 'replacement preview is wrong')
      await shot('preview')
      await page.locator(`${SIDE} button[aria-label="Replace All"]`).click()
      const dialog = page.getByRole('dialog', { name: /^Replace 2 matches in 1 file\?/ })
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      const body = await dialog.innerText()
      check(body.includes(SHARED_INVENTORY) && body.includes('.forge/sync/trash'), `the confirm does not list the file and the copy: ${body}`)
      await dialog.getByRole('button', { name: 'Replace 2 matches', exact: true }).click()
      await page.locator('.toast', { hasText: /^Replaced 2 matches in 1 file/ }).first().waitFor({ state: 'visible', timeout: 5000 })
      await results(page, 0)
      await pressToggle(page, 'Use Regular Expression')
      await pressToggle(page, 'Toggle Replace')
      await find.fill('DEFAULT_CAPACITY')
      await results(page, 0)
      await find.fill('MAX_CAPACITY')
      await results(page, 1)

      // Click a match: the file opens with the match selected.
      await page.locator(`${SIDE} .srch-match`).first().click()
      await page.locator(`${CENTER} .monaco-editor`).first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(() => /Ln 20,\s*Col 23\s*\(12 sel\)/.test(document.body.textContent ?? ""), undefined, { timeout: 5000 })
      await shot('opened')

      // A file with unsaved edits is left alone: Replace says so and the disk text stays.
      // (Autosave on focus change would save the edit as soon as the search panel takes focus.)
      await page.evaluate(() => window.harness.editorAssistSetSettings({ autoSave: 'off' }))
      await page.keyboard.press(`${mod}+End`)
      await page.keyboard.type('-- unsaved')
      await pressToggle(page, 'Toggle Replace')
      await box(page, 'Replace').fill('Cap')
      await page.locator(`${SIDE} .srch-file .tag`, { hasText: 'unsaved' }).waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(`${SIDE} button[aria-label="Replace All"]`).click()
      await page.locator('.toast', { hasText: /has unsaved changes/ }).first().waitFor({ state: 'visible', timeout: 5000 })
      check(!(await page.getByRole('dialog').count()), 'a confirm opened for a file that is skipped')
      await results(page, 1)
      await pressToggle(page, 'Toggle Replace')

      await page.evaluate(() => window.harness.editorAssistSetSettings({ autoSave: 'onFocusChange' }))

      // The editor's selection seeds the query (Ctrl+Shift+F in the editor).
      await page.locator(`${CENTER} .monaco-editor .view-lines`).first().click()
      await page.keyboard.press(`${mod}+Home`)
      await page.keyboard.press('Shift+End')
      await page.keyboard.press(`${mod}+Shift+F`)
      await page.waitForFunction(() => (document.querySelector('aside.side input[aria-label="Search"]') as HTMLInputElement | null)?.value === '--!strict', undefined, { timeout: 5000 })

      // Clear Search Results empties the query and the list.
      await page.locator(`${SIDE} button[aria-label="Clear Search Results"]`).click()
      await results(page, 0)
      check((await find.inputValue()) === '', 'Clear did not empty the search box')

      // Both commands are in the palette.
      await palette(page, 'Search:')
      const labels = await page.locator('.palette').innerText()
      for (const c of ['Search: Find in Files', 'Search: Replace in Files']) check(labels.includes(c), `palette lacks "${c}"`)
      await page.keyboard.press('Escape')
      note('searched, toggled, globs, opened at the match, replaced with confirm, skipped an unsaved file, selection seeded the query')
    }
  }
]
