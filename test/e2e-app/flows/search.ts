// Search view (views/SearchView.tsx, main/services/search.ts) against the real app and the fixture
// project: Ctrl+Shift+F, results from disk (not from node_modules / Packages / .forge), a click opens the
// file with the match selected, a regex error shows inline, Replace All asks first, writes through the
// app, keeps a copy under .forge/sync/trash and leaves a file with unsaved editor edits alone, and an open
// clean tab takes the replaced text.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../fixture.ts'
import { check, CENTER, dismissToasts, mod } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const SIDE = 'aside.side'
const A = 'src/shared/SearchProbeA.luau'
const B = 'src/server/SearchProbeB.luau'
const C = 'src/shared/SearchProbeC.luau'
const HIDDEN = ['node_modules/probe/x.luau', 'Packages/probe/init.luau']

const find = (page: Page) => page.locator(`${SIDE} input[aria-label="Search"]`)

async function settled(page: Page, files: number): Promise<void> {
  await page.waitForFunction(
    (n: number) => document.querySelectorAll('aside.side .srch-group').length === n && document.querySelector('aside.side .srch-results')?.getAttribute('aria-busy') === 'false',
    files,
    { timeout: 15_000 }
  )
}

async function disk(page: Page, root: string, rel: string, pred: (s: string) => boolean, what: string): Promise<string> {
  let text = ''
  for (let i = 0; i < 60; i++) {
    text = readFileSync(join(root, rel), 'utf8')
    if (pred(text)) return text
    await page.waitForTimeout(100)
  }
  check(false, `${what}; ${rel} has ${JSON.stringify(text)}`)
  return text
}

export const searchFlows: Flow[] = [
  {
    name: 'search-in-files',
    title: 'Search: Ctrl+Shift+F, results skip node_modules / Packages, open at the match, regex error, Replace All with confirm and a copy, unsaved file left alone',
    timeoutMs: 90_000,
    async run({ page, root, note, shot }) {
      await dismissToasts(page)
      write(root, A, 'local probe_old = 1\nprint(probe_old)\n')
      write(root, B, '-- probe_old in a comment\n')
      write(root, C, 'return {} -- Probe_OLD\n')
      for (const h of HIDDEN) write(root, h, 'local probe_old = 1\n')

      await page.keyboard.press(`${mod}+Shift+F`)
      await page.waitForTimeout(1000)
      // Right after launch the session restore may still put the old layout back: press again if it did.
      for (let i = 0; i < 4 && !(await find(page).isVisible()); i++) {
        await page.keyboard.press(`${mod}+Shift+F`)
        await page.waitForTimeout(700)
      }
      await find(page).waitFor({ state: 'visible', timeout: 10_000 })
      await find(page).fill('probe_old')
      await settled(page, 3)
      const paths = await page.locator(`${SIDE} .srch-group`).evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-path')))
      check(JSON.stringify(paths.slice().sort()) === JSON.stringify([A, B, C].sort()), `result files: ${paths}`)
      check((await page.locator(`${SIDE} .srch-sum`).innerText()).startsWith('4 results in 3 files'), `summary: ${await page.locator(`${SIDE} .srch-sum`).innerText()}`)
      await shot('results')

      // Match Case drops the capitalised one; a bad regex shows under the box.
      await page.locator(`${SIDE} button[aria-label^="Match Case"]`).click()
      await settled(page, 2)
      await page.locator(`${SIDE} button[aria-label^="Match Case"]`).click()
      await settled(page, 3)
      await page.locator(`${SIDE} button[aria-label^="Use Regular Expression"]`).click()
      await find(page).fill('probe_(')
      await page.locator(`${SIDE} [role="alert"]`, { hasText: /Invalid regular expression/ }).waitFor({ state: 'visible', timeout: 10_000 })
      await find(page).fill('probe_old')
      await page.locator(`${SIDE} button[aria-label^="Use Regular Expression"]`).click()
      await settled(page, 3)

      // A click opens the file at the match, selected.
      await page.locator(`${SIDE} .srch-group[data-path="${A}"] .srch-match`).nth(1).click()
      await page.locator(`${CENTER} .monaco-editor`).first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(() => /Ln 2,\s*Col 16\s*\(9 sel\)/.test(document.body.textContent ?? ''), undefined, { timeout: 10_000 })

      // Replace All: the confirm lists the files; the disk, the copies and the open tab follow.
      await page.locator(`${SIDE} button[aria-label="Toggle Replace"]`).click()
      await page.locator(`${SIDE} input[aria-label="Replace"]`).fill('probe_new')
      await page.locator(`${SIDE} button[aria-label="Replace All"]`).click()
      const dialog = page.getByRole('dialog', { name: /^Replace 4 matches in 3 files\?/ })
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      const body = await dialog.innerText()
      check([A, B, C].every((p) => body.includes(p)), `the confirm does not list the files: ${body}`)
      await shot('confirm')
      await dialog.getByRole('button', { name: 'Replace 4 matches', exact: true }).click()
      await page.locator('.toast', { hasText: /^Replaced 4 matches in 3 files/ }).first().waitFor({ state: 'visible', timeout: 10_000 })
      await disk(page, root, A, (s) => s === 'local probe_new = 1\nprint(probe_new)\n', 'Replace All did not write the file')
      check(readFileSync(join(root, B), 'utf8') === '-- probe_new in a comment\n', 'B not replaced')
      check(readFileSync(join(root, C), 'utf8') === 'return {} -- probe_new\n', 'C not replaced')
      check(HIDDEN.every((h) => readFileSync(join(root, h), 'utf8') === 'local probe_old = 1\n'), 'a file in node_modules / Packages was changed')
      const trash = join(root, '.forge/sync/trash')
      const stamps = readdirSync(trash).filter((n) => !n.startsWith('.'))
      check(stamps.some((s) => existsSync(join(trash, s, A)) && readFileSync(join(trash, s, A), 'utf8') === 'local probe_old = 1\nprint(probe_old)\n'), `no copy of ${A} under .forge/sync/trash (${stamps})`)
      // The open (clean) tab reloads the new text.
      await page.waitForFunction(() => document.querySelector('.editor-area .view-lines')?.textContent?.includes('probe_new'), undefined, { timeout: 10_000 })
      await settled(page, 0)

      // Unsaved edits are never overwritten: autosave off, type into A, replace back.
      await page.evaluate(() => window.harness.editorAssistSetSettings({ autoSave: 'off' }))
      await page.locator(`${CENTER} .monaco-editor .view-lines`).first().click()
      await page.keyboard.press(`${mod}+End`)
      await page.keyboard.type('-- unsaved')
      await find(page).fill('probe_new')
      await settled(page, 3)
      await page.locator(`${SIDE} .srch-file .tag`, { hasText: 'unsaved' }).waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(`${SIDE} input[aria-label="Replace"]`).fill('probe_old')
      await page.locator(`${SIDE} button[aria-label="Replace All"]`).click()
      const again = page.getByRole('dialog', { name: /^Replace 2 matches in 2 files\?/ })
      await again.waitFor({ state: 'visible', timeout: 5000 })
      check((await again.innerText()).includes('left alone'), 'the confirm does not say the unsaved file is left alone')
      await again.getByRole('button', { name: 'Replace 2 matches', exact: true }).click()
      await page.locator('.toast', { hasText: /^Replaced 2 matches in 2 files/ }).first().waitFor({ state: 'visible', timeout: 10_000 })
      check(readFileSync(join(root, A), 'utf8') === 'local probe_new = 1\nprint(probe_new)\n', 'the file with unsaved edits was written')
      check(readFileSync(join(root, B), 'utf8') === '-- probe_old in a comment\n', 'B not replaced back')
      await page.keyboard.press(`${mod}+S`).catch(() => undefined)
      await page.evaluate(() => window.harness.editorAssistSetSettings({ autoSave: 'onFocusChange' }))
      note('4 matches in 3 files replaced with copies; node_modules / Packages untouched; the unsaved file was left alone')

      for (const rel of [A, B, C, ...HIDDEN]) rmSync(join(root, rel), { force: true })
      rmSync(join(root, 'node_modules'), { recursive: true, force: true })
      rmSync(join(root, 'Packages/probe'), { recursive: true, force: true })
      await find(page).fill('')
    }
  }
]
