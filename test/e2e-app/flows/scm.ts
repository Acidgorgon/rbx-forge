// Source control section (views/SourceControlSection.tsx) against the real app and the fixture's
// bare origin: an edit and a new file with a space in its name show under Changes, stage one, its
// diff tab, commit it with Ctrl+Enter and your own message, Sync now leaving a staged file alone,
// discard (in-app confirm, a copy in .forge/sync/trash), commit-all when nothing is staged, and Push.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, INVENTORY_SERVICE } from '../lib/project.ts'
import { check, CENTER, dismissToasts, mod, showSide } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const SCM = 'aside.side section.scm'
const NEW_FILE = 'src/shared/Shop Items.luau'

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

// Rows of one group ("staged", "changes", "conflicts") as "<letter> <path>" from their tooltips.
async function rows(page: Page, group: string): Promise<string[]> {
  return page.locator(`${SCM} [data-group="${group}"] .scm-row`).evaluateAll((els: Element[]) =>
    els.map((e) => `${e.querySelector('.scm-letter')?.textContent ?? '?'} ${(e.getAttribute('title') ?? '').split('\n')[0]}`)
  )
}

// Row buttons show on hover; a status refresh can move the row from under the mouse, so hover again.
async function rowAction(page: Page, path: string, label: string): Promise<void> {
  const row = page.locator(`${SCM} .scm-row`, { has: page.locator(`button[aria-label="${label} ${path}"]`) }).first()
  for (let i = 0; ; i++) {
    await row.hover()
    try {
      await row.locator(`button[aria-label="${label} ${path}"]`).click({ timeout: 2000 })
      return
    } catch (error) {
      if (i >= 4) throw error
    }
  }
}

async function confirm(page: Page, title: RegExp, button: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: title })
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  await dialog.getByRole('button', { name: button, exact: true }).click()
  await dialog.waitFor({ state: 'detached', timeout: 5000 })
}

export const scmFlows: Flow[] = [
  {
    name: 'source-control-commit',
    title: 'Source control: stage, diff, commit with a message (Ctrl+Enter), discard with a copy, commit all, push',
    timeoutMs: 90_000,
    async run({ page, root, note, shot }) {
      await dismissToasts(page)
      await showSide(page, 'Source control & Sync')
      await page.locator(SCM).waitFor({ state: 'visible', timeout: 10_000 })
      const original = readFileSync(join(root, INVENTORY_SERVICE), 'utf8')
      writeFileSync(join(root, INVENTORY_SERVICE), `${original}-- e2e: edited for Source control\n`)
      writeFileSync(join(root, NEW_FILE), 'return { sword = 100 }\n')
      await until('both changes listed', async () => {
        const changes = await rows(page, 'changes')
        return changes.includes(`M ${INVENTORY_SERVICE}`) && changes.includes(`U ${NEW_FILE}`)
      })

      // Stage the new file; its staged diff opens as a tab.
      await rowAction(page, NEW_FILE, 'Stage')
      await until('new file staged', async () => (await rows(page, 'staged')).includes(`A ${NEW_FILE}`))
      await page.locator(`${SCM} [data-group="staged"] .scm-row`).first().click()
      const diff = page.locator(`${CENTER} .gitdiff`)
      await diff.waitFor({ state: 'visible', timeout: 10_000 })
      check((await diff.locator('.conflict-labels').innerText()).includes('Staged'), 'the staged diff is not labelled HEAD -> Staged')
      await shot('staged')

      // Sync now leaves the staged selection alone (no "harness: sync" commit) and says why.
      const headBefore = git(root, 'rev-parse', 'HEAD').trim()
      await page.locator('aside.side').getByRole('button', { name: /Sync now/ }).click()
      await until('sync note shown', async () => /Auto-sync did not commit your changes/.test(await page.locator('aside.side').innerText()), 20_000)
      check(git(root, 'rev-parse', 'HEAD').trim() === headBefore, 'Sync now committed while a file was staged')
      check((await rows(page, 'staged')).includes(`A ${NEW_FILE}`), 'Sync now unstaged the staged file')

      // Commit it with Ctrl+Enter: only the staged file goes in, with the typed message.
      const box = page.locator(`${SCM} textarea[aria-label="Commit message"]`)
      await box.fill('Add shop items\n\nTyped in Forge.')
      await box.press(`${mod}+Enter`)
      await until('committed', () => git(root, 'log', '-1', '--format=%s').trim() === 'Add shop items', 15_000)
      check(git(root, 'log', '-1', '--format=%B').trim() === 'Add shop items\n\nTyped in Forge.', 'commit body differs from the typed message')
      check(git(root, 'show', '--name-only', '--format=', 'HEAD').trim() === NEW_FILE, `commit holds: ${git(root, 'show', '--name-only', '--format=', 'HEAD')}`)
      await until('message box cleared', async () => (await box.inputValue()) === '')
      check((await rows(page, 'changes')).includes(`M ${INVENTORY_SERVICE}`), 'the unstaged edit disappeared after the commit')

      // Discard the edit: in-app confirm, a copy in .forge/sync/trash, the file back as committed.
      await rowAction(page, INVENTORY_SERVICE, 'Discard')
      await confirm(page, /^Discard changes in/, 'Discard')
      await until('edit discarded', () => readFileSync(join(root, INVENTORY_SERVICE), 'utf8') === original)
      const trash = join(root, '.forge/sync/trash')
      const copies = existsSync(trash) ? readdirSync(trash).filter((d) => existsSync(join(trash, d, INVENTORY_SERVICE))) : []
      check(copies.length === 1, `no copy of the discarded file in .forge/sync/trash (${copies.join(', ')})`)
      check(readFileSync(join(trash, copies[0], INVENTORY_SERVICE), 'utf8').includes('edited for Source control'), 'the trash copy is not the discarded text')

      // Nothing staged: Commit asks whether to commit every change.
      writeFileSync(join(root, NEW_FILE), 'return { sword = 120 }\n')
      await until('second edit listed', async () => (await rows(page, 'changes')).includes(`M ${NEW_FILE}`))
      await box.fill('Raise the sword price')
      await page.locator(SCM).getByRole('button', { name: 'Commit', exact: true }).click()
      await confirm(page, /^Commit all changes\?/, 'Commit all')
      await until('commit all', () => git(root, 'log', '-1', '--format=%s').trim() === 'Raise the sword price', 15_000)

      // Push (never forced): origin catches up.
      await page.locator(SCM).getByRole('button', { name: 'Push', exact: true }).click()
      await until('pushed', () => git(root, 'rev-list', '--count', 'origin/main..main').trim() === '0', 20_000)
      check(git(`${root}-origin.git`, 'log', '-1', '--format=%s', 'main').trim() === 'Raise the sword price', 'origin does not have the commit')
      await until('panel clean', async () => !(await rows(page, 'changes')).length && !(await rows(page, 'staged')).length)
      await until('branch line reads ↓0 ↑0 after the push', async () => /↓0 ↑0/.test(await page.locator(`${SCM} .scm-branch`).innerText()))
      await dismissToasts(page)
      note(`commits: ${git(root, 'log', '--format=%s', '-2').trim().replace(/\n/g, ' / ')}`)
    }
  }
]
