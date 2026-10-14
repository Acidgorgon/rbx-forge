// UI Motion Lab service against a temp copy of the UI Preview fixture project: Figma import (plugin
// JSON, and a link through a fake fetch with the token from a fake secret store), the files it
// writes and where (storybook folder, project-file mapping), the library, compose / critique with a
// fake model, ratings into memory + principle feedback, export, and the generated story + lab story
// running in Lune through the UI Preview service (hover / click drive the effects; skipped without
// Lune).
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { UiMotionService, FIGMA_TOKEN_KEY } from '../src/main/services/uimotion/service.ts'
import { planLayout } from '../src/main/services/uimotion/layout.ts'
import type { FetchLike } from '../src/shared/uimotion/figma/rest.ts'
import { labSpecJson } from '../src/shared/uimotion/compile.ts'
import { presetSpec } from '../src/shared/uimotion/spec.ts'
import { absoluteRequire } from '../src/shared/uimotion/codegen.ts'
import { findLune } from '../src/main/services/tests/index.ts'
import { UiPreviewService } from '../src/main/services/uiPreview/service.ts'

const FIX = resolve(import.meta.dirname, 'fixtures')
const nodes = JSON.parse(readFileSync(join(FIX, 'figma', 'play-button.nodes.json'), 'utf8'))
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex')

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uim-svc-'))
  cpSync(join(FIX, 'ui-preview-project'), root, { recursive: true })
  return root
}

function secrets() {
  const m = new Map<string, string>()
  return { get: async (k: string) => m.get(k), set: async (k: string, v: string) => void m.set(k, v), delete: async (k: string) => void m.delete(k), map: m }
}

function make(root: string, extra: Partial<ConstructorParameters<typeof UiMotionService>[0]> = {}) {
  const userDir = mkdtempSync(join(tmpdir(), 'uim-user-'))
  return new UiMotionService({ userDir, projectRoot: () => root, projectFile: () => 'default.project.json', now: () => 1_700_000_000_000, ...extra })
}

const pluginDoc = JSON.stringify({ format: 'forge-figma', version: 1, source: { kind: 'plugin', fileName: 'Shop UI', nodeId: '12:34', nodeName: 'Play Button' }, root: nodes.nodes['12:34'].document, images: { 'node:12:35': PNG.toString('base64') } })

test('layout follows the existing storybook folder (Stories/ + Components/ + Motion/)', async () => {
  const root = project()
  const l = await planLayout(root)
  assert.equal(l.storybook, 'src/shared/Interface/Stories/Stories.storybook.luau')
  assert.equal(l.components, 'src/shared/Interface/Components')
  assert.equal(l.motion, 'src/shared/Interface/Motion')
  assert.equal(l.storybookExists, true)
  rmSync(join(root, 'src'), { recursive: true })
  const d = await planLayout(root)
  assert.equal(d.uiDir, 'src/shared/Interface')
  assert.equal(d.storybookExists, false)
})

test('import a plugin selection: component, story, PNGs and the component index', async () => {
  const root = project()
  const s = make(root)
  const r = await s.importFigmaDoc(pluginDoc)
  assert.equal(r.component.name, 'PlayButton')
  assert.deepEqual(r.files.sort(), ['art/ui/PlayButton/icon.png', 'src/shared/Interface/Components/PlayButton.luau', 'src/shared/Interface/Stories/PlayButton.story.luau'])
  assert.deepEqual(readFileSync(join(root, 'art/ui/PlayButton/icon.png')), PNG)
  assert.deepEqual(r.component.instance, ['ReplicatedStorage', 'Shared', 'Interface', 'Components', 'PlayButton'])
  const story = readFileSync(join(root, 'src/shared/Interface/Stories/PlayButton.story.luau'), 'utf8')
  assert.match(story, /require\(script\.Parent\.Parent\.Components\.PlayButton\)/)
  assert.match(readFileSync(join(root, r.component.module), 'utf8'), /dropped background blur/)
  assert.ok(r.component.elements.some((e) => e.path === 'Body.Flow.Label' && e.className === 'TextLabel'))
  assert.ok(!r.component.elements.some((e) => /UICorner/.test(e.className)))
  assert.deepEqual((await s.components()).map((c) => c.name), ['PlayButton'])
  assert.deepEqual(r.warnings, [])
  // A plugin doc without the PNG: the import still works and says so.
  const r2 = await s.importFigmaDoc(pluginDoc.replace(/"images":\{[^}]*\}/, '"images":{}'), { name: 'Play Two' })
  assert.equal(r2.component.name, 'PlayTwo')
  assert.match(r2.warnings.join('\n'), /image for "Icon" was not exported/)
})

test('import a Figma link: REST nodes + renders through fetch, token from the secret store only', async () => {
  const root = project()
  const sec = secrets()
  const urls: string[] = []
  const tokens: (string | undefined)[] = []
  const fetch: FetchLike = async (url, init) => {
    urls.push(url)
    tokens.push(init?.headers?.['X-Figma-Token'])
    const body = url.includes('/nodes?') ? nodes : url.includes('/v1/images/') ? { err: null, images: { '12:35': 'https://figma-alpha.s3.example/icon.png' } } : url.includes('/v1/me') ? { handle: 'acid' } : null
    const bytes = url.startsWith('https://figma-alpha') ? PNG : null
    return { ok: !!(body || bytes), status: body || bytes ? 200 : 404, headers: { get: () => null }, json: async () => body, text: async () => '', arrayBuffer: async () => (bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) : new ArrayBuffer(0)) }
  }
  const s = make(root, { secrets: sec, fetch })
  await assert.rejects(s.importFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Shop?node-id=12-34'), /No Figma token/)
  await assert.rejects(s.setToken('short'), /does not look like/)
  const st = await s.setToken('FAKE-test-token-not-a-secret-000')
  assert.deepEqual(st, { set: true, canStore: true })
  assert.equal(JSON.stringify(st).includes('figd_'), false, 'status never carries the token')
  assert.equal(sec.map.get(FIGMA_TOKEN_KEY), 'FAKE-test-token-not-a-secret-000')
  await assert.rejects(s.importFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Shop'), /no node-id/)
  const r = await s.importFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Shop?node-id=12-34', { name: 'LinkButton' })
  assert.equal(r.component.source, 'figma-link')
  assert.deepEqual(readFileSync(join(root, 'art/ui/LinkButton/icon.png')), PNG)
  assert.ok(urls.some((u) => u === 'https://api.figma.com/v1/files/AbCdEf1234567890/nodes?ids=12:34'))
  assert.ok(urls.some((u) => u.startsWith('https://api.figma.com/v1/images/AbCdEf1234567890?ids=12:35&format=png&scale=2')))
  assert.ok(!urls.some((u) => u.endsWith('/images')), 'no image-fill call when the node has no image fills')
  assert.deepEqual([...new Set(tokens.filter(Boolean))], ['FAKE-test-token-not-a-secret-000'])
  assert.equal((await s.testToken()).ok, true)
  await s.clearToken()
  assert.equal((await s.tokenStatus()).set, false)
})

test('library, compose (fake model, restated), critique with frames, rate, export', async () => {
  const root = project()
  const memory: { name: string; kind?: string; type?: string }[] = []
  const feedback: { lab: string; rating: string; scores: Record<string, number> }[] = []
  const prompts: { system: string; prompt: string; images: number }[] = []
  const s = make(root, {
    memory: { remember: async (m) => (memory.push(m), { entry: { name: m.name } }) },
    principles: { weights: async () => ({ 'ui-overshoot': 1.4 }), record: async (f) => void feedback.push(f) },
    model: (tier) => async (system, prompt, images) => {
      prompts.push({ system: `${tier}:${system.slice(0, 30)}`, prompt, images: images.length })
      if (tier === 'default') return '{"name":"PlayPop","targets":[{"path":"","effects":[{"kind":"hover","scale":1.06,"frequency":5,"damping":0.7},{"kind":"press","scale":0.93},{"kind":"pop","amount":0.12,"damping":0.3}]},{"path":"Body.Flow.Label","effects":[{"kind":"shine","trigger":"hover"}]}],"notes":"bouncy but quick","plan":{"ui-responsiveness":"hover half in 60 ms"}}'
      return '{"overall":6.8,"summary":"Pop rings too long.","scores":{"feedback":8,"feel":7,"restraint":5,"polish":7},"changes":[{"path":"","kind":"pop","field":"damping","value":0.6,"principle":"ui-overshoot","why":"one bounce"}],"principles":[{"id":"ui-overshoot","score":4.5,"note":"rings for 0.6 s","fix":"damping 0.6"}]}'
    }
  })
  await s.importFigmaDoc(pluginDoc)
  const c = await s.compose('playful play button that pops', { component: 'PlayButton', restatement: { goal: 'A play button that pops on click', problem: 'clicks feel dead', assumptions: [] } })
  assert.equal(c.source, 'model')
  assert.equal(c.entry.name, 'PlayPop')
  assert.equal(c.entry.scope, 'project')
  assert.equal(c.entry.component, 'PlayButton')
  assert.equal(c.entry.spec.targets.length, 2)
  assert.match(c.notes.join(' '), /plan: ui-responsiveness/)
  assert.match(prompts[0].prompt, /confirmed this reading/)
  assert.match(prompts[0].prompt, /"Body\.Flow\.Label": TextLabel/)
  assert.ok(existsSync(join(root, '.forge/uimotion/library', c.entry.id, 'entry.json')))
  const frame = `data:image/png;base64,${PNG.toString('base64')}`
  const cr = await s.critique(c.entry.id, { frames: [frame, frame], labels: ['rest', 'hover'], apply: true })
  assert.equal(prompts[1].images, 2)
  assert.match(prompts[1].prompt, /Frames, in order: rest, hover/)
  assert.match(prompts[1].prompt, /ui-overshoot \[user weight x1\.4\]/)
  assert.equal(cr.critique.vision?.overall, 6.8)
  assert.deepEqual(cr.applied, ['root.pop.damping'])
  assert.equal((cr.entry.spec.targets[0].effects.find((e) => e.kind === 'pop') as { damping: number }).damping, 0.6)
  assert.equal(cr.critique.principles?.find((p) => p.id === 'ui-overshoot')?.source, 'both')
  assert.deepEqual(cr.critique.frames, ['frames/critique-1.png', 'frames/critique-2.png'])
  const rated = await s.rate(c.entry.id, 'up')
  assert.equal(rated.quality, 'good')
  assert.ok(memory.some((m) => m.kind === 'skill' && m.name.startsWith('ui-motion-example-PlayPop')))
  assert.equal(feedback[0].lab, 'uimotion')
  assert.ok(Object.keys(feedback[0].scores).every((k) => k.startsWith('ui-')))
  const ex = await s.export(c.entry.id)
  assert.deepEqual(ex.files, ['src/shared/Interface/Motion/PlayPopEffects.luau', 'src/shared/Interface/Stories/PlayButtonPlayPop.story.luau'])
  assert.equal(ex.requirePath, 'game:GetService("ReplicatedStorage").Shared.Interface.Motion.PlayPopEffects')
  assert.deepEqual(ex.warnings, [])
  const story = readFileSync(join(root, ex.story!), 'utf8')
  assert.match(story, /require\(script\.Parent\.Parent\.Components\.PlayButton\)/)
  assert.match(story, /require\(script\.Parent\.Parent\.Motion\.PlayPopEffects\)/)
  assert.equal((await s.get(c.entry.id)).written?.module, ex.module)
  // No model: compose still gives a starting stack from the presets.
  const plain = make(root)
  const h = await plain.compose('juicy shop buy button')
  assert.equal(h.source, 'heuristic')
  assert.ok(h.entry.spec.targets[0].effects.some((e) => e.kind === 'shine'))
})

const lune = findLune(process.env.LUNE_PATH || null)
test('generated story and the 3-slot lab story run in Lune; hover and click drive the effects', { skip: lune ? false : 'lune not found (set LUNE_PATH)', timeout: 120_000 }, async () => {
  const root = project()
  const s = make(root)
  const imp = await s.importFigmaDoc(pluginDoc)
  const e = await s.save(presetSpec('juicy', '', 'Juicy'), { component: 'PlayButton' })
  const ex = await s.export(e.id)
  const preview = new UiPreviewService({ lunePath: () => lune, projectFile: () => 'default.project.json' })
  preview.setRoot(root)
  const r = await preview.render({ file: ex.story!, width: 800, height: 600, clicks: ['PlayButton'] })
  assert.equal(r.error ?? null, null, JSON.stringify(r.console))
  const names = r.tree.nodes.map((n) => n.name)
  for (const n of ['ForgeMotionScale', 'ForgeMotionShine', 'ForgeMotionRipple']) assert.ok(names.includes(n), `${n} in ${names.join(',')}`)
  const lab = await s.labStory({ kind: 'component', require: absoluteRequire(imp.component.instance!), name: 'PlayButton' })
  assert.equal(lab.file, '.forge/uimotion/lab/PlayButton.story.luau')
  assert.equal(readFileSync(join(root, '.forge/uimotion/lab/.gitignore'), 'utf8'), '*\n')
  await assert.rejects(s.labStory({ kind: 'component', require: 'os.exit()', name: 'X' }), /not mapped/)
  const l = await preview.render({ file: lab.file, width: 1200, height: 400, controls: { Slots: 3, Spec1: labSpecJson(presetSpec('bouncy')), Spec2: labSpecJson(presetSpec('snappy')), Spec3: labSpecJson(presetSpec('juicy')), Label1: 'Bouncy', Label2: 'Snappy', Label3: 'Juicy' }, clicks: ['PlayButton'] })
  assert.equal(l.error ?? null, null, JSON.stringify(l.console))
  const slots = l.tree.nodes.filter((n) => /^Slot\d$/.test(n.name))
  assert.equal(slots.length, 3)
  assert.deepEqual(l.tree.nodes.filter((n) => n.name === 'ForgeMotionLabel').map((n) => n.props.Text), ['Bouncy', 'Snappy', 'Juicy'])
  assert.equal(l.tree.nodes.filter((n) => n.name === 'ForgeMotionScale').length, 3)
  // The click left at least one slot's UIScale off rest (springs still moving).
  assert.ok(l.tree.nodes.some((n) => n.name === 'ForgeMotionScale' && Math.abs(Number(n.props.Scale) - 1) > 1e-4), JSON.stringify(l.tree.nodes.filter((n) => n.name === 'ForgeMotionScale').map((n) => n.props.Scale)))
})
