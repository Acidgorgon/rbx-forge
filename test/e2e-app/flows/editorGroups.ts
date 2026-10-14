// Split editor: drag a tab onto the editor's right edge to split, split a file down from the tab menu,
// edits in one group show in the other (one buffer), Ctrl+1 focuses a group, sashes resize, the
// layout is saved per project, and "Join all editor groups" folds everything back into one group.

import { check, CENTER, mod, waitText } from '../lib/ui.ts'
import type { Page } from '../lib/app.ts'
import type { Flow, FlowCtx } from './types.ts'

const groupCount = (page: Page) => page.locator(`${CENTER} .eg-group`).count()

async function openViaPalette(page: Page, name: string): Promise<void> {
  await page.keyboard.press(`${mod}+P`)
  const input = page.locator('.palette input').first()
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await input.fill(name)
  await waitText(page, name, { within: '.palette' })
  await page.keyboard.press('Enter')
  await page.locator(`${CENTER} .tab`, { hasText: name }).first().waitFor({ timeout: 5000 })
}

// Group ids in reading order with the tab titles each one shows.
async function groupsInOrder(page: Page): Promise<{ id: string; tabs: string[]; active: boolean; left: number; top: number; width: number }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.editor-area .eg-group')]
      .map((g) => {
        const r = g.getBoundingClientRect()
        return { id: g.dataset.groupId ?? '', tabs: [...g.querySelectorAll('.tab .tname')].map((t) => t.textContent ?? ''), active: g.classList.contains('active'), left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) }
      })
      .sort((a, b) => a.top - b.top || a.left - b.left)
  )
}

export const editorGroupFlows: Flow[] = [
  {
    name: 'split-editor',
    title: 'Split editor: drag a tab to split, shared buffer, focus, resize, persist, join',
    timeoutMs: 60_000,
    async run(ctx) {
      // Later flows expect one editor group: join whatever is left, even when a step failed.
      try {
        await splitFlow(ctx)
      } finally {
        if ((await groupCount(ctx.page)) > 1) await joinAll(ctx.page).catch(() => undefined)
      }
    }
  }
]

async function joinAll(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press(`${mod}+K`)
  const input = page.locator('.palette input').first()
  await input.waitFor({ state: 'visible', timeout: 5000 })
  await input.fill('>Join all editor groups')
  await waitText(page, 'Join all editor groups', { within: '.palette' })
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.editor-area .eg-group').length === 1, undefined, { timeout: 5000 })
}

async function splitFlow({ page, root, note, shot }: FlowCtx): Promise<void> {
  await openViaPalette(page, 'InventoryService')
  await openViaPalette(page, 'PlayerData')
  check((await groupCount(page)) === 1, 'expected one editor group to start with')

  // 1. Drag the PlayerData tab onto the right edge of the editor: the right half lights up.
  const tab = page.locator(`${CENTER} .tab`, { hasText: 'PlayerData' }).first()
  const tb = (await tab.boundingBox())!
  const area = (await page.locator(`${CENTER} .eg-group`).first().boundingBox())!
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2)
  await page.mouse.down()
  const tx = area.x + area.width - 30
  const ty = area.y + area.height / 2
  for (let i = 1; i <= 12; i++) await page.mouse.move(tb.x + (tx - tb.x) * (i / 12), tb.y + (ty - tb.y) * (i / 12))
  await page.locator('.eg-drop.on[data-zone="right"]').waitFor({ state: 'visible', timeout: 3000 })
  check(await page.locator('.eg-ghost', { hasText: 'PlayerData' }).isVisible(), 'drag chip does not follow the pointer')
  await page.waitForTimeout(250)
  await shot('drop-right')
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.editor-area .eg-group').length === 2, undefined, { timeout: 5000 })
  let groups = await groupsInOrder(page)
  check(groups[1].tabs.includes('PlayerData') && !groups[0].tabs.includes('PlayerData'), `PlayerData should have moved right: ${JSON.stringify(groups)}`)
  check(groups[1].active, 'the new group should be active')
  check(groups[0].left < groups[1].left, 'new group is not to the right')
  check(!(await page.locator('.eg-drop').count()), 'drop overlay still showing after the drop')

  // 2. Split InventoryService down from its tab menu: the same file in two groups.
  await page.locator(`${CENTER} .eg-group[data-group-id="${groups[0].id}"] .tab`, { hasText: 'InventoryService' }).click({ button: 'right' })
  await page.locator('.menu').first().waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('.menu [role="menuitem"]', { hasText: /^Split down/ }).click({ timeout: 5000 })
  await page.waitForFunction(() => document.querySelectorAll('.editor-area .eg-group').length === 3, undefined, { timeout: 5000 })
  groups = await groupsInOrder(page)
  const withInv = groups.filter((g) => g.tabs.includes('InventoryService'))
  check(withInv.length === 2, `InventoryService should be open in two groups: ${JSON.stringify(groups)}`)
  await page.locator(`${CENTER} .eg-group .monaco-editor`).nth(1).waitFor({ state: 'visible', timeout: 15_000 })

  // 3. Type in the top copy; the bottom copy shows it (one model), then undo.
  const top = page.locator(`${CENTER} .eg-group[data-group-id="${withInv[0].id}"]`)
  const bottom = page.locator(`${CENTER} .eg-group[data-group-id="${withInv[1].id}"]`)
  // Earlier flows may have left a page (Settings) active in the top group: show the file there.
  await top.locator('.tab', { hasText: 'InventoryService' }).click()
  await top.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press(`${mod}+Home`)
  await page.keyboard.type('-- split-sync ')
  await page
    .waitForFunction((id: string) => document.querySelector(`.editor-area .eg-group[data-group-id="${id}"] .view-lines`)?.textContent?.includes('split-sync'), withInv[1].id, { timeout: 5000 })
    .catch(() => {
      throw new Error('an edit in one group did not show in the other group of the same file')
    })
  check(await top.locator('.crumbs').getByText('Unsaved', { exact: true }).isVisible(), 'breadcrumb badge should say Unsaved')
  // Focus is still in the top editor.
  // Undo just the typing (one step at a time: earlier flows' edits stay in the undo stack).
  const showsMark = () => page.evaluate((id: string) => !!document.querySelector(`.editor-area .eg-group[data-group-id="${id}"] .view-lines`)?.textContent?.includes('split-sync'), withInv[1].id)
  for (let i = 0; i < 20 && (await showsMark()); i++) {
    await page.keyboard.press(`${mod}+Z`)
    await page.waitForTimeout(50)
  }
  check(!(await showsMark()), 'undo in one group did not reach the other group')
  // Autosave (left on by earlier flows) may have written the typing: save the undone text back.
  await page.keyboard.press(`${mod}+S`)
  await bottom.locator('.crumbs').getByText('Saved', { exact: true }).waitFor({ timeout: 5000 })

  // 4. Ctrl+1 focuses the first group (reading order).
  await page.keyboard.press(`${mod}+1`)
  await page.waitForFunction(() => {
    const gs = [...document.querySelectorAll<HTMLElement>('.editor-area .eg-group')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    return gs[0]?.classList.contains('active')
  }, undefined, { timeout: 3000 })

  // 5. Drag the vertical sash 120px to the right: the left column widens.
  const before = (await groupsInOrder(page))[0].width
  const sash = (await page.locator(`${CENTER} .eg-sash.row`).first().boundingBox())!
  await page.mouse.move(sash.x + sash.width / 2, sash.y + 40)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(sash.x + sash.width / 2 + i * 20, sash.y + 40)
  await page.mouse.up()
  const after = (await groupsInOrder(page))[0].width
  check(after > before + 60, `sash drag did not resize the groups (${before}px -> ${after}px)`)

  // 6. The layout is in the session file for this project.
  let saved = 0
  for (let i = 0; i < 30 && saved !== 3; i++) {
    await page.waitForTimeout(200)
    saved = await page.evaluate(async (r: string) => {
      const s = await window.harness.qolLoadSession()
      return s.projects[r]?.groups?.groups.length ?? 0
    }, root)
  }
  check(saved === 3, `session file has ${saved} editor groups for the project, expected 3`)
  await shot('three-groups')
  note('3 groups saved to the session')

  // 7. Join all groups from the palette: one group with every tab.
  await joinAll(page)
  groups = await groupsInOrder(page)
  check(groups[0].tabs.includes('PlayerData') && groups[0].tabs.includes('InventoryService'), `join lost tabs: ${JSON.stringify(groups)}`)
}
