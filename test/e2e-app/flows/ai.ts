// Model-backed flows. With no keys every AI entry point must fail with a clear message; then the
// "Custom (OpenAI-compatible)" provider is pointed at the suite's fake server (lib/fakeProvider.ts)
// through Settings > Providers, and chat, restate-first and a lab compose run end to end.

import { FAKE_MODEL } from '../lib/fakeProvider.ts'
import { check, CENTER, dismissDigest, mod, openPage, SkipFlow, waitText } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'

const ASSISTANT = 'aside.panel.right'

// A request big enough for the restate-first heuristic (several actions, files, a list).
export const BIG_ASK = [
  'Build a full inventory system for the game and then wire it into the shop:',
  '- add stacking and drag and drop to `src/client/Client/Controllers/InventoryController/init.luau`',
  '- create persistence in InventoryService with DataStore and migrate the old PlayerData format',
  '- refactor the shop UI to use it and also write tests for every module, end to end'
].join('\n')

async function openAssistant(page: Page): Promise<void> {
  if ((await page.locator(ASSISTANT).getAttribute('aria-hidden')) === 'true') await page.keyboard.press(`${mod}+L`)
  await page.locator(`${ASSISTANT} textarea`).first().waitFor({ state: 'visible', timeout: 5000 })
}

async function newChat(page: Page): Promise<void> {
  await openAssistant(page)
  await page.locator(`${ASSISTANT} button[title^="New thread"]`).click()
  await page.waitForTimeout(300)
}

async function send(page: Page, text: string): Promise<void> {
  const box = page.locator(`${ASSISTANT} textarea`).first()
  await box.fill(text)
  await box.press(`${mod}+Enter`)
}

export const aiFlows: Flow[] = [
  {
    name: 'chat-no-key',
    title: 'Chat with no provider: clear "set up a provider" state, sending does not crash',
    timeoutMs: 45_000,
    async run({ page, note, shot }) {
      await newChat(page)
      await waitText(page, /No model provider is set up/i, { within: ASSISTANT })
      await send(page, 'hello there, what does InventoryService do?')
      await page.waitForTimeout(3000)
      await shot('sent')
      const text = (await page.locator(ASSISTANT).innerText()).replace(/\s+/g, ' ')
      const msg = /(No model provider is set up|Add (an|a) [\w ]+ API key|API key|not set up|provider)[^.]{0,120}/i.exec(text)
      check(msg, `no clear no-provider message after sending: ${text.slice(0, 300)}`)
      note(msg![0].slice(0, 140))
      // The chat must not stay busy after the failed turn.
      const idle = await page
        .waitForFunction(() => (document.querySelector('aside.panel.right textarea') as HTMLTextAreaElement | null)?.placeholder !== 'working…', undefined, { timeout: 15_000 })
        .then(() => true, () => false)
      check(idle, 'the chat still shows "working…" 15 s after the no-key error')
    }
  },
  {
    name: 'fake-provider',
    title: 'Settings > Providers: point Custom at the fake server; chat answers through it',
    timeoutMs: 60_000,
    async run({ page, fake, note }) {
      await openPage(page, 'Settings')
      await page.locator('nav.set-nav button', { hasText: 'Providers' }).click()
      const card = page.locator('#pv-custom')
      await card.scrollIntoViewIfNeeded()
      const url = card.getByLabel(/base URL/)
      await url.fill(fake.baseUrl)
      await url.press('Enter')
      await card.locator('.badge-o.ok', { hasText: 'ready' }).waitFor({ timeout: 10_000 })
      await page.evaluate((m: string) => window.harness.setDefaultModel('custom', m), FAKE_MODEL)
      // The renderer reads the default model at start: reload it, then start a new chat on it.
      await page.reload()
      await page.locator('nav.activity').waitFor({ state: 'visible', timeout: 30_000 })
      // The automatic digest is once per project open: a renderer reload must not bring it back.
      const digest = await dismissDigest(page)
      check(!digest, `the away digest came back after a renderer reload (${digest})`)
      await newChat(page)
      await waitText(page, FAKE_MODEL, { within: ASSISTANT }).catch(() => undefined)
      const before = fake.requests.length
      await send(page, 'say hi')
      await page.waitForFunction(() => /FAKE-REPLY/.test(document.querySelector('aside.panel.right')?.textContent ?? ''), undefined, { timeout: 20_000 }).catch(() => {
        throw new Error(`no fake reply in the chat (${fake.requests.length - before} request(s) reached the fake server)`)
      })
      note(`${fake.requests.length - before} request(s) to the fake provider`)
    }
  },
  {
    name: 'restate-chat',
    title: 'Restate-first card for a big chat ask; Yes, go runs it',
    timeoutMs: 60_000,
    async run({ page, fake, note }) {
      await newChat(page)
      await send(page, BIG_ASK)
      const card = page.locator(`${ASSISTANT} .m-restate`).last()
      await card.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
        throw new Error(`no restate card (fake requests: ${fake.requests.map((r) => r.rule).join(', ')})`)
      })
      await waitText(page, /FAKE-RESTATE goal/, { within: ASSISTANT, timeout: 15_000 })
      const n = fake.requests.length
      await card.getByRole('button', { name: /Yes, go/ }).click()
      await page.waitForFunction((k: number) => /FAKE-REPLY/.test(document.querySelector('aside.panel.right')?.textContent ?? '') && k >= 0, n, { timeout: 20_000 })
      note(`restate rule hits: ${fake.requests.filter((r) => r.rule === 'restate').length}`)
    }
  },
  {
    name: 'restate-lab',
    title: 'VFX Make with a big brief: restate card, then compose via the fake model',
    timeoutMs: 120_000,
    async run({ page, fake, note, shot }) {
      await openPage(page, 'VFX Lab')
      const input = page.locator(`${CENTER} .vfx-make-row input`).first()
      await input.fill('a dark fireball that charges up in the hand, then launches and explodes into lingering embers like in jjk, then dissipates slowly')
      const before = (await page.evaluate(() => window.harness.vfxList())).length
      await page.locator(`${CENTER} .vfx-make-row button.primary, ${CENTER} button`, { hasText: /^\s*Make\s*$/ }).first().click()
      const card = page.locator(`${CENTER} .rs-actions`).first()
      await card.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {
        throw new Error(`no restate card for a staged brief (fake rules: ${fake.requests.map((r) => r.rule).join(', ')})`)
      })
      await card.getByRole('button', { name: /Yes, go/ }).click()
      let after = before
      let failed = ''
      for (let i = 0; i < 180 && after <= before && !failed; i++) {
        await page.waitForTimeout(500)
        after = (await page.evaluate(() => window.harness.vfxList())).length
        failed = (await page.locator('.toast', { hasText: /Could not make/ }).allInnerTexts()).join(' ').replace(/\s+/g, ' ')
      }
      if (failed && /Lune/i.test(failed)) throw new SkipFlow(`sequence compose needs Lune (set LUNE_PATH); restate card + fake compose call worked, then: "${failed}"`)
      if (failed) throw new Error(`Make failed after confirming: ${failed}`)
      await shot('made')
      if (after <= before) {
        const toast = await page.locator('.toast').allInnerTexts()
        const logs = (await page.evaluate(() => window.harness.getLogs())).filter((l: { text: string }) => /\[vfx\]|\[gating\]|restate/.test(l.text)).slice(-6).map((l: { text: string }) => l.text)
        throw new Error(`Make did not add an effect after confirming (toasts: ${toast.join(' | ').replace(/\s+/g, ' ')}; logs: ${logs.join(' / ')})`)
      }
      note(`library ${before} -> ${(await page.evaluate(() => window.harness.vfxList())).length}; fake rules: ${[...new Set(fake.requests.map((r) => r.rule))].join(', ')}`)
    }
  }
]
