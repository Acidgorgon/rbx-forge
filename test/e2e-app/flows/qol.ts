// v06 additions: Forge Doctor, bug report, Add to game, Thumbnail Lab, UI Motion Lab, chat modes,
// slash commands, spend cap. qolFlows run with no provider; providerQolFlows after 'fake-provider'.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WRITE_MARKER } from '../lib/fakeProvider.ts'
import { INVENTORY_SERVICE } from '../lib/project.ts'
import { check, CENTER, closeBottom, dismissDigest, dismissToasts, horizontalOverflow, mod, openPage, setTheme, SkipFlow, waitText } from '../lib/ui.ts'
import { setWindowSize } from '../lib/app.ts'
import type { Page } from '../lib/app.ts'
import type { Flow } from './types.ts'
import type { UiMotionEntry } from '../../../src/shared/uiMotionTypes.ts'

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
      // The page's own heading (the tab label alone also says "Thumbnail").
      await page.locator(`${CENTER} h1`, { hasText: 'Thumbnail Lab' }).first().waitFor({ state: 'visible', timeout: 10_000 })
      await shot('page')
    }
  },
  {
    name: 'thumbnail-lab-ui-art',
    title: 'Thumbnail Lab UI art: switch mode, build a button prompt, edit a section, no-backend message',
    async run({ page, shot, note }) {
      await openPage(page, 'Thumbnail Lab')
      const lab = page.locator(`${CENTER} .page-inner.th`).first()
      await lab.waitFor({ state: 'visible', timeout: 10_000 })
      await lab.locator('.th-mode').getByRole('tab', { name: /UI art/ }).click()
      const make = lab.locator('.th-ui-make')
      await make.waitFor({ state: 'visible', timeout: 10_000 })
      await make.locator('.th-kinds').getByRole('radio', { name: 'Button' }).click()
      await make.getByLabel('UI asset to make').fill('a green BUY button, glossy simulator style')
      // Build: rules only, no model, works with no backend.
      await make.getByRole('button', { name: /^Build$/ }).click()
      const sections = make.locator('.th-section')
      await sections.first().waitFor({ state: 'visible', timeout: 10_000 })
      check((await sections.count()) >= 5, `only ${await sections.count()} prompt sections`)
      const subject = make.getByLabel('Subject section')
      check(/button/i.test(await subject.inputValue()), 'the subject section does not describe the button')
      // The ALL-CAPS label gets the "quote it" note (no text drawn by default).
      check(/"BUY"/.test(await make.locator('.th-builder-notes').innerText()), 'no note about quoting the BUY label')
      // Editing a section marks it as yours and the preview follows.
      await subject.fill('a chunky green BUY button with a coin icon')
      await make.locator('.th-section.src-user').first().waitFor({ state: 'visible', timeout: 5000 })
      check(/with your edits/.test(await make.locator('.th-builder-state').innerText()), 'the builder does not say it will send your edits')
      check((await make.locator('.th-prompt').textContent())?.includes('chunky green BUY button') ?? false, 'the "as sent" preview did not follow the edit')
      const status = await page.evaluate(() => window.harness.thumbStatus())
      if (!status.openaiKey && !status.codex) {
        check(await lab.locator('.callout', { hasText: /No image backend/ }).count(), 'no "No image backend" message')
        check(await make.locator('form .btn.primary').isDisabled(), 'Make is enabled with no image backend')
        note('no backend: message shown, Make disabled, builder works')
      }
      await shot('builder')
      await lab.locator('.vfx-view').getByRole('tab', { name: /^kit/ }).click()
      await lab.locator('.empty', { hasText: /No UI kit yet/ }).or(lab.locator('.th-kit')).first().waitFor({ state: 'visible', timeout: 5000 })
      const o = await horizontalOverflow(page)
      check(o.doc <= o.win + 1 && !o.offenders.length, `the UI art view overflows: ${o.offenders.slice(0, 3).join(', ')}`)
      // Leave the lab in thumbnail mode for later flows.
      await lab.locator('.th-mode').getByRole('tab', { name: /thumbnails/ }).click()
      await lab.locator('.th-ui-make').waitFor({ state: 'detached', timeout: 5000 })
    }
  },
  {
    name: 'ui-motion-lab',
    title: 'UI Motion Lab renders',
    async run({ page, shot }) {
      await openPage(page, 'UI Motion Lab')
      await page.locator(`${CENTER} h1`, { hasText: 'UI Motion Lab' }).first().waitFor({ state: 'visible', timeout: 10_000 })
      await shot('page')
    }
  },
  {
    name: 'ui-motion-story',
    title: 'UI Motion Lab from a story: RacingHud, pick BOOST, Bouncy preset, hover it, export the snippet',
    timeoutMs: 120_000,
    async run({ app, page, root, shot, note }) {
      const RACING = 'src/shared/Interface/Stories/RacingHud.story.luau'
      const before = readFileSync(join(root, RACING), 'utf8')
      await dismissToasts(page)
      await openPage(page, 'UI Motion Lab')
      await closeBottom(page)
      const lab = page.locator(`${CENTER} .uimotion`).first()
      await lab.waitFor({ state: 'visible', timeout: 10_000 })
      // No Figma imports in this project: the stage offers both sources.
      const choice = lab.locator('.um-choice')
      await choice.waitFor({ state: 'visible', timeout: 10_000 })
      check(/Import from Figma/.test(await choice.innerText()) && /From a story/.test(await choice.innerText()), 'the empty stage does not offer both sources')
      await shot('empty')
      await choice.getByRole('button', { name: /From a story/ }).click()
      const item = choice.locator('.um-story-item', { hasText: 'RacingHud' }).first()
      await item.waitFor({ state: 'visible', timeout: 30_000 })
      const status = await page.evaluate(() => window.harness.uiMotionStatus())
      if (!status.lune) {
        check(await page.locator(`${CENTER} .callout`, { hasText: /Lune not found/ }).count(), 'no Lune message on the lab')
        throw new SkipFlow('Lune not available (set LUNE_PATH)')
      }
      await item.click()
      // The rendered story's buttons arrive in the element list.
      const element = lab.getByLabel('Element')
      await page.waitForFunction(() => [...document.querySelectorAll('.editor-area select[aria-label="Element"] option')].some((o) => /RacingHud > BOOSTButton/.test(o.textContent ?? '')), undefined, { timeout: 45_000 })
      // Select mode: clicking the BOOST label picks its button.
      await lab.locator('.um-seg button', { hasText: 'select' }).click()
      const label = lab.locator('.um-stage .uip-node', { hasText: /^BOOST$/ }).last()
      await label.click()
      await page.waitForFunction(() => /RacingHud > BOOSTButton/.test(document.querySelector('.editor-area .um-story-line')?.textContent ?? ''), undefined, { timeout: 10_000 }).catch(async () => {
        throw new Error(`select mode did not pick BOOSTButton (element: ${await element.inputValue()})`)
      })
      check((await element.inputValue()) === 'RacingHud.BOOSTButton', `element is ${await element.inputValue()}`)
      // Bouncy preset on the picked button.
      const n0 = (await page.evaluate(() => window.harness.uiMotionList())).length
      await lab.locator('.vfx-examples button', { hasText: 'Bouncy' }).first().click()
      await page.waitForFunction((n: number) => window.harness.uiMotionList().then((l: UiMotionEntry[]) => l.length > n), n0, { timeout: 10_000 })
      const list: UiMotionEntry[] = await page.evaluate(() => window.harness.uiMotionList())
      const entry = list.find((e) => e.story === 'src/shared/Interface/Stories/RacingHud.story.luau')
      check(entry, 'the Bouncy stack was not saved with the story source')
      check(entry.spec.targets.some((t) => t.path === 'RacingHud.BOOSTButton' && t.effects.some((e) => e.kind === 'hover')), `stack targets: ${JSON.stringify(entry.spec.targets.map((t) => t.path))}`)
      // Hover it in interact mode: the runtime's UIScale on BOOSTButton springs above 1.
      await lab.locator('.um-seg button', { hasText: 'interact' }).click()
      const scaleOf = () =>
        page.evaluate(() =>
          window.harness.uiPreviewState().then((st) => {
            const nodes = st?.tree.nodes ?? []
            const s = nodes.find((n) => n.name === 'ForgeMotionScale' && nodes.find((p) => p.id === n.parent)?.name === 'BOOSTButton')
            return s ? Number(s.props.Scale) : null
          })
        )
      // Wait for the Bouncy stack itself: before the lab story picks up the new Spec1 control it still
      // runs the previous draft (the Scratch stack sits on the slot), so "any ForgeMotionScale" is
      // not enough.
      let rest: number | null = null
      for (let i = 0; i < 100 && rest == null; i++) {
        rest = await scaleOf()
        if (rest == null) await page.waitForTimeout(200)
      }
      if (rest == null) {
        const where = await page.evaluate(() =>
          window.harness.uiPreviewState().then((st) => {
            const nodes = st?.tree.nodes ?? []
            return `${st?.file} ${st?.status}; scales under: ${nodes.filter((n) => n.name === 'ForgeMotionScale').map((n) => nodes.find((p) => p.id === n.parent)?.name).join(', ') || 'none'}; buttons: ${nodes.filter((n) => n.name === 'BOOSTButton').length}`
          })
        )
        throw new Error(`no ForgeMotionScale under BOOSTButton: the stack did not attach to the live instance (${where})`)
      }
      const btn = lab.locator('.um-stage .uip-node.uip-btn', { has: page.locator('.uip-node', { hasText: /^BOOST$/ }) }).last()
      await btn.hover()
      let hovered = rest!
      for (let i = 0; i < 30 && hovered < 1.02; i++) {
        await page.mouse.move(...(await btn.boundingBox().then((b: { x: number; y: number; width: number; height: number } | null) => [b!.x + b!.width * 0.5 + (i % 2), b!.y + b!.height * 0.5] as [number, number])))
        await page.waitForTimeout(100)
        hovered = (await scaleOf()) ?? hovered
      }
      check(hovered > 1.02, `hovering BOOST did not scale it up (UIScale ${rest} -> ${hovered})`)
      note(`BOOSTButton UIScale ${rest} -> ${hovered.toFixed(3)} on hover`)
      await page.waitForTimeout(250)
      await shot('hover')
      // Export: the module only, plus the two lines for the user's own component.
      await lab.getByRole('button', { name: /^\s*Export$/ }).first().click()
      const snippet = lab.locator('pre[aria-label="Lines to add"]')
      await snippet.waitFor({ state: 'visible', timeout: 15_000 })
      const text = await snippet.innerText()
      check(/^local Effects = require\(game:GetService\("ReplicatedStorage"\)\..*Effects\)\nEffects\.attach\(boostButton\) -- RacingHud > BOOSTButton$/.test(text.trim()), `snippet: ${text}`)
      check(await lab.getByRole('button', { name: /Show in UI Preview/ }).count(), 'no "Show in UI Preview" button')
      const after: UiMotionEntry[] = await page.evaluate(() => window.harness.uiMotionList())
      const module = after.find((e) => e.id === entry.id)?.written?.module
      check(module && existsSync(join(root, module)), `module not written: ${module}`)
      check(readFileSync(join(root, RACING), 'utf8') === before, 'the export changed the user\'s story')
      note(text.trim().replace(/\n/g, ' | ').slice(0, 200))
      await shot('export')
      // Light theme and a 900px window: the story source comes back (remembered), nothing overflows.
      await setWindowSize(app, 900, 800)
      try {
        await page.waitForFunction(() => window.innerWidth <= 900, undefined, { timeout: 5000 })
        await openPage(page, 'Settings')
        await setTheme(page, 'Light')
        await openPage(page, 'UI Motion Lab')
        await page.locator(`${CENTER} .um-story-line`, { hasText: 'RacingHud.story.luau' }).waitFor({ state: 'visible', timeout: 30_000 })
        await page.waitForFunction(() => window.harness.uiPreviewState().then((st) => !!st?.tree.nodes.some((n) => n.name === 'BOOSTButton')), undefined, { timeout: 30_000 })
        await page.waitForTimeout(400)
        const o = await horizontalOverflow(page)
        await shot('light-900')
        check(o.doc <= o.win + 1 && !o.offenders.length, `overflow at 900px: page ${o.doc}px > ${o.win}px; ${o.offenders.slice(0, 3).join(', ')}`)
      } finally {
        await openPage(page, 'Settings')
        await setTheme(page, 'Dark')
        await setWindowSize(app, 1400, 900)
      }
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
      // Open Hollow Purple itself, whatever is open. Earlier flows leave another effect open: after
      // vfx-studio-import trashes the effect it made, studio-check opens the first card, which is the
      // "Jab" labs-make-no-key made with Ability Composer, already in the project (no new files).
      const card = page.locator(`${CENTER} .vfx-card`, { hasText: /HollowPurple|Hollow Purple/ }).first()
      if (!(await card.evaluate((el: Element) => el.classList.contains('on')))) await card.click()
      await page.locator(`${CENTER} .vfx-card.on`, { hasText: /HollowPurple|Hollow Purple/ }).waitFor({ timeout: 10_000 })
      await detail.waitFor({ state: 'visible', timeout: 10_000 })
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
      const heading = (await a2g.innerText()).split('\n')[0]
      check(/HollowPurple|Hollow Purple/.test(heading), `Add to game opened for another effect: "${heading}"`)
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
      // The refused call is folded into one activity line (Thread.tsx), not a row per call.
      check((await page.locator(`${ASSISTANT} .ta-head`).count()) > 0, 'the tool call is not shown as a folded activity line')
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

// Last: the app again without WebGL. Each 3D preview must say so in place (not only in the console).
export const webglOffFlows: Flow[] = [
  {
    name: 'webgl-off',
    title: 'Without WebGL, the VFX / Animation / Ability / Model Lab previews show "3D preview needs WebGL"',
    timeoutMs: 120_000,
    // three.js logs the failed context itself; the in-preview message is what this flow checks.
    allowErrors: [/WebGL|THREE\.WebGLRenderer|webgl/i],
    async run({ relaunch, note }) {
      const { page } = await relaunch({ webgl: false })
      await page.locator('nav.activity').waitFor({ state: 'visible', timeout: 30_000 })
      check(!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))), 'WebGL is still available with --disable-3d-apis')
      await dismissDigest(page, 4000)
      const seen: string[] = []
      for (const [label, example, detail] of [
        ['VFX Lab', 'Hollow Purple', '.vfx-detail'],
        ['Animation Lab', 'Dash punch', '.vfx-detail'],
        ['Ability Composer', 'Hollow Purple', '.ab-detail']
      ] as const) {
        await openPage(page, label)
        await page.locator(`${CENTER} .vfx-examples button, ${CENTER} button.badge-o`, { hasText: example }).first().click()
        const msg = page.locator(`${CENTER} ${detail} .vfx-canvas-err`).first()
        await msg.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {
          throw new Error(`${label}: no in-preview WebGL message`)
        })
        const text = (await msg.innerText()).replace(/\s+/g, ' ')
        check(/3D preview needs WebGL/.test(text), `${label}: preview message is "${text.slice(0, 120)}"`)
        seen.push(`${label}: ${text.slice(0, 70)}`)
      }
      // Model Lab: a model from the template opens its (WebGL-less) preview.
      await openPage(page, 'Model Lab')
      await page.locator(`${CENTER} [data-testid="model-from-template"]`).click()
      const modelMsg = page.locator(`${CENTER} [data-testid="model-detail"] .vfx-canvas-err`).first()
      await modelMsg.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
        throw new Error('Model Lab: no in-preview WebGL message')
      })
      const modelText = (await modelMsg.innerText()).replace(/\s+/g, ' ')
      check(/3D preview needs WebGL/.test(modelText), `Model Lab: preview message is "${modelText.slice(0, 120)}"`)
      seen.push(`Model Lab: ${modelText.slice(0, 70)}`)
      note(seen.join(' | '))
    }
  }
]
