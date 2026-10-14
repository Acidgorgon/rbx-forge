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
