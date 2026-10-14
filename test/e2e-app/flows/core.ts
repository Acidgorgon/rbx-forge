// Workbench basics: launch, project, explorer + editor, palette, terminal, scripts, source control.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, INVENTORY_SERVICE } from '../lib/project.ts'
import { bodyText, check, CENTER, mod, showSide, SkipFlow, waitText } from '../lib/ui.ts'
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
