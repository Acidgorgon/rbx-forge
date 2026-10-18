// Mock-renderer flow (test/e2e-app/mock.ts): the Source control section on the browser mocks
// (mocks/mockScm.ts: one staged and two unstaged changes over the mock files). Stages the untracked
// note, opens its diff, commits with Ctrl+Enter, then discards the last change through the in-app
// confirm, and checks the palette's Git commands are listed.

import { check, CENTER, mod, palette, showSide } from '../lib/ui.ts'
import type { MockFlow } from './mockArt.ts'

const SCM = 'aside.side section.scm'

export const mockScmFlows: MockFlow[] = [
  {
    name: 'source-control',
    title: 'Source control (mock): stage, diff, commit with Ctrl+Enter, discard with confirm, Git commands',
    async run({ page, shot, note }) {
      await showSide(page, 'Source control & Sync')
      const section = page.locator(SCM)
      await section.waitFor({ state: 'visible', timeout: 10_000 })
      const count = (group: string) => section.locator(`[data-group="${group}"] .scm-row`).count()
      check((await count('staged')) === 1 && (await count('changes')) === 2, `seeded rows: ${await count('staged')} staged, ${await count('changes')} changes`)
      check((await section.locator('.scm-branch').innerText()).includes('origin/main'), 'no upstream on the branch line')
      await shot('start')

      const todo = section.locator('[data-group="changes"] .scm-row', { has: page.locator('button[aria-label="Stage notes/todo list.md"]') })
      await todo.hover()
      await todo.locator('button[aria-label="Stage notes/todo list.md"]').click()
      await page.waitForFunction((s: string) => document.querySelectorAll(`${s} [data-group="staged"] .scm-row`).length === 2, SCM, { timeout: 5000 })
      await section.locator('[data-group="staged"] .scm-row', { hasText: 'todo list.md' }).click()
      await page.locator(`${CENTER} .gitdiff`).waitFor({ state: 'visible', timeout: 5000 })

      const box = section.getByLabel('Commit message')
      await box.fill('Shop and notes')
      await box.press(`${mod}+Enter`)
      await page.waitForFunction((s: string) => !document.querySelector(`${s} [data-group="staged"]`), SCM, { timeout: 5000 })
      check((await box.inputValue()) === '', 'message box not cleared after the commit')
      await page.locator('.toast', { hasText: /^Committed / }).first().waitFor({ state: 'visible', timeout: 5000 })

      const last = section.locator('[data-group="changes"] .scm-row').first()
      await last.hover()
      await last.locator('button[aria-label^="Discard "]').click()
      const dialog = page.getByRole('dialog', { name: /^Discard changes in/ })
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      check((await dialog.innerText()).includes('.forge/sync/trash'), 'the discard confirm does not mention the trash copy')
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
      await page.waitForFunction((s: string) => !document.querySelector(`${s} [data-group="changes"]`), SCM, { timeout: 5000 })
      await shot('clean')

      await palette(page, 'Git:')
      const labels = await page.locator('.palette').innerText()
      for (const c of ['Git: Commit', 'Git: Push', 'Git: Pull', 'Git: Fetch', 'Git: Stage all changes']) check(labels.includes(c), `palette lacks "${c}"`)
      await page.keyboard.press('Escape')
      note('staged, committed, discarded; Git commands listed')
    }
  }
]
