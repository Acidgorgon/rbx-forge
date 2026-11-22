// The kept labs: UI Preview.

import { check, CENTER, openPage, SkipFlow } from '../lib/ui.ts'
import type { Flow } from './types.ts'

// What a lab says when no model provider is configured.
export const NO_PROVIDER = /no (model )?provider|api key|add a model|not configured|no model|set up a (model|provider)|could not (restate|reach)|provider/i

export const labFlows: Flow[] = [
  {
    name: 'ui-preview',
    title: 'UI Preview: open the Counter story, click it in Interact mode',
    timeoutMs: 90_000,
    async run({ page, note }) {
      await openPage(page, 'UI Preview (stories)')
      // A narrow editor area shows one pane at a time: pick the Stories tab.
      const tabs = page.locator(`${CENTER} .uip-narrow-tabs`)
      if (await tabs.isVisible().catch(() => false)) await tabs.getByRole('tab', { name: 'Stories' }).click()
      const story = page.locator(`${CENTER} .uip-story`, { hasText: 'Counter' }).first()
      await story.waitFor({ state: 'visible', timeout: 15_000 })
      if (await page.locator(`${CENTER} .uip-hint`).isVisible().catch(() => false)) {
        const hint = (await page.locator(`${CENTER} .uip-hint`).innerText()).trim()
        check(/lune/i.test(hint), `no-Lune hint is unclear: ${hint}`)
        throw new SkipFlow(`Lune not available (set LUNE_PATH); page shows: "${hint}"`)
      }
      await story.click()
      await page.locator(`${CENTER} .uip-group button, ${CENTER} [aria-label="Mode"] button`, { hasText: 'Interact' }).first().click()
      const btn = page.locator(`${CENTER} .uip-stage .uip-node.uip-btn`).first()
      await btn.waitFor({ state: 'visible', timeout: 30_000 })
      await page.waitForFunction(() => /Clicks: 0/.test(document.querySelector('.editor-area .uip-stage')?.textContent ?? ''), undefined, { timeout: 15_000 })
      await btn.click()
      await page.waitForFunction(() => /Clicks: 1/.test(document.querySelector('.editor-area .uip-stage')?.textContent ?? ''), undefined, { timeout: 15_000 })
      note('Counter went 0 -> 1 on click')
    }
  }
]
