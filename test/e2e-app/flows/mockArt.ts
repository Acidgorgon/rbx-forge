// Mock-renderer flow (test/e2e-app/mock.ts): Art "Split into layers" end to end against the browser
// mocks (mocks/mockArt.ts: a fake vision proposal, placeholder layer images, fake Open Cloud ids).
// Sets the Open Cloud key, opens the split from a concept card, waits for the proposed layers, checks
// the cost line, edits / removes / adds layers, generates them, imports all to Roblox and reads the
// Luau theme table; then reopens the saved set from the detail pane and from the fullscreen viewer.

import { check, CENTER, openPage } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'

const PANEL = '[data-testid="art-layers"]'

async function rows(page: Page): Promise<string[]> {
  return page.locator(`${PANEL} .art-layer`).evaluateAll((els: Element[]) => els.map((e) => (e.querySelector('input[aria-label="Layer name"]') as HTMLInputElement).value))
}

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.locator(PANEL).waitFor({ state: 'detached', timeout: 3000 }).catch(() => {
    throw new Error('Esc did not close the Split into layers panel')
  })
}

export interface MockFlow {
  name: string
  title: string
  run(ctx: { page: Page; shot(name: string): Promise<string>; note(text: string): void }): Promise<void>
}

export const mockArtFlows: MockFlow[] = [
  {
    name: 'art-split-layers',
    title: 'Art (mock): Split into layers proposes, edits, generates, imports all and shows the theme table',
    async run({ page, shot, note }) {
      await openPage(page, 'Art (image concepts)')
      // The Open Cloud key first (the panel's import needs it; the mock creator is set).
      await page.getByRole('button', { name: 'Roblox import' }).click()
      await page.getByLabel('Open Cloud API key').fill('mock-open-cloud-key-not-real-0000000000')
      await page.locator(`${CENTER} .art-setup`).getByRole('button', { name: 'Save' }).click()
      await page.locator(`${CENTER} .art-setup .badge-o.ok`).waitFor({ state: 'visible', timeout: 5000 })
      await page.getByRole('button', { name: 'Roblox import' }).click()

      // From the card's hover action.
      const cell = page.locator(`${CENTER} .art-cell`, { hasText: 'football-game-main-menu' })
      await cell.waitFor({ state: 'visible', timeout: 10_000 })
      await cell.hover()
      await cell.getByRole('button', { name: /^Split .* into layers$/ }).click()
      const panel = page.locator(PANEL)
      await panel.waitFor({ state: 'visible', timeout: 5000 })
      await page.waitForFunction((s: string) => document.querySelectorAll(`${s} .art-layer`).length === 6, PANEL, { timeout: 8000 }).catch(async () => {
        throw new Error(`the proposal did not show 6 layers (have ${(await rows(page)).join(', ')})`)
      })
      check((await rows(page)).join(',') === 'Background,QuickJoinCard,RankedCard,ShopIcon,GameLogo,Striker', `unexpected proposal ${(await rows(page)).join(',')}`)
      check(/^FootballGameMainMenu/.test(await panel.getByLabel('Concept name').inputValue()), `concept name ${await panel.getByLabel('Concept name').inputValue()}`)
      const cost = panel.locator('[data-testid="art-layers-cost"]')
      await page.waitForFunction((s: string) => /≈ \$/.test(document.querySelector(s)?.textContent ?? ''), `${PANEL} [data-testid="art-layers-cost"]`, { timeout: 5000 })
      check(/6 layers .* today \$/.test(await cost.innerText()), `cost line: ${await cost.innerText()}`)
      await shot('proposed')

      // Edit: drop the striker, rename the concept, add an icon layer.
      await panel.getByRole('button', { name: 'Remove Striker' }).click()
      await panel.getByLabel('Concept name').fill('FootballMenu')
      await panel.getByRole('button', { name: /Add layer/ }).click()
      const added = panel.locator('.art-layer').last()
      await added.getByLabel('Layer name').fill('PlayIcon')
      await added.getByLabel('Layer kind').selectOption('icon')
      await added.getByLabel(/prompt$/).fill('A glossy white play triangle icon with a dark outline')
      check((await rows(page)).join(',') === 'Background,QuickJoinCard,RankedCard,ShopIcon,GameLogo,PlayIcon', `after editing: ${(await rows(page)).join(',')}`)
      // A duplicate name blocks generating until it is fixed.
      await added.getByLabel('Layer name').fill('ShopIcon')
      const go = panel.getByRole('button', { name: /^Generate 6 layers$/ })
      check(await go.isDisabled(), 'Generate is enabled with two layers named ShopIcon')
      await added.getByLabel('Layer name').fill('PlayIcon')
      await page.waitForFunction((s: string) => /6 layers/.test(document.querySelector(s)?.textContent ?? ''), `${PANEL} [data-testid="art-layers-cost"]`, { timeout: 5000 })
      check(!(await go.isDisabled()), 'Generate stayed disabled')

      await go.click()
      const out = panel.locator('.art-layers-out')
      await out.waitFor({ state: 'visible', timeout: 15_000 })
      check(/art\/ui\/FootballMenu\/layers · 6 layers · 6 not imported/.test(await out.locator('.set-sub').innerText()), `output header: ${await out.locator('.set-sub').innerText()}`)
      await page.waitForFunction((s: string) => document.querySelectorAll(`${s} .art-layer-thumb img`).length === 6, PANEL, { timeout: 5000 }).catch(() => {
        throw new Error('the generated layers have no previews')
      })
      await shot('generated')

      await out.getByRole('button', { name: /Import all to Roblox/ }).click()
      const snippet = panel.locator('[data-testid="art-layers-snippet"]')
      await page.waitForFunction((s: string) => /Background = "rbxassetid:\/\/\d+"/.test(document.querySelector(s)?.textContent ?? ''), `${PANEL} [data-testid="art-layers-snippet"]`, { timeout: 10_000 }).catch(async () => {
        throw new Error(`no theme table after the import: ${await snippet.innerText()}`)
      })
      const table = await snippet.innerText()
      for (const n of ['Background', 'QuickJoinCard', 'RankedCard', 'ShopIcon', 'GameLogo', 'PlayIcon']) check(new RegExp(`\\b${n} = "rbxassetid://\\d+",`).test(table), `${n} missing from the theme table`)
      check(/all imported/.test(await out.locator('.set-sub').innerText()), 'the header does not say all imported')
      check(await out.getByRole('button', { name: /Import all to Roblox/ }).isDisabled(), 'Import all stays enabled with nothing to import')
      await out.getByRole('button', { name: /Copy theme/ }).click()
      await shot('imported')
      await closePanel(page)

      // The detail pane's action reopens the saved set (no new proposal).
      await cell.locator('.art-card').click()
      const detail = page.locator(`${CENTER} .art-detail`)
      await detail.waitFor({ state: 'visible', timeout: 5000 })
      await detail.getByRole('button', { name: /Split into layers/ }).click()
      await panel.waitFor({ state: 'visible', timeout: 5000 })
      await panel.getByText('Saved layers loaded').waitFor({ state: 'visible', timeout: 5000 })
      check((await panel.getByLabel('Concept name').inputValue()) === 'FootballMenu', 'the saved set did not keep its name')
      check(/PlayIcon = "rbxassetid:/.test(await snippet.innerText()), 'the saved set lost its ids')
      await closePanel(page)

      // And the fullscreen viewer's action.
      await cell.locator('.art-card').dblclick()
      const lb = page.locator('[data-testid="lightbox"]')
      await lb.waitFor({ state: 'visible', timeout: 5000 })
      await lb.getByRole('button', { name: /Split into layers/ }).click()
      await panel.waitFor({ state: 'visible', timeout: 5000 })
      check(!(await lb.count()), 'the viewer stayed open under the panel')
      await closePanel(page)
      note('proposed 6, edited to 6, generated, imported all, theme table copied; reopened from the detail pane and the viewer')
    }
  }
]
