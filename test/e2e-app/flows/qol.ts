// v06 additions: Forge Doctor, bug report, Add to game, Thumbnail Lab, UI Motion Lab, chat modes,
// slash commands, spend cap. qolFlows run with no provider; providerQolFlows after 'fake-provider'.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WRITE_MARKER } from '../lib/fakeProvider.ts'
import { INVENTORY_SERVICE } from '../lib/project.ts'
import { check, CENTER, closeBottom, dismissToasts, mod, openPage, waitText } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const ASSISTANT = 'aside.panel.right'

async function newChat(page: Page): Promise<void> {
  if ((await page.locator(ASSISTANT).getAttribute('aria-hidden')) === 'true') await page.keyboard.press(`${mod}+L`)
  await page.locator(`${ASSISTANT} button[title^="New thread"]`).click()
  await page.locator(`${ASSISTANT} textarea`).first().waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(300)
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator(`${ASSISTANT} textarea`).first()
  await box.fill(text)
  await page.keyboard.press('Escape').catch(() => undefined)
  await box.focus()
  await box.press(`${mod}+Enter`)
}

async function idle(page: Page, ms = 20_000): Promise<void> {
  await page.waitForFunction(() => (document.querySelector('aside.panel.right textarea') as HTMLTextAreaElement | null)?.placeholder !== 'working…', undefined, { timeout: ms })
}

async function setMode(page: Page, label: 'Ask' | 'Plan' | 'Edit with approval' | 'Auto-accept edits'): Promise<void> {
  await page.locator(`${ASSISTANT} [aria-label^="Chat mode:"]`).first().click()
  await page.locator('.menu [role="menuitem"]', { hasText: new RegExp(`^${label}`) }).first().click()
  await page.locator(`${ASSISTANT} [aria-label="Chat mode: ${label}"]`).first().waitFor({ timeout: 5000 })
}

export const qolFlows: Flow[] = [
  {
    name: 'doctor',
    title: 'Help > Forge Doctor runs and renders its checks',
    timeoutMs: 60_000,
    async run({ page, note }) {
      await page.locator('button[aria-label="Help"]').click()
      await page.locator('.menu [role="menuitem"]', { hasText: 'Forge Doctor' }).click()
      const dialog = page.locator('[role="dialog"][aria-label="Forge Doctor"]')
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      await dialog.locator('.doc-sum').waitFor({ timeout: 45_000 })
      await page.waitForFunction(() => !/checking…/.test(document.querySelector('[aria-label="Forge Doctor"] .doc-sum')?.textContent ?? ''), undefined, { timeout: 45_000 })
      const groups = await dialog.locator('.doc-group h3').allInnerTexts()
      check(groups.length >= 3, `Doctor shows ${groups.length} check groups`)
      note(`${(await dialog.locator('.doc-sum').innerText()).replace(/\s+/g, ' ')}; groups: ${groups.join(', ')}`)
      await dialog.getByRole('button', { name: /Run again/ }).click()
      await page.waitForTimeout(300)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 5000 })
    }
  },
  {
    name: 'bug-report',
    title: 'Titlebar bug report saves a report into the isolated userData',
    timeoutMs: 45_000,
    async run({ page, sandbox, note }) {
      await page.locator('button[aria-label="Report a bug"]').click()
      const dialog = page.locator('[role="dialog"]', { hasText: /bug/i }).first()
      await dialog.waitFor({ state: 'visible', timeout: 5000 })
      await dialog.locator('textarea').first().fill('Forge e2e: the preview went black (test report)')
      await dialog.getByRole('button', { name: /Save and copy/ }).click()
      await page.locator('[role="dialog"][aria-label="Bug report saved"]').waitFor({ timeout: 20_000 })
      const root = join(sandbox.userData, 'bug-reports')
      check(existsSync(root), `no ${root}`)
      const dirs = readdirSync(root)
      check(dirs.length > 0, 'bug-reports is empty')
      const report = readFileSync(join(root, dirs[0], 'report.md'), 'utf8')
      check(report.includes('the preview went black'), 'report.md does not hold the description')
      note(`${dirs[0]}/report.md, ${report.length} chars${existsSync(join(root, dirs[0], 'screenshot.png')) ? ' + screenshot.png' : ''}`)
      await page.locator('[role="dialog"][aria-label="Bug report saved"]').getByRole('button', { name: 'Done' }).click()
    }
  },
  {
    name: 'thumbnail-lab',
    title: 'Thumbnail Lab renders',
    async run({ page, shot }) {
      await openPage(page, 'Thumbnail Lab')
      await waitText(page, /Thumbnail/, { within: CENTER })
      await shot('page')
    }
  },
  {
    name: 'ui-motion-lab',
    title: 'UI Motion Lab renders',
    async run({ page, shot }) {
      await openPage(page, 'UI Motion Lab')
      await waitText(page, /Motion/, { within: CENTER })
      await shot('page')
    }
  },
  {
    name: 'add-to-game',
    title: 'VFX example stays in the library; Add to game writes it, then shows a local change as a diff',
    timeoutMs: 60_000,
    async run({ page, root, note }) {
      await openPage(page, 'VFX Lab')
      await closeBottom(page)
      const detail = page.locator(`${CENTER} .vfx-detail`).first()
      if (!(await detail.count())) {
        await page.locator(`${CENTER} .vfx-card`, { hasText: /HollowPurple|Hollow Purple/ }).first().click()
        await detail.waitFor({ state: 'visible', timeout: 10_000 })
      }
      // Adding the example put it in the library only: nothing in the project yet.
      const dir = join(root, 'src', 'shared', 'VFX', 'HollowPurple')
      check(!existsSync(dir), 'adding the VFX example already wrote src/shared/VFX/HollowPurple')
      const a2g = page.locator('[role="dialog"]', { has: page.locator('.a2g-files, .a2g-error') }).first()
      const open = async () => {
        await detail.getByRole('button', { name: /Add to game/ }).first().click()
        await a2g.waitFor({ state: 'visible', timeout: 15_000 })
        await a2g.locator('.a2g-file').first().waitFor({ timeout: 15_000 })
        await page.waitForFunction(() => !document.querySelector('.a2g-files.stale'), undefined, { timeout: 15_000 })
      }
      // First time: every file is new; write them.
      await open()
      const files = await a2g.locator('.a2g-file .a2g-path').allInnerTexts()
      check(files.length > 0, 'Add to game lists no files')
      check((await a2g.locator('.a2g-file.new').count()) > 0, 'no file is listed as new for an unwritten example')
      await a2g.getByRole('button', { name: /^\s*Write \d+ files?/ }).click()
      await page.locator('.a2g-result').waitFor({ timeout: 20_000 })
      await a2g.getByRole('button', { name: 'Done' }).click()
      check(existsSync(dir), 'Write did not create src/shared/VFX/HollowPurple')
      // A local change to one of the written files: the next plan shows it as changed, with a diff.
      const f = readdirSync(dir).find((x) => x.endsWith('.luau'))
      check(f, `no .luau in ${dir}`)
      writeFileSync(join(dir, f!), `${readFileSync(join(dir, f!), 'utf8')}\n-- local change (forge e2e)\n`)
      await open()
      const dialog = a2g
      const diffBtn = dialog.getByRole('button', { name: /Diff/ }).first()
      check(await diffBtn.count(), `no changed file with a Diff button (files: ${files.join(', ')})`)
      await diffBtn.click()
      await dialog.locator('pre.a2g-diff').first().waitFor({ timeout: 5000 })
      const diff = await dialog.locator('pre.a2g-diff').first().innerText()
      check(/local change \(forge e2e\)/.test(diff), 'the diff does not show the local change')
      note(`${files.length} file(s): ${files.slice(0, 4).join(', ')}`)
      await dialog.getByRole('button', { name: 'Cancel' }).click()
    }
  }
]

export const providerQolFlows: Flow[] = [
  {
    name: 'slash-commands',
    title: '/help and /cost answer in the chat',
    timeoutMs: 45_000,
    async run({ page, note }) {
      await newChat(page)
      await send(page, '/help')
      await page.waitForFunction(() => /\/cost/.test(document.querySelector('aside.panel.right .messages, aside.panel.right')?.textContent ?? '') && /\/rewind|\/resume|\/model/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: 10_000 }).catch(() => {
        throw new Error('/help did not list the commands')
      })
      await send(page, '/cost')
      // /cost answers with "This chat" (usage or "no usage yet") and "Today $x".
      await page.waitForFunction(() => /This chat[\s\S]*(no usage yet|requests|in \/)[\s\S]*Today\s*\$\d/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: 10_000 }).catch(() => {
        throw new Error('/cost did not answer with this chat\'s usage and today\'s spend')
      })
      const text = (await page.locator(ASSISTANT).innerText()).replace(/\s+/g, ' ')
      note(`/cost: ${(/This chat.*?Today \S+/.exec(text)?.[0] ?? '').slice(0, 160)}`)
    }
  },
  {
    name: 'ask-mode',
    title: 'Ask mode refuses a write the model attempts; the file is unchanged',
    timeoutMs: 60_000,
    async run({ page, root, fake, note }) {
      const file = join(root, INVENTORY_SERVICE)
      const before = readFileSync(file, 'utf8')
      await newChat(page)
      await setMode(page, 'Ask')
      const n = fake.requests.length
      await send(page, `${WRITE_MARKER} what does InventoryService do?`)
      await page.waitForFunction(() => /FAKE-TOOL-RESULT/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: 20_000 }).catch(() => {
        throw new Error(`no answer after the write attempt (fake rules: ${fake.requests.slice(n).map((r) => r.rule).join(', ')})`)
      })
      await idle(page)
      check(readFileSync(file, 'utf8') === before, 'Ask mode let the model change InventoryService.luau')
      const first = fake.requests.slice(n).find((r) => r.rule === 'write-attempt')
      check(first && !first.toolNames.some((t) => /write_script/.test(t)), 'write_script was offered to the model in Ask mode')
      const echoed = fake.requests.slice(n).find((r) => r.lastRole === 'tool')?.lastTool ?? ''
      check(echoed.length > 0, 'the app sent no tool result for the refused call')
      check(/Writes are not allowed in Ask mode/.test(echoed), `the refusal is not the Ask-mode message: ${echoed.slice(0, 160)}`)
      note(`tool result: ${echoed.slice(0, 140)}`)
      await setMode(page, 'Edit with approval')
    }
  },
  {
    name: 'spend-cap',
    title: 'Spend cap $0.01 refuses a fake-provider call with the cap message',
    timeoutMs: 60_000,
    async run({ page, fake, note }) {
      await dismissToasts(page)
      await openPage(page, 'Settings')
      await page.locator('nav.set-nav button', { hasText: 'Usage' }).click()
      const daily = page.getByLabel('Daily cap in USD')
      await daily.fill('0.01')
      await daily.press('Enter')
      await page.waitForFunction(() => window.harness.spendState().then((s) => s.settings.dailyUsd === 0.01), undefined, { timeout: 5000 }).catch(() => undefined)
      const s0 = await page.evaluate(() => window.harness.spendState())
      check(s0.settings.dailyUsd === 0.01, `daily cap is ${s0.settings.dailyUsd}`)
      try {
        // The first call costs $0.02 (usage.cost), which crosses the cap; the next one is refused.
        fake.costUsd = 0.02
        await newChat(page)
        await send(page, 'say hi (spend 1)')
        await waitText(page, /FAKE-REPLY/, { within: ASSISTANT, timeout: 20_000 })
        await idle(page)
        const n = fake.requests.length
        await send(page, 'say hi (spend 2)')
        await page.waitForFunction(() => /Spending cap reached/.test(document.body.textContent ?? ''), undefined, { timeout: 15_000 }).catch(async () => {
          const st = await page.evaluate(() => window.harness.spendState())
          throw new Error(`no "Spending cap reached" message (spent today ${JSON.stringify(st.day)})`)
        })
        await idle(page)
        check(fake.requests.length === n, `the refused call still reached the provider (${fake.requests.length - n} request(s))`)
        const msg = (await page.locator(`${ASSISTANT}`).innerText()).match(/Spending cap reached[^\n]*/)?.[0] ?? ''
        note(msg.slice(0, 160))
      } finally {
        fake.costUsd = 0
        await page.evaluate(() => window.harness.spendSetSettings({ dailyUsd: null }))
      }
    }
  }
]
