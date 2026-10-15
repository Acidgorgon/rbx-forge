// Editor assist: StyLua format on save (one undo step), Format Document (Shift+Alt+F), autosave on
// focus change without formatting, the AI completions pill without a provider, Settings > Editor,
// and luau-lsp quick fixes (light bulb / Ctrl+.) when luau-lsp is on PATH.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../fixture.ts'
import { check, CENTER, mod, openPage, settingsSection, showSide, SkipFlow, waitForAsync, waitText } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const FILE = 'src/server/E2eAssist.server.luau'

// Stand-in StyLua: drops spaces inside parentheses (enough to see that format ran and on what).
const FAKE_STYLUA = `#!/bin/sh
sed -e 's/( */(/g' -e 's/ *)/)/g'
`

async function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.editor-area .monaco-editor .view-lines .view-line')] as HTMLElement[]
    return lines
      .map((l) => ({ top: parseFloat(l.style.top || '0'), text: (l.textContent ?? '').replace(/ /g, ' ') }))
      .sort((a, b) => a.top - b.top)
      .map((l) => l.text)
      .join('\n')
  })
}

async function waitDisk(page: Page, file: string, pred: (s: string) => boolean, what: string): Promise<string> {
  let text = ''
  for (let i = 0; i < 50; i++) {
    text = readFileSync(file, 'utf8')
    if (pred(text)) return text
    await page.waitForTimeout(100)
  }
  check(false, `${what}; disk has: ${JSON.stringify(text)}`)
  return text
}

export const editorAssistFlows: Flow[] = [
  {
    name: 'editor-assist',
    title: 'StyLua format on save (one undo), Format Document, autosave on focus change, AI pill, Settings > Editor',
    timeoutMs: 60_000,
    async run({ page, root, sandbox, note }) {
      if (process.platform === 'win32') throw new SkipFlow('the fake StyLua is a shell script')
      const bin = join(sandbox.home, '.rokit', 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, 'stylua'), FAKE_STYLUA)
      chmodSync(join(bin, 'stylua'), 0o755)
      // The window regaining focus re-reads the status (StyLua installed while Forge ran).
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await waitForAsync(page, async () => (await window.harness.editorAssistStatus()).stylua.found, undefined, { timeout: 5000 })
      const status = await page.evaluate(() => window.harness.editorAssistStatus())
      check(status.effective.formatOnSave, 'format on save should default to on when StyLua is found')
      check(status.settings.autoSave === 'onFocusChange', `autosave default is ${status.settings.autoSave}`)
      check(!status.settings.formatOnAutoSave, 'format on autosave should default to off')
      check(!status.completions.ready && !status.effective.aiCompletions, 'no provider yet: AI completions off')

      write(root, FILE, 'print(   "fmt"   )\n')
      await showSide(page, 'Explorer')
      const filter = page.locator('aside.side input').first()
      await filter.fill('E2eAssist')
      const row = page.locator('aside.side [role="treeitem"]', { hasText: 'E2eAssist' }).first()
      await row.waitFor({ state: 'visible', timeout: 15_000 })
      await row.dblclick()
      await page.locator('.tab', { hasText: 'E2eAssist' }).first().waitFor({ timeout: 5000 })
      await filter.fill('')
      const editor = page.locator(`${CENTER} .monaco-editor`).first()
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForFunction(() => document.querySelector('.editor-area .view-lines')?.textContent?.includes('fmt'), undefined, { timeout: 5000 })
      const file = join(root, FILE)

      // Ctrl+S formats (even with nothing changed, like VS Code) and writes the formatted text.
      await editor.locator('.view-lines').click()
      await page.keyboard.press(`${mod}+S`)
      await waitDisk(page, file, (s) => s === 'print("fmt")\n', 'Ctrl+S did not save the StyLua output')
      const shown = await page
        .waitForFunction(() => document.querySelector('.editor-area .view-lines')?.textContent?.replace(/\u00a0/g, ' ').startsWith('print("fmt")'), undefined, { timeout: 3000 })
        .then(() => true, () => false)
      check(shown, `the buffer does not show the formatted text: ${JSON.stringify(await editorText(page))}`)
      // One undo step brings the unformatted text back.
      await page.keyboard.press(`${mod}+Z`)
      await page.waitForFunction(() => document.querySelector('.editor-area .view-lines')?.textContent?.replace(/ /g, ' ').includes('print(   "fmt"   )'), undefined, { timeout: 3000 })
      // Format Document: Shift+Alt+F (Monaco's binding on Windows / macOS; Ctrl+Shift+I on Linux).
      await page.keyboard.press(process.platform === 'linux' ? 'Control+Shift+I' : 'Shift+Alt+F')
      await page.waitForFunction(() => document.querySelector('.editor-area .view-lines')?.textContent?.includes('print("fmt")'), undefined, { timeout: 5000 })
      // Right-click offers Format Document.
      await editor.locator('.view-lines').click({ button: 'right' })
      // Monaco draws its context menu in a shadow root; Playwright's CSS locators pierce it.
      const menuHasFormat = await page
        .locator('.monaco-menu .action-label', { hasText: 'Format Document' })
        .first()
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true, () => false)
      await page.keyboard.press('Escape')
      check(menuHasFormat, 'the editor context menu has no "Format Document"')

      // Autosave on focus change: leaving the editor saves, without formatting.
      await editor.locator('.view-lines').click()
      await page.keyboard.press(`${mod}+End`)
      await page.keyboard.press('Enter')
      await page.keyboard.type('print(  "auto"')
      await page.keyboard.press('Escape')
      await page.locator('aside.side').click({ position: { x: 20, y: 200 } })
      const auto = await waitDisk(page, file, (s) => s.includes('"auto"'), 'leaving the editor did not autosave')
      check(auto.includes('print(  "auto"'), `autosave formatted the file: ${JSON.stringify(auto)}`)

      // AI completions pill: off without a provider, says what to add.
      const pill = page.locator('footer.status .ai-pill')
      await pill.waitFor({ state: 'visible', timeout: 5000 })
      check(/AI off/.test(await pill.innerText()), `AI pill says "${await pill.innerText()}"`)
      check(/API key|sign-in/.test((await pill.getAttribute('title')) ?? ''), 'AI pill tooltip does not say what is missing')

      // luau-lsp quick fixes, when the server runs here.
      const lspReady = await page
        .waitForFunction(() => document.querySelector('footer.status [title^="luau-lsp"] .led.ok') !== null, undefined, { timeout: 8000 })
        .then(() => true, () => false)
      if (lspReady) {
        await editor.locator('.view-lines').click()
        await page.keyboard.press(`${mod}+End`)
        await page.keyboard.press('Enter')
        await page.keyboard.type('local unusedValue = 1')
        await page.keyboard.press('Escape')
        await page.keyboard.press('Home')
        const marker = await page
          .waitForFunction(() => document.querySelector('.editor-area .squiggly-warning, .editor-area .squiggly-info, .editor-area .squiggly-error') !== null, undefined, { timeout: 15_000 })
          .then(() => true, () => false)
        if (marker) {
          await page.keyboard.press(`${mod}+Period`)
          const menu = await page
            .waitForFunction(() => document.querySelector('.action-widget, .monaco-action-bar.action-widget') !== null, undefined, { timeout: 5000 })
            .then(() => true, () => false)
          const items: string[] = menu ? await page.evaluate(() => [...document.querySelectorAll('.action-widget .action-label, .action-widget .title')].map((e) => e.textContent?.trim() ?? '').filter(Boolean)) : []
          check(menu, 'Ctrl+. did not open the quick fix menu on a line with a luau-lsp warning')
          const bulb = await page.evaluate(() => document.querySelector('.editor-area .lightBulbWidget, .editor-area .codicon-light-bulb, .editor-area .codicon-lightbulb-autofix') !== null)
          note(`quick fix menu: ${items.slice(0, 4).join(' | ') || '(no items)'}; light bulb ${bulb ? 'shown' : 'not shown'}`)
          // Applying the first fix edits the buffer ("Prefix 'unusedValue' with '_'" on luau-lsp 1.69).
          if (items.some((i) => /Prefix .*_/.test(i))) {
            const before = await editorText(page)
            await page.keyboard.press('Enter')
            const applied = await page
              .waitForFunction((b: string) => {
                const t = document.querySelector('.editor-area .view-lines')?.textContent?.replace(/\u00a0/g, ' ') ?? ''
                return t !== b.replace(/\n/g, '') && t.includes('_unusedValue')
              }, before, { timeout: 5000 })
              .then(() => true, () => false)
            check(applied, 'choosing the quick fix did not change the buffer')
            await page.keyboard.press(`${mod}+Z`)
          } else await page.keyboard.press('Escape')
        } else note('luau-lsp ran but published no warning for an unused local; quick fix not checked')
        await page.keyboard.press(`${mod}+Z`)
      } else note('luau-lsp not running here; quick fixes not checked')

      // Settings > Editor.
      await openPage(page, 'Settings')
      await settingsSection(page, 'Editor')
      await waitText(page, 'Format on save', { within: '#set-editor' })
      check(await page.locator('#set-editor [role="radio"][aria-checked="true"]', { hasText: 'On focus change' }).count() === 1, 'Settings > Editor: autosave is not "On focus change"')

      // Clean up: close the tab (saved), remove the file.
      await page.locator('.tab', { hasText: 'E2eAssist' }).first().click()
      await page.keyboard.press(`${mod}+W`)
      rmSync(file, { force: true })
    }
  }
]
