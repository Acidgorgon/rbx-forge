// Thumbnail Lab prompt builder and UI art (pure): the offline eval of the builder (fixture asks ->
// key prompt properties, shared/thumbs/promptEval.ts), reading asks (genre, emotion, quoted words,
// icon names), sections -> prompt, lint, the model expansion merge, and the UI image processing
// (background key-out, trimming, 9-slice SliceCenter, measured look, code checks, the ranking critic
// parser, the learned kit and the Luau snippet).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blank, type Rgba } from '../src/shared/vfx/tex/image.ts'
import { button } from './uiArtFixture.ts'
import { analyzeAsk, buildSections, isUiKind, lintSections, mergeExpansion, normalizeSections, renderSections, sectionText, SECTION_ORDER, splitNames, uiGenSize, uiPrompt, UI_KIND_IDS, THUMB_RULES } from '../src/shared/thumbs/builder.ts'
import { COPY_RULE, generationPrompt, refinePrompt, scrubBrief } from '../src/shared/thumbs/prompt.ts'
import { EVAL_PROFILE, evalSummary, evaluateCase, PROMPT_EVAL_CASES, type EvalCase } from '../src/shared/thumbs/promptEval.ts'
import { blendCritique, codeCritique, contentFill, keyOutBackground, learnUiKit, measuredLook, onGrey, paletteDistance, parseUiRanking, pickBestUi, scaleSlice, sliceCenter, squareIcon, trimToContent, uiAssetStats, uiChecks, uiLuau } from '../src/shared/thumbs/uiart.ts'
import type { UiAsset, UiAssetKind } from '../src/shared/thumbs/types.ts'
import { validSize } from '../src/main/services/art/openaiImages.ts'

// ------------------------------------------------------------------ fixtures

// A drawn "transparency" checkerboard behind a disc (models do this when asked for transparency).
function checkerDisc(size = 256): Rgba {
  const img = blank(size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inDisc = Math.hypot(x - size / 2, y - size / 2) < size * 0.3
      const c = inDisc ? [230, 180, 20] : ((x >> 4) + (y >> 4)) % 2 ? [204, 204, 204] : [255, 255, 255]
      img.data.set([...c, 255], i)
    }
  return img
}

function noise(w: number, h: number): Rgba {
  const img = blank(w, h)
  let s = 7
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    img.data.set([s & 255, (s >> 8) & 255, (s >> 16) & 255, 255], i * 4)
  }
  return img
}

// The case as the service builds it: scrub the ask, sections, then the final prompt.
function buildCase(c: EvalCase) {
  const ask = scrubBrief(c.ask, c.forbidden ?? [], c.gameName ? [c.gameName] : []).text
  const names = c.mode === 'icon-set' ? (c.names ?? splitNames(ask)) : undefined
  const size = isUiKind(c.mode) ? uiGenSize(c.mode, 'gpt-image-2.5-sunburst') : undefined
  const sections = buildSections({ ask, mode: c.mode, gameName: c.gameName, profile: c.profile ? EVAL_PROFILE : null, kit: c.kit, names, size })
  const prompt = c.mode === 'thumbnail' ? generationPrompt({ brief: ask, bases: 0, gameName: c.gameName, sections }, c.forbidden ?? []).prompt : uiPrompt(sections, { kind: c.mode, gameName: c.gameName, icon: names?.[0] })
  return { sections, prompt, names, warnings: lintSections(sections, c.mode, names) }
}

// ------------------------------------------------------------------ the eval

test('prompt eval: every fixture ask passes every property', () => {
  const results = PROMPT_EVAL_CASES.map((c) => evaluateCase(c, buildCase(c)))
  const s = evalSummary(results)
  assert.deepEqual(s.failed, [])
  assert.equal(s.passed, s.cases)
  assert.ok(s.cases >= 15 && s.checks >= 120, `${s.cases} cases, ${s.checks} checks`)
  // Every mode is covered.
  for (const m of ['thumbnail', ...UI_KIND_IDS]) assert.ok(PROMPT_EVAL_CASES.some((c) => c.mode === m), `no eval case for ${m}`)
})

test('prompt eval: the evaluator catches a broken prompt', () => {
  const c = PROMPT_EVAL_CASES.find((x) => x.id === 'button-buy')!
  const b = buildCase(c)
  const broken = b.sections.map((s) => (s.key === 'output' ? { ...s, text: 'A PNG.' } : s.key === 'roblox' ? { ...s, text: 'Looks nice.' } : s.key === 'composition' ? { ...s, text: 'On a sunny beach with blue sky.' } : s))
  const r = evaluateCase(c, { sections: broken, prompt: uiPrompt(broken, { kind: 'button' }) })
  assert.equal(r.pass, false)
  const failed = r.checks.filter((x) => !x.pass).map((x) => x.name)
  assert.ok(failed.includes('asks for a transparent background'))
  assert.ok(failed.includes('9-slice guidance'))
  assert.ok(failed.includes('no scene behind a transparent asset'))
  assert.ok(failed.includes('lint clean'))
})

// ------------------------------------------------------------------ reading asks

test('analyzeAsk: subject, genre, emotion, quoted text, colours, styles, caps', () => {
  const a = analyzeAsk('Make a thumbnail of a noob escaping a haunted hospital, shocked, with "RUN!" in red')
  assert.equal(a.subject, 'a noob escaping a haunted hospital, shocked, with "RUN!" in red')
  assert.equal(a.genre.id, 'horror')
  assert.match(a.emotion!, /shocked/)
  assert.equal(a.characters, true)
  assert.deepEqual(a.quoted, ['RUN!'])
  assert.deepEqual(a.colors, ['red'])
  assert.equal(analyzeAsk('glossy neon sci-fi button').styles.join(','), 'glossy,neon,sci-fi')
  assert.deepEqual(analyzeAsk('a green BUY button for the UI').caps, ['BUY'])
  assert.deepEqual(analyzeAsk('the "SHOP" tab').caps, [])
  assert.equal(analyzeAsk('a cozy cafe').genre.id, 'cozy')
  assert.equal(analyzeAsk('nothing in particular').genre.id, 'default')
  // Apostrophes are not quotes.
  assert.deepEqual(analyzeAsk("the player's car won't start").quoted, [])
})

test('splitNames: lists, colons, plurals, style clauses, caps at 12', () => {
  assert.deepEqual(splitNames('coin, gem, heart and key icons in a glossy cartoon style'), ['coin', 'gem', 'heart', 'key'])
  assert.deepEqual(splitNames('shop icons: swords, shields, potions'), ['sword', 'shield', 'potion'])
  assert.deepEqual(splitNames('icons for berries / boxes / glass'), ['berry', 'box', 'glass'])
  assert.deepEqual(splitNames('make a set of fire sword, ice staff + golden bow'), ['fire sword', 'ice staff', 'golden bow'])
  assert.deepEqual(splitNames('a trophy icon'), ['trophy'])
  assert.equal(splitNames(Array.from({ length: 20 }, (_, i) => `item${i}`).join(', ')).length, 12)
})

// ------------------------------------------------------------------ sections and prompts

test('buildSections: every section, in order, for every mode; sizes are valid for the image API', () => {
  for (const mode of ['thumbnail', ...UI_KIND_IDS] as const) {
    const s = buildSections({ ask: 'a golden coin', mode, names: ['coin', 'gem'] })
    assert.deepEqual(s.map((x) => x.key), [...SECTION_ORDER])
    assert.ok(s.every((x) => x.text.trim() && x.label))
  }
  for (const kind of UI_KIND_IDS)
    for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'])
      for (const shape of ['square', 'wide', 'tall'] as const) {
        const size = uiGenSize(kind, model, shape)
        assert.equal(validSize(model, size), null, `${kind} ${model} ${shape}: ${size}`)
        if (/^gpt-image-2/.test(model)) for (const n of size.split('x').map(Number)) assert.equal(n % 16, 0)
      }
  assert.equal(uiGenSize('button', 'gpt-image-2.5-sunburst'), '1536x576')
  assert.equal(uiGenSize('hud', 'gpt-image-1.5'), '1536x1024')
})

test('thumbnail sections: profile and taste go in (source kit), the rules stay in the prompt even when edited away', () => {
  const s = buildSections({ ask: 'opening a legendary egg', mode: 'thumbnail', profile: EVAL_PROFILE, taste: ['prefers more saturated colour'] })
  assert.match(sectionText(s, 'camera'), /Close-up/)
  assert.equal(s.find((x) => x.key === 'camera')!.source, 'kit')
  assert.match(sectionText(s, 'palette'), /#ff2d55 #ffd60a/)
  assert.match(sectionText(s, 'style'), /prefers more saturated colour/)
  assert.match(sectionText(s, 'text'), /chunky outlined sans/)
  assert.equal(sectionText(s, 'roblox'), THUMB_RULES)
  const edited = s.map((x) => (x.key === 'roblox' ? { ...x, text: 'whatever' } : x))
  const p = generationPrompt({ brief: 'x', bases: 1, styleRefs: 1, gameName: 'Egg Sim', sections: edited }).prompt
  assert.match(p, /Thumbnail rules: One focal point/)
  assert.match(p, /attached screenshot of the real game/)
  assert.match(p, /The last attached image is a style reference/)
  assert.ok(p.includes(COPY_RULE))
  // Names of other games are scrubbed from edited sections too.
  const named = s.map((x) => (x.key === 'style' ? { ...x, text: 'Like Blox Fruits, glossy' } : x))
  const g = generationPrompt({ brief: 'x', bases: 0, sections: named }, ['blox fruits', 'blox', 'fruits'])
  assert.doesNotMatch(g.prompt, /\bblox\b|\bfruits\b/i)
  assert.ok(g.removed.includes('blox fruits'))
  // Refine reuses the sections.
  const r = refinePrompt({ brief: 'x', bases: 0, changes: ['Bigger egg'], sections: s }).prompt
  assert.match(r, /^Revise the first attached image/)
  assert.match(r, /Palette: Palette around #ff2d55/)
})

test('UI sections: kit palette / look / avoid carried; labels only when quoted; icon placeholder filled', () => {
  const kit = { samples: 2, palette: ['#123456', '#abcdef'], look: { stroke: 'thick dark outline', corners: 'rounded corners', shading: 'flat fills', typography: 'chunky rounded sans' }, refIds: ['ua-x-1'], lines: [], avoid: ['avoid sharp corners'] }
  const b = buildSections({ ask: 'a play button that says "PLAY"', mode: 'button', kit })
  assert.match(sectionText(b, 'palette'), /#123456 #abcdef/)
  assert.match(sectionText(b, 'style'), /thick dark outline, rounded corners, flat fills/)
  assert.match(sectionText(b, 'text'), /The label "PLAY" exactly/)
  assert.match(sectionText(b, 'text'), /chunky rounded sans/)
  assert.match(sectionText(b, 'avoid'), /Avoid sharp corners\./)
  assert.doesNotMatch(sectionText(b, 'avoid'), /any text/)
  const set = buildSections({ ask: 'coin, gem', mode: 'icon-set' })
  const p = uiPrompt(set, { kind: 'icon-set', gameName: 'Pet Sim', icon: 'gem', anchor: true, kitRefs: 2 })
  assert.match(p, /This icon: gem\./)
  assert.doesNotMatch(p, /\{icon\}/)
  assert.match(p, /The first attached image is the first icon of this set/)
  assert.match(p, /The next 2 attached images are UI from this game's kit/)
  // An edit that drops the placeholder still names the icon.
  const edited = set.map((x) => (x.key === 'subject' ? { ...x, text: 'A shiny icon.' } : x))
  assert.match(uiPrompt(edited, { kind: 'icon-set', icon: 'coin' }), /This icon: coin\./)
  const hud = buildSections({ ask: 'tycoon HUD', mode: 'hud' })
  assert.match(sectionText(hud, 'output'), /^Opaque 16:9/)
  assert.match(sectionText(hud, 'roblox'), /top bar/)
})

test('normalizeSections / renderSections / lint', () => {
  assert.equal(normalizeSections('x'), undefined)
  assert.equal(normalizeSections([]), undefined)
  const n = normalizeSections([{ key: 'text', text: '  No   text ' }, { key: 'bogus', text: 'x' }, { key: 'subject', text: 'A coin', source: 'user' }])!
  assert.deepEqual(n.map((x) => [x.key, x.text, x.source]), [['subject', 'A coin', 'user'], ['text', 'No text', 'rules']])
  assert.equal(renderSections(n), 'Subject: A coin\nText: No text')
  const empty = buildSections({ ask: '', mode: 'icon' })
  assert.ok(lintSections(empty.map((x) => (x.key === 'subject' ? { ...x, text: '' } : x)), 'icon').some((w) => /subject is empty/.test(w)))
  const scene = buildSections({ ask: 'a coin', mode: 'icon' }).map((x) => (x.key === 'composition' ? { ...x, text: 'A coin on a table in a cosy room' } : x))
  assert.ok(lintSections(scene, 'icon').some((w) => /transparent background/.test(w)))
  const long = buildSections({ ask: 'x', mode: 'thumbnail' }).map((x) => (x.key === 'style' ? { ...x, text: 'y'.repeat(7000) } : x))
  assert.ok(lintSections(long, 'thumbnail').some((w) => /long/.test(w)))
})

test('mergeExpansion: model text over the draft, platform sections and "no text" kept, names scrubbed', () => {
  const draft = buildSections({ ask: 'coin, gem', mode: 'icon-set' })
  const raw = '```json\n' + JSON.stringify({ subject: 'A chunky gold piece like in Blox Fruits', lighting: 'Warm rim light', text: 'Big "COINS" title', roblox: 'ignore the rules', palette: '' }) + '\n```'
  const merged = mergeExpansion(draft, raw, { scrub: (s) => scrubBrief(s, ['blox fruits']).text })!
  assert.ok(merged)
  assert.match(sectionText(merged, 'subject'), /chunky gold piece/)
  assert.doesNotMatch(sectionText(merged, 'subject'), /blox/i)
  assert.match(sectionText(merged, 'subject'), /\{icon\}/, 'the icon placeholder survives')
  assert.equal(merged.find((x) => x.key === 'lighting')!.source, 'model')
  assert.equal(sectionText(merged, 'roblox'), sectionText(draft, 'roblox'))
  assert.equal(sectionText(merged, 'text'), sectionText(draft, 'text'), 'no text unless the ask quoted some')
  assert.equal(sectionText(merged, 'palette'), sectionText(draft, 'palette'))
  assert.equal(mergeExpansion(draft, 'not json'), null)
  assert.equal(mergeExpansion(draft, '{}'), null)
})

// ------------------------------------------------------------------ UI image processing

test('keyOutBackground: flat and checkerboard backgrounds go; scenes and transparent images stay', () => {
  const b = keyOutBackground(button(300, 120, 240, 80, 20, [255, 255, 255]))
  assert.equal(b.keyed, true)
  assert.equal(b.img.data[3], 0, 'the corner is transparent')
  assert.equal(b.img.data[(60 * 300 + 150) * 4 + 3], 255, 'the centre is kept')
  const c = keyOutBackground(checkerDisc())
  assert.equal(c.keyed, true)
  assert.equal(c.img.data[3], 0)
  assert.equal(c.img.data[(128 * 256 + 128) * 4 + 3], 255)
  assert.equal(keyOutBackground(noise(120, 80)).keyed, false)
  const t = button(200, 100, 160, 60, 16, null)
  assert.equal(keyOutBackground(t).img, t)
})

test('trim, square icons, fill; sliceCenter covers border + corner radius on every side', () => {
  const k = keyOutBackground(button(600, 240, 480, 160, 40, [255, 255, 255])).img
  assert.equal(contentFill(k), 0.8)
  const t = trimToContent(k, 0.02)
  assert.ok(Math.abs(t.width - 501) <= 2 && Math.abs(t.height - 181) <= 2, `${t.width}x${t.height}`)
  const s = sliceCenter(t)!
  assert.ok(s, 'a slice')
  // Content starts ~10 px in; radius 40 -> insets of ~50 px.
  for (const v of [s.x0, s.y0, t.width - s.x1, t.height - s.y1]) assert.ok(v >= 48 && v <= 58, JSON.stringify(s))
  assert.deepEqual(scaleSlice(s, t, { width: Math.round(t.width / 2), height: Math.round(t.height / 2) }), { x0: Math.round(s.x0 / 2), y0: Math.round(s.y0 / 2), x1: Math.round(s.x1 / 2), y1: Math.round(s.y1 / 2) })
  // A pill: the radius eats the whole height, nothing left to stretch vertically.
  assert.equal(sliceCenter(trimToContent(button(400, 120, 300, 80, 40, null))), null)
  assert.equal(sliceCenter(blank(8)), null)
  const icon = squareIcon(k, 512)
  assert.deepEqual([icon.width, icon.height], [512, 512])
  assert.equal(icon.data[3], 0)
})

test('uiAssetStats / measuredLook / uiChecks', () => {
  const t = trimToContent(keyOutBackground(button(600, 240, 480, 160, 40, [255, 255, 255])).img)
  const st = uiAssetStats(t)
  assert.equal(st.outline, 'dark')
  assert.equal(st.topLit, true)
  assert.ok(st.corner >= 0.2 && st.corner <= 0.3, String(st.corner))
  assert.ok(st.palette[0].hex.startsWith('#2'))
  assert.deepEqual(measuredLook(st), { stroke: 'thick dark outline', corners: 'rounded corners', shading: 'top-lit gradient with a glossy highlight', typography: '' })
  const checks = uiChecks({ kind: 'button', img: t, stats: st, background: 'keyed', fill: 0.8, slice: sliceCenter(t), kitPalette: ['#28c83c', '#141e14'] })
  assert.deepEqual(checks.map((c) => c.id), ['ui-bg', 'ui-small', 'ui-slice', 'ui-kit'])
  assert.equal(checks[0].score, 8)
  assert.equal(checks[2].score, 10)
  assert.ok(checks[3].score >= 9)
  const far = uiChecks({ kind: 'icon', img: t, stats: st, background: 'opaque', fill: 0.2, kitPalette: ['#ff00ff', '#00ffff'] })
  assert.equal(far.find((c) => c.id === 'ui-bg')!.score, 2)
  assert.ok(far.find((c) => c.id === 'ui-fill')!.score < 7)
  assert.ok(far.find((c) => c.id === 'ui-kit')!.score < 3)
  assert.ok(far.every((c) => c.score >= 7 || c.fix), 'every low check says what to fix')
  const hud = uiChecks({ kind: 'hud', img: onGrey(t), stats: st, background: 'opaque', fill: 1 })
  assert.deepEqual(hud.map((c) => c.id), ['ui-small'])
  assert.equal(paletteDistance([{ hex: '#000000', share: 1 }], ['#000000']), 0)
  assert.equal(paletteDistance([], ['#000000']), null)
})

test('ranking critic: prompt, parse (fenced, out of order, skipped), blend, pick best', () => {
  const raw = '```json\n{"candidates":[{"index":2,"overall":9,"brief":9,"readability":8,"consistency":7,"clean":9,"summary":"best","changes":["thicker outline"],"look":{"stroke":"thick dark outline","corners":"pill","shading":"glossy","typography":""}},{"index":1,"overall":4,"summary":"meh"},{"index":9,"overall":10}]}\n```'
  const r = parseUiRanking(raw, 3)!
  assert.equal(r[0]!.overall, 4)
  assert.equal(r[1]!.overall, 9)
  assert.equal(r[1]!.look!.corners, 'pill')
  assert.equal(r[2], null)
  assert.equal(parseUiRanking('nope', 2), null)
  // A single candidate may answer without the list.
  assert.equal(parseUiRanking('{"overall":7,"summary":"ok"}', 1)![0]!.overall, 7)
  const checks = [{ id: 'ui-small', label: 'reads small', score: 4, note: '', fix: 'Thicker outline' }]
  const c = blendCritique(r[1]!, checks, 1)
  assert.equal(c.overall, 7)
  assert.equal(c.by, 'critic')
  assert.deepEqual(c.changes, ['thicker outline', 'Thicker outline'])
  assert.equal(codeCritique(checks, 1).by, 'code')
  assert.match(codeCritique(checks, 1).summary, /reads small 4/)
  assert.equal(pickBestUi([{ id: 'a', checks, critique: c }, { id: 'b', checks, critique: { ...c, overall: 8 } }]), 'b')
  assert.equal(pickBestUi([{ id: 'a', checks: [{ ...checks[0], score: 9 }] }, { id: 'b', checks }]), 'a')
})

function asset(p: Partial<UiAsset> & { id: string; kind?: UiAssetKind }): UiAsset {
  const st = { width: 100, height: 40, coverage: 0.8, palette: [{ hex: '#22cc44', share: 0.8 }], outline: 'dark' as const, corner: 0.25, flatness: 0.6, topLit: true }
  return { batchId: 'ua-test1', scope: 'project', kind: 'button', name: 'b', ask: 'b', prompt: '', model: 'm', genSize: '1536x576', quality: 'high', costUsd: 0, transparent: true, file: 'image.png', width: 100, height: 40, stats: st, checks: [], refIds: [], createdAt: 1, updatedAt: 1, ...p }
}

test('learnUiKit: kept / +1 assets -> palette, look, refs (pinned first), avoid lines from -1', () => {
  assert.equal(learnUiKit([]).samples, 0)
  assert.deepEqual(learnUiKit([asset({ id: 'ua-a-1' })]).refIds, [], 'nothing kept, nothing learned')
  const flat = { width: 100, height: 40, coverage: 0.8, palette: [{ hex: '#888888', share: 1 }], outline: 'none' as const, corner: 0, flatness: 0.95, topLit: false }
  const kit = learnUiKit(
    [
      asset({ id: 'ua-a-1', keep: true, updatedAt: 5 }),
      asset({ id: 'ua-a-2', rating: 'up', updatedAt: 9, look: { stroke: 'chunky black outline', corners: 'pill', shading: 'glossy', typography: 'bubble letters' } }),
      asset({ id: 'ua-a-3', pinned: true, kind: 'icon', updatedAt: 1 }),
      asset({ id: 'ua-a-4', rating: 'down', stats: flat }),
      asset({ id: 'ua-a-5', rating: 'down', stats: flat })
    ],
    { kind: 'button' }
  )
  assert.equal(kit.samples, 2)
  assert.equal(kit.palette[0], '#22cc44')
  assert.equal(kit.look.stroke, 'chunky black outline', "the critic's words win over the measured look")
  assert.equal(kit.look.typography, 'bubble letters')
  assert.deepEqual(kit.refIds, ['ua-a-3', 'ua-a-1', 'ua-a-2'])
  assert.ok(kit.avoid.includes('avoid thin or missing outlines'))
  assert.ok(kit.avoid.includes('avoid flat, unshaded fills'))
  assert.ok(kit.avoid.includes('avoid sharp corners'))
  assert.ok(kit.lines[0].startsWith('palette #22cc44'))
})

test('uiLuau: SliceCenter for buttons / panels, Fit for icons, upload hint without an asset id', () => {
  const b = uiLuau({ kind: 'button', name: 'Buy', slice: { x0: 10, y0: 12, x1: 90, y1: 28 }, roblox: { assetId: '1', uri: 'rbxassetid://1', uploadedAt: 0 } }, { width: 100, height: 40 })
  assert.match(b, /image\.Image = "rbxassetid:\/\/1"/)
  assert.match(b, /ScaleType = Enum\.ScaleType\.Slice/)
  assert.match(b, /SliceCenter = Rect\.new\(10, 12, 90, 28\) -- of 100x40/)
  const i = uiLuau({ kind: 'icon', name: 'Coin' })
  assert.match(i, /rbxassetid:\/\/0" -- Upload to Roblox first/)
  assert.match(i, /ScaleType\.Fit/)
})
