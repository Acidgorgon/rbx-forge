// UI Motion Lab, pure parts: the spring solver (closed form, frame-rate independent, the Luau mirror
// agrees through Lune when it is there), the effect engine and timeline, the UI principle checks,
// the AI answer parsing / change application, and the Luau codegen (snapshot + luau-compile /
// luau-lsp when available: $LUAU_COMPILE / $LUAU_LSP + $ROBLOX_DEFS, else on PATH).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { riseTime, settleTime, springOvershoot, stepResponse, stepSpring, SPRING_LUAU } from '../src/shared/uimotion/spring.ts'
import { MOTION_PRESETS, normalizeEffect, normalizeSpec, presetSpec, luauName, describeSpec } from '../src/shared/uimotion/spec.ts'
import { defaultScript, MotionEngine, overshootAfter, responseTime, simulate } from '../src/shared/uimotion/engine.ts'
import { compileMotionModule, labStoryLuau, selectBlocks } from '../src/shared/uimotion/compile.ts'
import { componentModule, requireBetween, storyModule } from '../src/shared/uimotion/codegen.ts'
import { mapFigmaNode } from '../src/shared/uimotion/figma/map.ts'
import { applyChanges, heuristicStack, parseComposeAnswer, parseCritique } from '../src/shared/uimotion/ai.ts'
import { buildCritique } from '../src/shared/uimotion/critique.ts'
import { uiPrincipleChecks } from '../src/shared/principles/uiChecks.ts'
import { principlesFor } from '../src/shared/principles/catalog.ts'
import { principlePlan, selectPrinciples } from '../src/shared/principles/select.ts'
import { findLune } from '../src/main/services/tests/index.ts'

const FIX = resolve(import.meta.dirname, 'fixtures')

// ---------------------------------------------------------------- spring

function run(f: number, z: number, dt: number, T: number): number[] {
  let s = { x: 0, v: 0 }
  const out: number[] = []
  for (let t = 0; t < T - 1e-9; t += dt) {
    s = stepSpring(s, 1, { frequency: f, damping: z }, dt)
    out.push(s.x)
  }
  return out
}

test('spring: under-damped overshoot matches exp(-z pi / sqrt(1 - z^2))', () => {
  for (const z of [0.2, 0.35, 0.5, 0.7]) {
    const peak = Math.max(...run(3, z, 1 / 1000, 2))
    assert.ok(Math.abs(peak - 1 - springOvershoot(z)) < 0.002, `z=${z}: peak ${peak} vs ${1 + springOvershoot(z)}`)
  }
  assert.equal(springOvershoot(1), 0)
  assert.equal(springOvershoot(1.4), 0)
})

test('spring: critical and over-damped never overshoot and settle', () => {
  for (const z of [1, 1.00005, 1.5, 2]) {
    const xs = run(4, z, 1 / 240, 3)
    assert.ok(Math.max(...xs) <= 1 + 1e-9, `z=${z} overshoots`)
    assert.ok(Math.abs(xs[xs.length - 1] - 1) < 0.01, `z=${z} did not settle: ${xs[xs.length - 1]}`)
  }
})

test('spring: closed form is frame-rate independent (30, 60, 144, 240 fps and one big step)', () => {
  const p = { frequency: 4, damping: 0.45 }
  const at = (dt: number, T: number) => {
    let s = { x: 0.2, v: -3 }
    const n = Math.round(T / dt)
    for (let i = 0; i < n; i++) s = stepSpring(s, 1, p, dt)
    return s
  }
  const ref = at(1 / 240, 0.5)
  for (const fps of [30, 60, 144]) {
    const s = at(1 / fps, 0.5)
    assert.ok(Math.abs(s.x - ref.x) < 1e-9 && Math.abs(s.v - ref.v) < 1e-7, `${fps} fps: ${s.x} vs ${ref.x}`)
  }
  const big = stepSpring({ x: 0.2, v: -3 }, 1, p, 0.5)
  assert.ok(Math.abs(big.x - ref.x) < 1e-9)
  // Velocity is the derivative of position (finite difference).
  const h = 1e-5
  const a = stepSpring({ x: 0, v: 0 }, 1, p, 0.1 - h)
  const b = stepSpring({ x: 0, v: 0 }, 1, p, 0.1 + h)
  const mid = stepSpring({ x: 0, v: 0 }, 1, p, 0.1)
  assert.ok(Math.abs((b.x - a.x) / (2 * h) - mid.v) < 1e-4)
})

test('spring: higher frequency responds faster; rise / settle helpers agree with the step response', () => {
  assert.ok(riseTime({ frequency: 8, damping: 0.7 }) < riseTime({ frequency: 3, damping: 0.7 }))
  const r = stepResponse({ frequency: 4, damping: 1 }, 1, 1 / 600)
  const half = riseTime({ frequency: 4, damping: 1 })
  assert.ok(Math.abs(r[Math.round(half * 600) - 1] - 0.5) < 0.02)
  assert.ok(settleTime({ frequency: 4, damping: 0.3 }) > settleTime({ frequency: 4, damping: 0.9 }))
})

const lune = findLune(process.env.LUNE_PATH || null)
test('spring: the Luau mirror matches the TS solver (Lune)', { skip: lune ? false : 'lune not found (set LUNE_PATH)' }, () => {
  const cases: [number, number, number, number, number, number][] = [
    [0, 0, 1, 4, 0.3, 1 / 60],
    [0.4, 2, 1, 6, 1, 1 / 30],
    [1.2, -5, 0.9, 2.5, 1.6, 0.25],
    [0, 0, 1, 9, 0.7, 1 / 240]
  ]
  const dir = mkdtempSync(join(tmpdir(), 'uim-spring-'))
  const file = join(dir, 'spring.luau')
  writeFileSync(file, `${SPRING_LUAU.replace(/: \(number, number\)/, '').replace(/(\w+): number/g, '$1')}\n${cases.map((c) => `print(string.format("%.12f %.12f", stepSpring(${c.join(', ')})))`).join('\n')}\n`)
  const out = execFileSync(lune!, ['run', file], { encoding: 'utf8' }).trim().split('\n')
  cases.forEach(([x, v, g, f, z, dt], i) => {
    const s = stepSpring({ x, v }, g, { frequency: f, damping: z }, dt)
    const [lx, lv] = out[i].split(' ').map(Number)
    assert.ok(Math.abs(lx - s.x) < 1e-9 && Math.abs(lv - s.v) < 1e-7, `case ${i}: lune ${out[i]} vs ${s.x} ${s.v}`)
  })
})

// ---------------------------------------------------------------- spec + engine

test('spec: normalisation clamps, snaps, keeps one effect per kind and accepts 0..255 / hex colours', () => {
  const s = normalizeSpec({ name: 'shop button!', targets: [{ path: '', effects: [{ kind: 'hover', scale: 9, frequency: 4.04 }, { kind: 'glow', color: [255, 128, 0] }, { kind: 'hover', scale: 1.1 }, { kind: 'nope' }] }, { path: 'Label', effects: [{ kind: 'shine', color: '#ff0000', trigger: 'sideways' }] }, { path: '..bad', effects: [{ kind: 'pop' }] }] })
  assert.equal(s.name, 'ShopButton')
  assert.equal(s.targets.length, 2)
  const root = s.targets[0].effects
  assert.equal(root.filter((e) => e.kind === 'hover').length, 1)
  assert.equal((root.find((e) => e.kind === 'hover') as { scale: number }).scale, 1.1)
  assert.deepEqual((root.find((e) => e.kind === 'glow') as { color: number[] }).color.map((c) => Math.round(c * 255)), [255, 128, 0])
  const shine = s.targets[1].effects[0] as { trigger: string; color: number[] }
  assert.equal(shine.trigger, 'hover')
  assert.deepEqual(shine.color, [1, 0, 0])
  assert.equal(normalizeEffect({ kind: 'hover', frequency: 100 })!.kind, 'hover')
  assert.equal((normalizeEffect({ kind: 'hover', frequency: 100 }) as { frequency: number }).frequency, 12)
  assert.equal(luauName('3d button'), 'M3dButton')
})

test('engine: hover grows, press shrinks, pop overshoots on release, ripple spawns at the cursor', () => {
  const spec = normalizeSpec({ targets: [{ path: '', effects: [{ kind: 'hover', scale: 1.1, lift: 4, frequency: 5, damping: 1 }, { kind: 'press', scale: 0.9, frequency: 8, damping: 1 }, { kind: 'pop', amount: 0.15, frequency: 5, damping: 0.4 }, { kind: 'ripple' }] }] })
  const e = new MotionEngine(spec)
  e.setRect('', { x: 0, y: 0, w: 200, h: 50 })
  e.move(50, 25)
  e.hover('', true)
  for (let i = 0; i < 60; i++) e.step(1 / 60)
  assert.ok(Math.abs(e.values('').scale - 1.1) < 0.01)
  assert.ok(Math.abs(e.values('').dy + 4) < 0.1)
  e.press('', true)
  assert.equal(e.values('').ripples.length, 1)
  assert.equal(e.values('').ripples[0].x, 50)
  for (let i = 0; i < 60; i++) e.step(1 / 60)
  assert.ok(Math.abs(e.values('').scale - 0.9) < 0.01)
  e.press('', false)
  let peak = 0
  for (let i = 0; i < 60; i++) (e.step(1 / 60), (peak = Math.max(peak, e.values('').scale)))
  assert.ok(peak > 1.12, `pop peak ${peak}`)
})

test('engine: reduced motion drops decorative effects and overshoot', () => {
  const spec = presetSpec('floaty')
  const full = simulate(spec, '', defaultScript(new Set(['hover'])))
  const red = simulate(spec, '', defaultScript(new Set(['hover'])), { reduced: true })
  const spread = (tl: typeof full) => Math.max(...tl.samples.map((s) => Math.abs(s.values.dy) + Math.abs(s.values.rot)))
  assert.ok(spread(full) > 2)
  assert.ok(spread(red) < 0.5, `reduced still moves ${spread(red)}`)
  const ignore = simulate({ ...spec, reducedMotion: 'ignore' }, '', defaultScript(new Set(['hover'])), { reduced: true })
  assert.ok(spread(ignore) > 2)
})

test('timeline: states, events, response time and overshoot', () => {
  const tl = simulate(presetSpec('bouncy'), '', defaultScript(new Set(['hover', 'press', 'pop'])))
  assert.deepEqual(tl.events.map((e) => e.kind), ['enter', 'down', 'up', 'leave'])
  assert.deepEqual([...new Set(tl.states.map((s) => s.state))].sort(), ['hover', 'idle', 'pressed'])
  const hover = responseTime(tl, 'enter')!
  assert.ok(hover > 0.02 && hover < 0.1, `hover ${hover}`)
  assert.ok(overshootAfter(tl, 'up') > 0.2)
  assert.ok(overshootAfter(simulate(presetSpec('snappy'), '', defaultScript(new Set(['hover', 'press']))), 'enter') < 0.02)
})

// ---------------------------------------------------------------- UI principles

test('ui principles: catalogue, selection and the plan for the UI Motion Lab', () => {
  const ids = principlesFor('ui').map((p) => p.id)
  assert.deepEqual(ids, ['ui-responsiveness', 'ui-anticipation', 'ui-overshoot', 'ui-consistency', 'ui-readability', 'ui-reduced-motion'])
  assert.ok(selectPrinciples('uimotion', 'bouncy button').every((p) => p.domain === 'ui'))
  assert.ok(!selectPrinciples('vfx', 'fire').some((p) => p.domain === 'ui'))
  assert.match(principlePlan('uimotion', 'shop button'), /"plan"/)
})

test('ui principles: code checks reward snappy and flag slow, wobbly and motion-heavy stacks', () => {
  const by = (spec: Parameters<typeof uiPrincipleChecks>[0]) => Object.fromEntries(uiPrincipleChecks(spec).map((c) => [c.id, c]))
  const snappy = by(presetSpec('snappy'))
  assert.ok(snappy['ui-responsiveness'].score >= 9)
  assert.ok(snappy['ui-overshoot'].score >= 9)
  const slow = by(normalizeSpec({ targets: [{ path: '', effects: [{ kind: 'hover', scale: 1.05, frequency: 0.8, damping: 1 }] }] }))
  assert.ok(slow['ui-responsiveness'].score < 5, JSON.stringify(slow['ui-responsiveness']))
  assert.ok(slow['ui-responsiveness'].fix)
  const wobbly = by(normalizeSpec({ targets: [{ path: '', effects: [{ kind: 'hover', scale: 1.25, frequency: 3, damping: 0.15 }, { kind: 'press', scale: 0.9, frequency: 10, damping: 1.5 }] }] }))
  assert.ok(wobbly['ui-overshoot'].score < 4)
  assert.ok(wobbly['ui-consistency'].score < 6)
  assert.ok(wobbly['ui-readability'].score < 8)
  const ignore = by({ ...presetSpec('floaty'), reducedMotion: 'ignore' })
  assert.ok(ignore['ui-reduced-motion'].score <= 2)
  assert.ok(ignore['ui-anticipation'].score <= 5)
})

// ---------------------------------------------------------------- AI parsing

test('ai: compose answers parse into a spec; unknown paths and empty stacks are rejected', () => {
  const ok = parseComposeAnswer('```json\n{"name":"Shop Buy","targets":[{"path":"","effects":[{"kind":"hover","scale":1.06},{"kind":"shine","trigger":"idle"}]},{"path":"Label","effects":[{"kind":"pop"}]}],"notes":"loud","plan":{"ui-responsiveness":"60 ms"}}\n```', ['Label'], 'X')
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.equal(ok.spec.name, 'ShopBuy')
    assert.equal(ok.spec.targets.length, 2)
    assert.equal(ok.notes, 'loud')
  }
  const bad = parseComposeAnswer('{"targets":[{"path":"Nope","effects":[{"kind":"pop"}]}]}', ['Label'], 'X')
  assert.equal(bad.ok, false)
  assert.equal(parseComposeAnswer('no json here', [], 'X').ok, false)
  const h = heuristicStack('juicy shop button that glows')
  assert.equal(h.preset, 'juicy')
  assert.equal(heuristicStack('something').preset, 'snappy')
})

test('ai: critique parsing and change application (bounded, add / remove, unknown fields skipped)', () => {
  const v = parseCritique('{"overall":6.5,"summary":"wobbly","scores":{"feedback":8,"feel":6,"restraint":4,"polish":7},"changes":[{"path":"","kind":"pop","field":"damping","value":0.65,"principle":"ui-overshoot"},{"path":"","kind":"hover","field":"wings","value":3},{"path":"","kind":"glow","field":"add","value":{"thickness":3}},{"path":"","kind":"ripple","field":"remove"},{"path":"","kind":"bogus","field":"x"}]}')
  assert.equal(v.overall, 6.5)
  assert.equal(v.changes.length, 4)
  const spec = presetSpec('bouncy')
  const r = applyChanges(spec, v.changes)
  assert.equal((r.spec.targets[0].effects.find((e) => e.kind === 'pop') as { damping: number }).damping, 0.65)
  assert.ok(r.spec.targets[0].effects.some((e) => e.kind === 'glow'))
  assert.deepEqual(r.skipped.length, 2)
  const c = buildCritique(r.spec, 'bouncy play button', { at: 1, vision: v })
  assert.ok(c.principles!.length >= 5)
  assert.ok(c.overall > 0 && c.overall <= 10)
  assert.ok(c.vision!.changes.some((ch) => ch.principle === 'ui-overshoot'))
})

// ---------------------------------------------------------------- codegen

function tool(envName: string, bin: string): string | null {
  const env = process.env[envName]
  if (env && existsSync(env)) return env
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null
}
const luauCompile = tool('LUAU_COMPILE', 'luau-compile')
const luauLsp = tool('LUAU_LSP', 'luau-lsp')
const defs = process.env.ROBLOX_DEFS && existsSync(process.env.ROBLOX_DEFS) ? process.env.ROBLOX_DEFS : null

function snapshot(name: string, text: string): void {
  const file = join(FIX, 'uimotion', name)
  if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
    mkdirSync(join(FIX, 'uimotion'), { recursive: true })
    writeFileSync(file, text)
  }
  assert.equal(text, readFileSync(file, 'utf8'), `${name} changed (UPDATE_SNAPSHOTS=1 to accept)`)
}

const nodes = JSON.parse(readFileSync(join(FIX, 'figma', 'play-button.nodes.json'), 'utf8'))
const mapped = mapFigmaNode(nodes.nodes['12:34'].document, { name: 'PlayButton' })
const generated = {
  'PlayButtonEffects.luau': compileMotionModule(presetSpec('juicy', '', 'PlayButton'), { source: 'PlayButton / Juicy' }),
  'SnappyEffects.luau': compileMotionModule(presetSpec('snappy', '', 'Snappy')),
  'PlayButton.luau': componentModule(mapped.root, { from: 'Figma file KEY, node 12:34', report: mapped.report }),
  'PlayButton.story.luau': storyModule({ name: 'PlayButton', component: 'script.Parent.Parent.Components.PlayButton', effects: 'script.Parent.Parent.Motion.PlayButtonEffects' }),
  'Lab.story.luau': labStoryLuau({ kind: 'component', require: 'game:GetService("ReplicatedStorage").Shared.Interface.Components.PlayButton', name: 'PlayButton' })
}

test('codegen: snapshots of the motion module, component, story and lab story', () => {
  for (const [name, text] of Object.entries(generated)) snapshot(name, text)
})

test('codegen: modules include only the runtime parts they use and clean up', () => {
  const snappy = generated['SnappyEffects.luau']
  assert.doesNotMatch(snappy, /ForgeMotionShine|ForgeMotionRipple|TweenService/)
  assert.match(snappy, /RenderStepped/)
  assert.match(snappy, /:Disconnect\(\)/)
  assert.match(snappy, /ReducedMotionEnabled/)
  const juicy = generated['PlayButtonEffects.luau']
  assert.match(juicy, /ForgeMotionShine/)
  assert.match(juicy, /ForgeMotionRipple/)
  assert.match(juicy, /TweenService/)
  assert.doesNotMatch(juicy, /--#(if|end)/)
  assert.equal(selectBlocks('a\n--#if pop\nb\n--#end\nc', new Set(['hover'])), 'a\nc')
  assert.match(describeSpec(presetSpec('juicy')), /shine on idle/)
  // Requires: relative inside one tree, absolute otherwise.
  assert.equal(requireBetween(['ReplicatedStorage', 'Shared', 'Interface', 'Stories', 'X'], ['ReplicatedStorage', 'Shared', 'Interface', 'Components', 'Y']), 'script.Parent.Parent.Components.Y')
  assert.equal(requireBetween(['StarterPlayer', 'X'], ['ReplicatedStorage', 'Y']), 'game:GetService("ReplicatedStorage").Y')
})

test('codegen: every preset compiles with luau-compile', { skip: luauCompile ? false : 'luau-compile not found (set LUAU_COMPILE)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'uim-luau-'))
  const files = { ...generated, ...Object.fromEntries(MOTION_PRESETS.map((p) => [`${p.key}.luau`, compileMotionModule(presetSpec(p.key))])) }
  for (const [name, text] of Object.entries(files)) {
    const f = join(dir, name)
    writeFileSync(f, text)
    const r = spawnSync(luauCompile!, ['--null', f], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${name}: ${r.stderr || r.stdout}`)
  }
})

test('codegen: the motion modules type-check under luau-lsp with Roblox definitions', { skip: luauLsp && defs ? false : 'luau-lsp or $ROBLOX_DEFS not set' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'uim-lsp-'))
  for (const [name, text] of Object.entries({ 'PlayButtonEffects.luau': generated['PlayButtonEffects.luau'], 'SnappyEffects.luau': generated['SnappyEffects.luau'], 'PlayButton.luau': generated['PlayButton.luau'] })) writeFileSync(join(dir, name), text)
  const r = spawnSync(luauLsp!, ['analyze', `--defs=${defs}`, '--platform', 'roblox', dir], { encoding: 'utf8' })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
})
