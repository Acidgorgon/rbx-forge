// Workbench basics: launch, project, explorer + editor, palette, terminal, scripts, source control.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { git, INVENTORY_SERVICE } from '../lib/project.ts'
import { write } from '../../fixture.ts'
import { bodyText, check, CENTER, dismissToasts, mod, openPage, showSide, SkipFlow, waitText } from '../lib/ui.ts'
import type { Flow } from './types.ts'

const MARK = '-- forge-e2e edit'

export const coreFlows: Flow[] = [
  {
    name: 'launch',
    title: 'App launches with no console errors / uncaught exceptions',
    async run({ page, launched, note }) {
      await page.locator('nav.activity').waitFor({ state: 'visible', timeout: 30_000 })
      // Let startup work (services, git status, lsp, updater) settle; errors are collected by the runner.
      await page.waitForTimeout(4000)
      const title = await page.title()
      check(/RBX Forge/.test(title), `window title is "${title}"`)
      const early = launched.errors.filter((e) => !e.flow)
      // Errors before the first flow started (during launch) belong to this flow.
      check(early.length === 0, `errors during launch: ${early.map((e) => e.text.split('\n')[0]).join(' | ')}`)
      note(`title "${title}"`)
    }
  },
  {
    name: 'open-project',
    title: 'Last project reopens: explorer, Forge page, git status',
    async run({ page, root }) {
      await waitText(page, 'GenTree', { within: '.titlebar, header' }).catch(() => undefined)
      const project = await page.evaluate(() => window.harness.getProject())
      check(project?.root === root, `open project is ${project?.root}, expected ${root}`)
      await showSide(page, 'Explorer')
      await waitText(page, 'ReplicatedStorage', { within: 'aside.side' })
      await waitText(page, 'ServerScriptService', { within: 'aside.side' })
      const status = await page.evaluate(() => window.harness.getGitStatus())
      check(status.isRepo && status.branch === 'main', `git status ${JSON.stringify(status)}`)
      check(!(await bodyText(page)).includes('no git'), 'titlebar still says "no git"')
    }
  },
  {
    name: 'editor',
    title: 'Explorer opens a script; edit, save, undo, save',
    async run({ page, root }) {
      await showSide(page, 'Explorer')
      const filter = page.locator('aside.side input').first()
      await filter.fill('InventoryService')
      const row = page.locator('aside.side [role="treeitem"]', { hasText: 'InventoryService' }).first()
      await row.waitFor({ state: 'visible', timeout: 5000 })
      await row.dblclick()
      const editor = page.locator(`${CENTER} .monaco-editor`).first()
      await editor.waitFor({ state: 'visible', timeout: 15_000 })
      await page.locator('.tab', { hasText: 'InventoryService' }).first().waitFor({ timeout: 5000 })
      await filter.fill('')
      // Type at the end of the file.
      await editor.locator('.view-lines').click()
      await page.keyboard.press(`${mod}+End`)
      await page.keyboard.press('Enter')
      await page.keyboard.type(MARK)
      await page.keyboard.press(`${mod}+S`)
      const file = join(root, INVENTORY_SERVICE)
      await page.waitForFunction(() => true)
      let saved = ''
      for (let i = 0; i < 40 && !saved.includes(MARK); i++) {
        await page.waitForTimeout(100)
        saved = readFileSync(file, 'utf8')
      }
      check(saved.includes(MARK), 'Ctrl+S did not write the edit to disk')
      // Undo the typing, save again: the file goes back to the original text.
      await editor.locator('.view-lines').click()
      for (let i = 0; i < 4; i++) await page.keyboard.press(`${mod}+Z`)
      await page.keyboard.press(`${mod}+S`)
      for (let i = 0; i < 40 && saved.includes(MARK); i++) {
        await page.waitForTimeout(100)
        saved = readFileSync(file, 'utf8')
      }
      check(!saved.includes(MARK), 'undo + save did not restore the file')
      // Leave one real change for the Source control flow.
      await editor.locator('.view-lines').click()
      await page.keyboard.press(`${mod}+End`)
      await page.keyboard.type(`\n${MARK} (kept)`)
      await page.keyboard.press(`${mod}+S`)
      for (let i = 0; i < 40 && !saved.includes('(kept)'); i++) {
        await page.waitForTimeout(100)
        saved = readFileSync(file, 'utf8')
      }
      check(saved.includes('(kept)'), 'second save did not reach disk')
    }
  },
  {
    name: 'palette',
    title: 'Command palette: commands and file search',
    async run({ page }) {
      await page.keyboard.press(`${mod}+K`)
      const input = page.locator('.palette input').first()
      await input.waitFor({ state: 'visible', timeout: 5000 })
      const cmdMode = await page
        .waitForFunction(() => (document.querySelector('.palette input') as HTMLInputElement | null)?.value.startsWith('>'), undefined, { timeout: 3000 })
        .then(() => true, () => false)
      check(cmdMode, `Ctrl+K should open command mode (">"), input shows "${await input.inputValue()}"`)
      await input.fill('>settings')
      await page.locator('.palette [role="option"], .palette .pal-item, .palette li').first().waitFor({ timeout: 5000 })
      await page.keyboard.press('Escape')
      await page.keyboard.press(`${mod}+P`)
      await input.waitFor({ state: 'visible', timeout: 5000 })
      await input.fill('PlayerData')
      await waitText(page, 'PlayerData', { within: '.palette' })
      await page.keyboard.press('Enter')
      await page.locator('.tab', { hasText: 'PlayerData' }).first().waitFor({ timeout: 5000 })
    }
  },
  {
    name: 'terminal',
    title: 'Terminal opens and runs echo',
    timeoutMs: 45_000,
    async run({ page }) {
      if (await page.locator('.app.bottom-off').count()) await page.keyboard.press(`${mod}+J`)
      await page.locator('.bp-tab', { hasText: 'Terminal' }).click()
      const view = page.locator('.term-view .xterm').first()
      if (!(await view.isVisible().catch(() => false))) {
        await page.getByLabel('New terminal').click()
      }
      const unavailable = page.getByText(/terminal is unavailable/i).first()
      await Promise.race([view.waitFor({ state: 'visible', timeout: 15_000 }), unavailable.waitFor({ state: 'visible', timeout: 15_000 })])
      if (await unavailable.isVisible()) {
        const text = (await unavailable.innerText()).split(':').slice(0, 2).join(':')
        throw new SkipFlow(`node-pty is not built for this Electron here; the panel shows a clear message ("${text}")`)
      }
      await page.waitForTimeout(800)
      await view.click()
      await page.keyboard.type('echo forge-e2e-$((40+2))')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('.term-view .xterm-rows')?.textContent?.includes('forge-e2e-42'), undefined, { timeout: 10_000 })
    }
  },
  {
    name: 'scripts',
    title: 'Scripts panel lists the project scripts',
    async run({ page }) {
      await showSide(page, 'Scripts')
      await waitText(page, /InventoryService/, { within: 'aside.side' })
      await waitText(page, /PlayerData/, { within: 'aside.side' })
    }
  },
  {
    name: 'explorer-rename-delete',
    title: 'Explorer context menu renames a script (tab follows) and moves it to the trash (tab closes)',
    timeoutMs: 45_000,
    async run({ page, root }) {
      await showSide(page, 'Explorer')
      const side = page.locator('aside.side')
      const filter = side.locator('input').first()
      const menuItem = (name: RegExp) => page.locator('.menu [role="menuitem"]', { hasText: name }).first()
      const waitDisk = async (path: string, want: boolean) => {
        for (let i = 0; i < 50 && existsSync(join(root, path)) !== want; i++) await page.waitForTimeout(100)
        check(existsSync(join(root, path)) === want, `${path} should ${want ? 'exist' : 'be gone'}`)
      }
      // Mount points ($path in default.project.json) offer neither rename nor delete.
      await filter.fill('')
      await side.locator('[role="treeitem"]', { hasText: /^\s*Server\s*$/ }).first().click({ button: 'right' })
      await page.locator('.menu').first().waitFor({ state: 'visible', timeout: 5000 })
      check((await menuItem(/^Delete/).count()) === 0, 'the src/server mount offers Delete')
      await page.keyboard.press('Escape')

      write(root, 'src/server/E2eScratch.server.luau', 'print("scratch")\n')
      await filter.fill('E2eScratch')
      const row = side.locator('[role="treeitem"]', { hasText: 'E2eScratch' }).first()
      await row.waitFor({ state: 'visible', timeout: 15_000 })
      await row.dblclick()
      await page.locator('.tab', { hasText: 'E2eScratch' }).first().waitFor({ timeout: 5000 })

      await row.click({ button: 'right' })
      await menuItem(/^Rename…/).click()
      const dialog = page.locator('.dialog[role="dialog"]')
      await dialog.getByLabel('New name').fill('E2eRenamed')
      await dialog.getByRole('button', { name: /Rename/ }).click()
      await waitDisk('src/server/E2eRenamed.server.luau', true)
      await waitDisk('src/server/E2eScratch.server.luau', false)
      await page.locator('.tab', { hasText: 'E2eRenamed' }).first().waitFor({ timeout: 5000 })
      check((await page.locator('.tab', { hasText: 'E2eScratch' }).count()) === 0, 'the old tab is still open after the rename')

      await filter.fill('E2eRenamed')
      const renamed = side.locator('[role="treeitem"]', { hasText: 'E2eRenamed' }).first()
      await renamed.waitFor({ state: 'visible', timeout: 10_000 })
      await renamed.click({ button: 'right' })
      await menuItem(/^Delete/).click()
      await dialog.getByRole('button', { name: /Move to/ }).click()
      await waitDisk('src/server/E2eRenamed.server.luau', false)
      await page.waitForFunction(() => ![...document.querySelectorAll('.tab')].some((t) => t.textContent?.includes('E2eRenamed')), undefined, { timeout: 5000 })
      await page.waitForFunction(() => ![...document.querySelectorAll('aside.side [role="treeitem"]')].some((t) => t.textContent?.includes('E2eRenamed')), undefined, { timeout: 10_000 })

      // "Don't ask again": the next delete (Del key) goes straight to the trash; Settings turns it back on.
      write(root, 'src/server/E2eSkipA.server.luau', 'print("a")\n')
      write(root, 'src/server/E2eSkipB.server.luau', 'print("b")\n')
      await filter.fill('E2eSkipA')
      const a = side.locator('[role="treeitem"]', { hasText: 'E2eSkipA' }).first()
      await a.waitFor({ state: 'visible', timeout: 15_000 })
      await a.click({ button: 'right' })
      await menuItem(/^Delete/).click()
      await dialog.getByLabel(/Don't ask again/).check()
      await dialog.getByRole('button', { name: /Move to/ }).click()
      await waitDisk('src/server/E2eSkipA.server.luau', false)
      await filter.fill('E2eSkipB')
      const b = side.locator('[role="treeitem"]', { hasText: 'E2eSkipB' }).first()
      await b.waitFor({ state: 'visible', timeout: 15_000 })
      await b.click()
      await page.keyboard.press('Delete')
      await waitDisk('src/server/E2eSkipB.server.luau', false)
      check((await dialog.count()) === 0, 'a delete asked again after "Don\'t ask again"')
      await filter.fill('')
      await openPage(page, 'Settings')
      const sw = page.locator('#set-editor').getByLabel('Confirm file deletes')
      await sw.waitFor({ state: 'visible', timeout: 10_000 })
      check(!(await sw.isChecked()), 'Settings > Editor: "Confirm file deletes" still on after "Don\'t ask again"')
      await sw.check()
      for (let i = 0; i < 30 && !(await page.evaluate(() => (window as unknown as { harness: { getAppSettings(): Promise<{ confirmFileDelete: boolean }> } }).harness.getAppSettings().then((x) => x.confirmFileDelete))); i++) await page.waitForTimeout(100)
      check(await sw.isChecked(), 'Settings > Editor: "Confirm file deletes" did not turn back on')
      await showSide(page, 'Explorer')
    }
  },
  {
    name: 'explorer-multi-select',
    title: 'Explorer multi-select: Shift-click range, Esc keeps the cursor, filtered Ctrl+A skips ancestors, a row toggled off is not deleted, menu, Copy paths, Enter, Delete',
    timeoutMs: 60_000,
    async run({ app, page, root, shot }) {
      await showSide(page, 'Explorer')
      const side = page.locator('aside.side')
      const tree = side.locator('[role="tree"]')
      const filter = side.locator('input').first()
      const dialog = page.locator('.dialog[role="dialog"]')
      const chip = side.locator('.sel-chip')
      const menuItem = (name: RegExp) => page.locator('.menu [role="menuitem"]', { hasText: name }).first()
      const row = (name: string) => side.locator('[role="treeitem"]', { hasText: name }).first()
      const selectedNames = () => side.locator('[role="treeitem"][aria-selected="true"] .tname').allInnerTexts().then((t: string[]) => t.map((x) => x.trim()).sort())
      const same = async (want: string[], what: string) => {
        const got = await selectedNames()
        check(JSON.stringify(got) === JSON.stringify(want), `${what}: selected ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
      }
      const outlined = async (name: string) => (await row(name).getAttribute('class'))?.split(' ').includes('focus') ?? false
      const waitDisk = async (path: string, want: boolean) => {
        for (let i = 0; i < 50 && existsSync(join(root, path)) !== want; i++) await page.waitForTimeout(100)
        check(existsSync(join(root, path)) === want, `${path} should ${want ? 'exist' : 'be gone'}`)
      }
      const files = ['A', 'B', 'C'].map((x) => `src/server/E2eMulti${x}.server.luau`)
      for (const f of files) write(root, f, `print("${f}")\n`)
      try {
        await filter.fill('E2eMulti')
        for (const n of ['E2eMultiA', 'E2eMultiB', 'E2eMultiC']) await row(n).waitFor({ state: 'visible', timeout: 15_000 })

        // Shift-click selects the range; the header counts it.
        await row('E2eMultiA').click()
        await row('E2eMultiC').click({ modifiers: ['Shift'] })
        await same(['E2eMultiA', 'E2eMultiB', 'E2eMultiC'], 'Shift-click')
        await chip.filter({ hasText: '3 selected' }).waitFor({ timeout: 3000 })
        // Esc clears the selection but keeps the cursor (outlined, the tree's active descendant): Down
        // goes on from it, not back to the first row.
        await row('E2eMultiB').click()
        await page.keyboard.press('Escape')
        await same([], 'Esc')
        check(await outlined('E2eMultiB'), 'after Esc the cursor row has no focus outline')
        const bId = await row('E2eMultiB').getAttribute('id')
        check(!!bId && (await tree.getAttribute('aria-activedescendant')) === bId, `aria-activedescendant is ${await tree.getAttribute('aria-activedescendant')}, expected ${bId}`)
        await page.keyboard.press('ArrowDown')
        await same(['E2eMultiC'], 'Esc then ArrowDown')
        // Shift+Arrow grows and shrinks the range from the anchor.
        await row('E2eMultiA').click()
        await page.keyboard.press('Shift+ArrowDown')
        await page.keyboard.press('Shift+ArrowDown')
        await same(['E2eMultiA', 'E2eMultiB', 'E2eMultiC'], 'Shift+ArrowDown twice')
        await page.keyboard.press('Shift+ArrowUp')
        await same(['E2eMultiA', 'E2eMultiB'], 'then Shift+ArrowUp')
        // A Shift-click up to ServerScriptService leaves out the rows the filter shows only as context.
        await row('E2eMultiC').click()
        await side.locator('[role="treeitem"][data-key="ServerScriptService"]').click({ modifiers: ['Shift'] })
        await same(['E2eMultiA', 'E2eMultiB', 'E2eMultiC'], 'Shift-click onto a context row')

        // Ctrl/Cmd+A with a filter: only the matching rows, not ServerScriptService / Server, which the
        // filter shows only as the way to them.
        await page.keyboard.press(`${mod}+a`)
        await chip.filter({ hasText: '3 selected' }).waitFor({ timeout: 3000 })
        await same(['E2eMultiA', 'E2eMultiB', 'E2eMultiC'], 'filtered Ctrl+A')
        check((await side.locator('[role="treeitem"]').count()) > 3, 'the filter shows no context rows to leave out')
        await page.keyboard.press('Escape')
        await chip.waitFor({ state: 'detached', timeout: 3000 })

        // Ctrl/Cmd-click the only selected row off: nothing is selected, the cursor stays outlined on it,
        // and F2 / Delete / Enter do nothing.
        await row('E2eMultiA').click()
        await row('E2eMultiA').click({ modifiers: [mod] })
        await same([], 'Ctrl-click off')
        check(await outlined('E2eMultiA'), 'the row toggled off has no focus outline')
        for (const key of ['F2', 'Delete', 'Enter']) await page.keyboard.press(key)
        await page.waitForTimeout(500)
        check((await dialog.count()) === 0, 'a key acted on the row that was toggled off')
        check(existsSync(join(root, files[0])), 'Delete removed the row that was toggled off')

        // Ctrl/Cmd-click two scripts: the menu acts on both, Rename is single-only.
        await row('E2eMultiA').click()
        await row('E2eMultiB').click({ modifiers: [mod] })
        await same(['E2eMultiA', 'E2eMultiB'], 'Ctrl-click')
        await chip.filter({ hasText: '2 selected' }).waitFor({ timeout: 3000 })
        // A right-click outside the selection opens that row's own menu and keeps the selection.
        await row('E2eMultiC').click({ button: 'right' })
        await menuItem(/^Rename…/).waitFor({ state: 'visible', timeout: 5000 })
        check(!(await menuItem(/^Rename…/).isDisabled()), 'the menu of the row outside the selection is not its own')
        await page.keyboard.press('Escape')
        await same(['E2eMultiA', 'E2eMultiB'], 'a right-click outside the selection')
        await row('E2eMultiB').click({ button: 'right' })
        await menuItem(/^Delete 2 items/).waitFor({ state: 'visible', timeout: 5000 })
        await shot('menu')
        check(await menuItem(/^Open 2 scripts/).isVisible(), 'the multi-select menu has no "Open 2 scripts"')
        check(await menuItem(/^Rename/).isDisabled(), 'Rename is enabled for two items')
        // Copy paths > Roblox paths: one per line.
        await menuItem(/^Copy paths/).hover()
        await menuItem(/^Roblox paths \(2\)/).click()
        let clip = ''
        for (let i = 0; i < 30 && !clip.includes('E2eMultiB'); i++) {
          clip = await app.evaluate(({ clipboard }: { clipboard: { readText(): string } }) => clipboard.readText())
          if (!clip.includes('E2eMultiB')) await page.waitForTimeout(100)
        }
        check(clip === 'game.ServerScriptService.Server.E2eMultiA\ngame.ServerScriptService.Server.E2eMultiB', `Copy paths wrote ${JSON.stringify(clip)}`)
        await same(['E2eMultiA', 'E2eMultiB'], 'after the menu')

        // Enter opens both.
        await tree.focus()
        await page.keyboard.press('Enter')
        for (const n of ['E2eMultiA', 'E2eMultiB']) await page.locator('.tab', { hasText: n }).first().waitFor({ timeout: 5000 })

        // Toggle B off and on again, then Delete: one confirm listing both, both moved to the trash.
        await row('E2eMultiB').click({ modifiers: [mod] })
        await same(['E2eMultiA'], 'Ctrl-click B off')
        await chip.waitFor({ state: 'detached', timeout: 3000 })
        await row('E2eMultiB').click({ modifiers: [mod] })
        await chip.filter({ hasText: '2 selected' }).waitFor({ timeout: 3000 })
        await page.keyboard.press('Delete')
        await dialog.waitFor({ state: 'visible', timeout: 5000 })
        await shot('confirm')
        const text = await dialog.innerText()
        check(/Delete 2 items\?/.test(text) && text.includes(files[0]) && text.includes(files[1]), `the confirm does not list both scripts: ${text.slice(0, 300)}`)
        check(!text.includes('E2eMultiC'), 'the confirm lists an unselected script')
        await dialog.getByRole('button', { name: /Move to/ }).click()
        // The result toast (3.5 s) right away: it says the batch call itself came back.
        await waitText(page, /Deleted 2 items/, { timeout: 20_000 })
        await waitDisk(files[0], false)
        await waitDisk(files[1], false)
        await waitDisk(files[2], true)
        await page.waitForFunction(() => ![...document.querySelectorAll('aside.side [role="treeitem"]')].some((t) => /E2eMulti[AB]/.test(t.textContent ?? '')), undefined, { timeout: 10_000 })
        await page.waitForFunction(() => ![...document.querySelectorAll('.tab')].some((t) => /E2eMulti[AB]/.test(t.textContent ?? '')), undefined, { timeout: 5000 })
        await chip.waitFor({ state: 'detached', timeout: 3000 })
      } finally {
        if (await dialog.count()) await page.keyboard.press('Escape').catch(() => undefined)
        for (const f of files) rmSync(join(root, f), { force: true })
        await filter.fill('').catch(() => undefined)
        await dismissToasts(page)
      }
    }
  },
  {
    name: 'explorer-multi-select-guard',
    title: 'Explorer batch delete: filtered Ctrl+A lists only matches, Wally rows are left out, a folder with unselected files always asks, Files view folder + file',
    timeoutMs: 75_000,
    async run({ page, root, shot }) {
      await showSide(page, 'Explorer')
      const side = page.locator('aside.side')
      const tree = side.locator('[role="tree"]')
      const filter = side.locator('input').first()
      const dialog = page.locator('.dialog[role="dialog"]')
      const row = (name: string) => side.locator('[role="treeitem"]', { hasText: name }).first()
      const fileRow = (path: string) => side.locator(`[role="treeitem"][data-key="f:${path}"]`)
      const selectedNames = () => side.locator('[role="treeitem"][aria-selected="true"] .tname').allInnerTexts().then((t: string[]) => t.map((x) => x.trim()).sort())
      const same = async (want: string[], what: string) => {
        const got = await selectedNames()
        check(JSON.stringify(got) === JSON.stringify(want), `${what}: selected ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
      }
      const waitDisk = async (path: string, want: boolean) => {
        for (let i = 0; i < 50 && existsSync(join(root, path)) !== want; i++) await page.waitForTimeout(100)
        check(existsSync(join(root, path)) === want, `${path} should ${want ? 'exist' : 'be gone'}`)
      }
      const confirmText = async () => {
        await dialog.waitFor({ state: 'visible', timeout: 5000 })
        return (await dialog.innerText()).replace(/\s+/g, ' ')
      }
      const cancel = async () => {
        await dialog.getByRole('button', { name: 'Cancel' }).click()
        await dialog.waitFor({ state: 'detached', timeout: 3000 })
      }
      const confirmDeletes = async (on: boolean) => {
        await openPage(page, 'Settings')
        const sw = page.locator('#set-editor').getByLabel('Confirm file deletes')
        await sw.waitFor({ state: 'visible', timeout: 10_000 })
        if ((await sw.isChecked()) !== on) await sw.setChecked(on)
        for (let i = 0; i < 30 && (await page.evaluate(() => (window as unknown as { harness: { getAppSettings(): Promise<{ confirmFileDelete: boolean }> } }).harness.getAppSettings().then((x) => x.confirmFileDelete !== false))) !== on; i++) await page.waitForTimeout(100)
        await showSide(page, 'Explorer')
      }
      const DIR = 'src/server/E2eGuard'
      const hitA = `${DIR}/GuardHitA.server.luau`
      const hitB = `${DIR}/GuardHitB.server.luau`
      const keep = `${DIR}/Keep.server.luau`
      const note = 'src/server/E2ePackagesNote.server.luau'
      for (const f of [hitA, hitB, keep, note]) write(root, f, `print("${f}")\n`)
      let confirmOff = false
      try {
        // Filtered Ctrl/Cmd+A: the two matches only. The E2eGuard folder is on screen only as the way to
        // them; selecting it would trash Keep, which the filter hides.
        await filter.fill('GuardHit')
        for (const n of ['GuardHitA', 'GuardHitB', 'E2eGuard']) await row(n).waitFor({ state: 'visible', timeout: 15_000 })
        await row('GuardHitA').click()
        await page.keyboard.press(`${mod}+a`)
        await same(['GuardHitA', 'GuardHitB'], 'filtered Ctrl+A')
        await page.keyboard.press('Delete')
        let text = await confirmText()
        check(/Delete 2 items\?/.test(text) && text.includes(hitA) && text.includes(hitB), `the confirm does not list the two matches: ${text.slice(0, 300)}`)
        check(!text.includes(`${DIR}/ `) && !text.includes('Keep'), `the confirm takes in the folder: ${text.slice(0, 300)}`)
        await cancel()

        // A Wally package row in the selection is left out, with why.
        await filter.fill('Packages')
        await row('E2ePackagesNote').waitFor({ state: 'visible', timeout: 15_000 })
        await row('E2ePackagesNote').click()
        await side.locator('[role="treeitem"][data-key="ReplicatedStorage/Packages"]').click({ modifiers: [mod] })
        await same(['E2ePackagesNote', 'Packages'], 'a script and the Packages folder')
        await page.keyboard.press('Delete')
        text = await confirmText()
        check(/Delete 1 item\?/.test(text) && text.includes(note), `the confirm does not list the script: ${text.slice(0, 300)}`)
        check(text.includes('Leaves out 1 item that cannot be deleted here: Packages (Wally package, read-only).'), `no note for the Wally row: ${text.slice(0, 400)}`)
        await cancel()

        // "Don't ask again" (Settings > Editor off): a folder with files the selection did not pick still
        // asks, says so, and offers no "Don't ask again".
        await confirmDeletes(false)
        confirmOff = true
        await filter.fill('GuardHit')
        await row('E2eGuard').waitFor({ state: 'visible', timeout: 10_000 })
        await row('E2eGuard').click()
        await row('GuardHitA').click({ modifiers: [mod] })
        await same(['E2eGuard', 'GuardHitA'], 'the folder and a file in it')
        await page.keyboard.press('Delete')
        text = await confirmText()
        await shot('forced-confirm')
        check(/Delete 1 item\?/.test(text) && text.includes(`${DIR}/`), `the forced confirm does not list the folder: ${text.slice(0, 300)}`)
        check(text.includes('1 selected item inside it goes along.'), `no "goes along" note: ${text.slice(0, 400)}`)
        check(text.includes(`${DIR}/ also holds 2 files you did not select. They go too.`), `no note for the unselected files: ${text.slice(0, 400)}`)
        check((await dialog.getByLabel(/Don't ask again/).count()) === 0, 'the forced confirm offers "Don\'t ask again"')
        await cancel()
        check(existsSync(join(root, keep)), 'Cancel deleted the folder')
        // Plain files with "Don't ask again": straight to the trash, no prompt.
        await row('GuardHitA').click()
        await page.keyboard.press(`${mod}+a`)
        await same(['GuardHitA', 'GuardHitB'], 'Ctrl+A again')
        await page.keyboard.press('Delete')
        await waitText(page, /Deleted 2 items/, { timeout: 20_000 })
        check((await dialog.count()) === 0, 'a batch of plain files asked after "Don\'t ask again"')
        await waitDisk(hitA, false)
        await waitDisk(hitB, false)
        await confirmDeletes(true)
        confirmOff = false
        await dismissToasts(page)

        // Files view: a folder and a file inside it. The folder is listed once, the file goes along, and
        // Keep (not selected) is named.
        const inner = `${DIR}/Inner.server.luau`
        write(root, inner, 'print("inner")\n')
        await filter.fill('')
        await side.getByRole('button', { name: 'Files', exact: true }).click()
        for (const dir of ['src', 'src/server', DIR]) {
          const r = fileRow(dir)
          await r.waitFor({ state: 'visible', timeout: 15_000 })
          if ((await r.getAttribute('aria-expanded')) === 'false') await r.locator('.chev').click()
        }
        await fileRow(inner).waitFor({ state: 'visible', timeout: 15_000 })
        await fileRow(DIR).click({ modifiers: [mod] })
        await fileRow(inner).click({ modifiers: [mod] })
        await same(['E2eGuard', 'Inner.server.luau'], 'Files view folder + file')
        await tree.focus()
        await page.keyboard.press('Delete')
        text = await confirmText()
        check(/Delete 1 item\?/.test(text) && text.includes(`${DIR}/`) && !text.includes(`${inner} `), `the Files view confirm: ${text.slice(0, 300)}`)
        check(text.includes('Moves this folder and everything in it') && text.includes('1 selected item inside it goes along.') && text.includes(`${DIR}/ also holds 1 file you did not select. It goes too.`), `the Files view confirm body: ${text.slice(0, 400)}`)
        await dialog.getByRole('button', { name: /Move to/ }).click()
        await waitText(page, /Deleted 1 item/, { timeout: 20_000 })
        await waitDisk(DIR, false)
      } finally {
        if (await dialog.count()) await page.keyboard.press('Escape').catch(() => undefined)
        rmSync(join(root, DIR), { recursive: true, force: true })
        rmSync(join(root, note), { force: true })
        if (confirmOff) await confirmDeletes(true).catch(() => undefined)
        await side.getByRole('button', { name: 'Game', exact: true }).click().catch(() => undefined)
        await filter.fill('').catch(() => undefined)
        await dismissToasts(page)
      }
    }
  },
  {
    name: 'explorer-new-story',
    title: 'Explorer New > UI > Story / Storybook writes UI Labs files; a story outside any storybook gets a hint',
    timeoutMs: 45_000,
    async run({ page, root }) {
      await showSide(page, 'Explorer')
      const side = page.locator('aside.side')
      const filter = side.locator('input').first()
      const menuItem = (name: RegExp) => page.locator('.menu [role="menuitem"]', { hasText: name }).first()
      const create = async (label: RegExp, name: string, path: string) => {
        await filter.fill('')
        await side.locator('[role="treeitem"]', { hasText: /^\s*Shared\s*$/ }).first().click({ button: 'right' })
        await menuItem(/^New/).hover()
        await menuItem(label).click()
        const input = side.locator('input.inline-input')
        await input.waitFor({ state: 'visible', timeout: 5000 })
        await input.fill(name)
        await input.press('Enter')
        for (let i = 0; i < 50 && !existsSync(join(root, path)); i++) await page.waitForTimeout(100)
        check(existsSync(join(root, path)), `${path} was not written`)
        return readFileSync(join(root, path), 'utf8')
      }
      const story = await create(/^Story/, 'E2eCard', 'src/shared/E2eCard.story.luau')
      check(story.includes('vide = Vide,') && story.includes('Text = "E2eCard"'), 'the story template is wrong')
      await waitText(page, 'no storybook covers this folder', { timeout: 20_000 })
      const book = await create(/^Storybook/, 'E2eBook', 'src/shared/E2eBook.storybook.luau')
      check(book.includes('script.Parent,'), 'the storybook does not root at its folder')
      rmSync(join(root, 'src/shared/E2eCard.story.luau'))
      rmSync(join(root, 'src/shared/E2eBook.storybook.luau'))
      await dismissToasts(page)
    }
  },
  {
    name: 'source-control',
    title: 'Source control: status shows the edit, Sync now commits + pushes',
    timeoutMs: 45_000,
    async run({ page, root, note }) {
      await showSide(page, 'Source control & Sync')
      await page.getByTitle('Refresh').first().click()
      await page.waitForFunction(() => /\d+ changed/.test(document.querySelector('aside.side')?.textContent ?? ''), undefined, { timeout: 10_000 })
      const before = (await page.locator('aside.side').innerText()).match(/(\d+) changed/)?.[1]
      check(before && Number(before) > 0, `expected local changes, panel says "${before} changed"`)
      await page.locator('aside.side').getByRole('button', { name: /Sync now/ }).click()
      let log = ''
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(250)
        log = git(root, 'log', '--oneline', '-3')
        if (log.split('\n')[0].includes('harness: sync')) break
      }
      check(log.split('\n')[0].includes('harness: sync'), `no sync commit: ${log}`)
      // Pushed: origin/main catches up with main.
      let ahead = ''
      for (let i = 0; i < 60; i++) {
        ahead = git(root, 'rev-list', '--count', 'origin/main..main').trim()
        if (ahead === '0') break
        await page.waitForTimeout(250)
      }
      const remoteHead = git(`${root}-origin.git`, 'log', '--oneline', '-1')
      if (ahead !== '0' || !remoteHead.includes('harness: sync')) {
        const logs = await page.evaluate(() => window.harness.getLogs('git'))
        note(`git log: ${logs.slice(-10).map((l: { text: string }) => l.text).join(' / ')}`)
      }
      check(remoteHead.includes('harness: sync'), `commit not pushed to origin (local ahead ${ahead}, origin ${remoteHead.trim()})`)
      await page.waitForFunction(() => /0 changed/.test(document.querySelector('aside.side')?.textContent ?? ''), undefined, { timeout: 10_000 })
      note(`commit: ${log.split('\n')[0]}`)
    }
  }
]
