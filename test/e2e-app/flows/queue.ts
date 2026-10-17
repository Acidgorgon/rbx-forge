// Queued prompts in the Assistant: a message typed while a turn runs waits as "Queued" and goes out
// when the turn ends; Stop pauses the queue until "Resume queue"; "Send now" stops the turn and sends
// that one first. Run after 'fake-provider' (its SLOW rule keeps a turn running for a few seconds).

import { SLOW_MARKER, SLOW_MS } from '../lib/fakeProvider.ts'
import { check, dismissToasts, mod } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const ASSISTANT = 'aside.panel.right'
const QUEUE = `${ASSISTANT} .cmp-queue`

async function newChat(page: Page): Promise<void> {
  if ((await page.locator(ASSISTANT).getAttribute('aria-hidden')) === 'true') await page.keyboard.press(`${mod}+L`)
  await page.locator(`${ASSISTANT} button[title^="New thread"]`).click()
  await page.locator(`${ASSISTANT} textarea`).first().waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(300)
}

async function type(page: Page, text: string): Promise<void> {
  const box = page.locator(`${ASSISTANT} textarea[aria-label="Message"]`)
  await box.fill(text)
  await page.keyboard.press('Escape').catch(() => undefined)
  await box.focus()
  await box.press('Enter')
}

async function working(page: Page): Promise<void> {
  await page.waitForFunction(() => (document.querySelector('aside.panel.right textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.placeholder === 'working…', undefined, { timeout: 10_000 })
}

async function idle(page: Page, ms = 30_000): Promise<void> {
  await page.waitForFunction(() => (document.querySelector('aside.panel.right textarea[aria-label="Message"]') as HTMLTextAreaElement | null)?.placeholder !== 'working…', undefined, { timeout: ms })
}

const panelText = (page: Page) => page.locator(ASSISTANT).innerText()

// Index of the user message bubble with this text, and of the reply that echoes it.
async function order(page: Page, needles: string[]): Promise<number[]> {
  const text = await panelText(page)
  return needles.map((n) => text.indexOf(n))
}

export const queueFlows: Flow[] = [
  {
    name: 'chat-queue',
    title: 'A message sent while a turn runs shows as Queued, then goes out after the first reply',
    timeoutMs: 60_000,
    async run({ page, fake, note, shot }) {
      await dismissToasts(page)
      await newChat(page)
      const n = fake.requests.length
      await type(page, `say hi ${SLOW_MARKER} Q-FIRST`)
      await working(page)
      await type(page, 'say hi Q-SECOND')
      const row = page.locator(`${QUEUE} [data-testid="queued-prompt"]`)
      await row.first().waitFor({ state: 'visible', timeout: 5000 })
      const queued = await page.locator(QUEUE).innerText()
      check(/queued/i.test(queued) && queued.includes('Q-SECOND'), `the queue does not show the message as Queued: ${queued.slice(0, 160)}`)
      check((await row.count()) === 1, `expected one queued row, got ${await row.count()}`)
      check((await page.locator(`${ASSISTANT} textarea[aria-label="Message"]`).inputValue()) === '', 'the composer was not cleared')
      check(!fake.requests.slice(n).some((r) => r.user.includes('Q-SECOND')), 'the queued message reached the provider while the first turn ran')
      await shot('queued')
      // The first reply lands, then the queued message is sent by itself.
      await page.waitForFunction(() => /FAKE-REPLY: ok \(say hi Q-SECOND/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: SLOW_MS + 20_000 }).catch(() => {
        throw new Error(`the queued message was not sent (fake rules: ${fake.requests.slice(n).map((r) => r.rule).join(', ')})`)
      })
      await idle(page)
      check((await page.locator(QUEUE).count()) === 0, 'the queue is still shown after it was sent')
      const first = fake.requests.slice(n).find((r) => r.user.includes('Q-FIRST'))
      const second = fake.requests.slice(n).find((r) => r.user.includes('Q-SECOND'))
      check(first && second && second.at >= first.at + SLOW_MS - 200, 'the queued message did not wait for the first turn to end')
      const [u1, r1, u2, r2] = await order(page, ['say hi E2E-SLOW Q-FIRST', 'FAKE-REPLY: ok (say hi E2E-SLOW Q-FIRST', 'say hi Q-SECOND', 'FAKE-REPLY: ok (say hi Q-SECOND'])
      check(u1 >= 0 && u1 < r1 && r1 < u2 && u2 < r2, `messages out of order (${[u1, r1, u2, r2].join(', ')})`)
      note(`second request ${second!.at - first!.at} ms after the first`)
    }
  },
  {
    name: 'chat-queue-controls',
    title: 'Stop pauses the queue until Resume; Send now stops the turn and sends that message first',
    timeoutMs: 90_000,
    async run({ page, fake, note }) {
      await dismissToasts(page)
      await newChat(page)
      const n = fake.requests.length
      // Stop: the queue pauses instead of firing.
      await type(page, `say hi ${SLOW_MARKER} Q-STOPPED`)
      await working(page)
      await type(page, 'say hi Q-AFTER-STOP')
      await page.locator(`${QUEUE} [data-testid="queued-prompt"]`).first().waitFor({ state: 'visible', timeout: 5000 })
      await page.locator(`${ASSISTANT} button[aria-label="Stop"]`).click()
      const resume = page.locator(QUEUE).getByRole('button', { name: 'Resume queue' })
      await resume.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {
        throw new Error('no "Resume queue" after Stop')
      })
      await idle(page)
      await page.waitForTimeout(800)
      check(!fake.requests.slice(n).some((r) => r.user.includes('Q-AFTER-STOP')), 'the queue sent a message after Stop')
      check(/stopped/.test(await page.locator(QUEUE).innerText()), 'the pause does not say the turn was stopped')
      await resume.click()
      await page.waitForFunction(() => /FAKE-REPLY: ok \(say hi Q-AFTER-STOP/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: 20_000 }).catch(() => {
        throw new Error('Resume queue did not send the queued message')
      })
      await idle(page)

      // Send now: B jumps the queue and the running turn stops.
      const m = fake.requests.length
      await type(page, `say hi ${SLOW_MARKER} Q-RUNNING`)
      await working(page)
      await type(page, 'say hi Q-A')
      await type(page, 'say hi Q-B')
      const rows = page.locator(`${QUEUE} [data-testid="queued-prompt"]`)
      await page.waitForFunction(() => document.querySelectorAll('aside.panel.right .cmp-queue [data-testid="queued-prompt"]').length === 2, undefined, { timeout: 5000 })
      check((await rows.nth(0).innerText()).includes('Q-A') && (await rows.nth(1).innerText()).includes('Q-B'), 'queued rows are not in the order typed')
      await rows.nth(1).getByRole('button', { name: 'Send now' }).click()
      await page.waitForFunction(() => /FAKE-REPLY: ok \(say hi Q-A\b/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: 30_000 }).catch(() => {
        throw new Error(`the queue did not finish after Send now (fake rules: ${fake.requests.slice(m).map((r) => r.rule).join(', ')})`)
      })
      await idle(page)
      const sent = fake.requests.slice(m).map((r) => (/Q-(RUNNING|A|B)\b/.exec(r.user)?.[0] ?? r.rule))
      check(sent.join(',') === 'Q-RUNNING,Q-B,Q-A', `send order after Send now: ${sent.join(', ')}`)
      check(((await panelText(page)).match(/Stopped\./g) ?? []).length >= 2, 'the running turn was not stopped by Send now')
      note(`order: ${sent.join(' → ')}`)
    }
  }
]
