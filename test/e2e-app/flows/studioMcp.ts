// Settings > Studio & sync > Studio tools (Roblox Studio's MCP server): nothing is found on Linux,
// a manual command (a fake stdio MCP server) is saved, Test connection lists its tools, the chat
// header shows the Studio pill, and "Use auto" clears the override again.

import { resolve } from 'node:path'
import { check, openPage, settingsSection } from '../lib/ui.ts'
import type { Flow } from './types.ts'

const FAKE_SERVER = resolve(import.meta.dirname, '..', '..', 'fixtures', 'mcp', 'fakeStudioMcp.mjs')
const SEC = '#set-studio-mcp'

export const studioMcpFlows: Flow[] = [
  {
    name: 'studio-mcp-settings',
    title: 'Settings > Studio tools: status, manual command, Test connection, Studio pill',
    timeoutMs: 60_000,
    async run({ page, shot }) {
      await openPage(page, 'Settings')
      await settingsSection(page, 'Studio tools')
      const sec = page.locator(SEC)
      await sec.waitFor({ state: 'visible', timeout: 5000 })
      await sec.getByText('Roblox Studio tools (MCP)').waitFor({ timeout: 5000 })
      const state = sec.locator('[data-testid="studio-mcp-state"]')
      if (process.platform === 'linux') check(/Not found/.test((await state.textContent()) ?? ''), `Linux has no Studio: ${await state.textContent()}`)
      check(!(await page.locator('[data-testid="studio-pill"]').count()), 'no Studio pill without a command')

      await sec.locator('input[aria-label="Studio MCP command"]').fill(process.execPath)
      await sec.locator('input[aria-label="Studio MCP args"]').fill(`"${FAKE_SERVER}"`)
      await sec.getByRole('button', { name: 'Save' }).click()
      await page.waitForFunction(() => document.querySelector('#set-studio-mcp [data-testid="studio-mcp-state"]')?.textContent?.includes('Manual'), undefined, { timeout: 5000 })
      const status = await page.evaluate(() => window.harness.studioMcpStatus())
      check(status.source === 'manual' && status.active?.args[0]?.endsWith('fakeStudioMcp.mjs'), `saved: ${JSON.stringify(status.active)}`)

      await sec.getByRole('button', { name: 'Test Studio MCP connection' }).click()
      const result = sec.locator('[data-testid="studio-mcp-test"]')
      await result.waitFor({ state: 'visible', timeout: 20_000 })
      const text = (await result.textContent()) ?? ''
      check(/Connected: 4 tools from FakeStudioMCP/.test(text), `test result: ${text}`)
      await sec.getByText('studio_id abc: MyGame (PlaceId 42)').waitFor({ timeout: 3000 })
      await page.waitForFunction(() => document.querySelector('#set-studio-mcp [data-testid="studio-mcp-state"]')?.textContent?.includes('Connected'), undefined, { timeout: 5000 })
      check((await page.locator('[data-testid="studio-pill"]').count()) === 1, 'the chat header shows the Studio pill')
      await shot('connected')

      await sec.getByRole('button', { name: 'Use auto' }).click()
      await page.waitForFunction(async () => (await window.harness.studioMcpStatus()).source !== 'manual', undefined, { timeout: 5000, polling: 100 })
      await page.locator('[data-testid="studio-pill"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {
        if (process.platform === 'linux') throw new Error('the Studio pill stayed after clearing the command')
      })
    }
  }
]
