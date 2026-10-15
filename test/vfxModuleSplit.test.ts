// Effect modules stay under Roblox's Source limit (Script.Source must be shorter than 200,000
// characters: "Unable to assign property Source. Provided string length (200254) is greater than or
// equal to max length (200000)"). The module is data-driven (one compact row per instance), and an
// effect still too big moves its rows into Data1..DataN child modules: in project files (Rojo),
// Test in Studio / Studio checks (bridge jobs), Live in Studio and Ability Composer jobs. Built in
// the Lune world (resources/lune/forge/world.luau), the new modules make exactly the instances,
// properties and cues the old statement-per-property generator made.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATA_HEADER, effectModules, luauModule, sourceLength, SOURCE_CAP, SOURCE_LIMIT, luauString } from '../src/shared/vfx/luau.ts'
import { luauModule as legacyModule } from './fixtures/vfxLuauLegacy.ts'
import { FORGEFX_SOURCE } from '../src/shared/vfx/runtime.ts'
import { assertModuleSizes, MAX_JOB_SOURCE, ModuleTooLargeError, vfxJob, abilityJob } from '../src/shared/studio/payload.ts'
import { LiveSchedule, liveModuleSource, livePayload } from '../src/shared/vfx/live.ts'
import { compileTimeline } from '../src/shared/vfx/compile.ts'
import { findExample } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { allNodes } from '../src/shared/vfx/analyze.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { findLune } from '../src/main/services/tests/lune.ts'
import type { BridgeModule } from '../src/shared/studio/protocol.ts'
import { normalizeAbility } from '../src/shared/ability/model.ts'
import type { CFrameArr, ColorKey, NumKey, VfxCue, VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

const lune = process.env.LUNE_PATH || findLune()
const cf = (x: number, y: number, z: number): CFrameArr => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1]
// Deterministic "random" numbers.
const wave = (i: number, k = 1) => Math.round((Math.sin(i * 12.9898 * k) * 0.5 + 0.5) * 1000) / 1000
const nseq = (i: number, n: number): NumKey[] => Array.from({ length: n }, (_, k) => ({ t: k / (n - 1), v: wave(i + k, 1.3) * 3, e: k % 3 === 1 ? wave(i + k, 2.1) * 0.4 : 0 }))
const cseq = (i: number, n: number): ColorKey[] => Array.from({ length: n }, (_, k) => ({ t: k / (n - 1), c: [wave(i + k, 1.7), wave(i + k, 2.9), wave(i + k, 3.3)] }))

const emitter = (id: string, i: number, kp: number): VfxNode => ({
  id,
  className: 'ParticleEmitter',
  name: id,
  props: {
    Rate: 20 + (i % 7),
    Lifetime: [0.4, 0.9 + wave(i) / 2],
    Speed: [3, 7 + (i % 5)],
    Size: nseq(i, kp),
    Transparency: nseq(i + 1, kp),
    Squash: nseq(i + 2, kp),
    Color: cseq(i, kp),
    LightEmission: wave(i, 4),
    Texture: `rbxassetid://${1000000 + i}`,
    SpreadAngle: [30, 15 + (i % 30)],
    Acceleration: [0, -10 + (i % 4), 0],
    Drag: 2,
    ZOffset: 0.5,
    Rotation: [0, 360],
    RotSpeed: [-90, 90],
    Brightness: 2,
    LockedToPart: i % 2 === 0,
    Orientation: i % 3 ? 'FacingCamera' : 'VelocityParallel',
    EmissionDirection: 'Top',
    Shape: 'Sphere'
  },
  children: []
})

// A synthetic imported effect: `count` emitters on attachments of a few parts (long sequences), a
// beam between two attachments, lights, a Model root (or loose roots), and a cue per emitter.
function bigEffect(count: number, kp = 20, opts: { modelRoot?: boolean; tweens?: boolean; name?: string } = {}): VfxEffect {
  const parts: VfxNode[] = []
  const perPart = 25
  for (let p = 0; p * perPart < count; p++) {
    const ems = Array.from({ length: Math.min(perPart, count - p * perPart) }, (_, k) => emitter(`E${p * perPart + k}`, p * perPart + k, kp))
    parts.push({
      id: `P${p}`,
      className: 'Part',
      name: p % 2 ? 'Core' : `Part${p}`, // duplicate names on purpose: FindFirstChild order must hold
      props: { Size: [1, 1 + p, 1], Transparency: 1, Anchored: true, CanCollide: false, CFrame: cf(120 + p, 40, -300) },
      children: [
        { id: `A${p}`, className: 'Attachment', name: 'Att', props: { CFrame: cf(0, 1, 0) }, children: ems },
        { id: `B${p}`, className: 'Attachment', name: 'Tip', props: { CFrame: cf(0, 3, 0) }, children: [] },
        { id: `L${p}`, className: 'PointLight', name: 'Glow', props: { Brightness: 2, Range: 8, Color: [1, 0.5, 0.2] }, children: [] },
        { id: `Beam${p}`, className: 'Beam', name: 'Beam', props: { Attachment0: `A${p}`, Attachment1: `B${p}`, Width0: 1, Width1: 0.2, Color: cseq(p, 4), Transparency: nseq(p, 4), Texture: 'rbxassetid://42' }, children: [] }
      ]
    })
  }
  const roots: VfxNode[] = opts.modelRoot === false ? parts : [{ id: 'M', className: 'Model', name: opts.name ?? 'Big', props: {}, children: parts }]
  const cues: VfxCue[] = []
  for (let i = 0; i < count; i++) cues.push(i % 4 === 3 ? { at: (i % 50) / 1000, target: `E${i}`, action: i % 8 === 3 ? 'enable' : 'disable' } : { at: (i % 50) / 1000, target: `E${i}`, action: 'emit', count: 5 + (i % 9) })
  if (opts.tweens) {
    for (let i = 0; i < count; i++) cues.push({ at: (i % 40) / 1000, target: `E${i}`, action: 'tween', duration: 0.05, props: { Rate: 40 + i, Acceleration: [0, i % 9, 0] } })
    for (let p = 0; p * perPart < count; p++) {
      cues.push({ at: 0, target: `P${p}`, action: 'set', props: { Transparency: 0.5 }, prelude: true })
      cues.push({ at: 0.02, target: `E${p * perPart}`, action: 'emit', count: 3, spawn: `Spawn${p}`, spawnAt: 0.01 })
    }
  }
  return { name: opts.name ?? 'Big', roots, cues, duration: 0.3 }
}

const blank = (name: string): VfxEffect => ({ name, roots: [], cues: [], duration: 2 })
const example = (key: string) => {
  const ex = findExample(key)!
  return compileTimeline(blank(ex.name), RECORDED[ex.key], ex.script).effect
}
const sizes = (m: { source: string; data: { source: string }[] }) => [m.source, ...m.data.map((d) => d.source)].map(sourceLength)

async function luneRun(dir: string, script: string): Promise<string> {
  await writeFile(join(dir, 'run.luau'), script)
  return new Promise((res, rej) => execFile(lune!, ['run', 'run.luau'], { cwd: dir, maxBuffer: 64 << 20, timeout: 120_000 }, (err, stdout, stderr) => (err ? rej(new Error(`${stderr || err.message}\n${stdout}`)) : res(stdout))))
}

// Compiles every file with Luau (Lune); returns the failures by file.
async function compileAll(files: Record<string, string>): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-split-c-'))
  for (const [f, src] of Object.entries(files)) await writeFile(join(dir, f), src)
  const out = await luneRun(dir, `local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nlocal serde = require("@lune/serde")\nlocal bad = {}\nfor _, f in { ${Object.keys(files).map(luauString).join(', ')} } do\n\tlocal ok, err = pcall(luau.compile, fs.readFile(f))\n\tif not ok then\n\t\tbad[f] = tostring(err)\n\tend\nend\nprint(serde.encode("json", bad))\n`)
  const json = out.trim().split('\n').pop()!
  return json === '[]' ? {} : JSON.parse(json)
}

// ------------------------------------------------------------ sizes

test('a huge imported effect splits into data modules, each under the cap; the old module did not fit', () => {
  const huge = bigEffect(400, 20)
  const legacy = legacyModule(huge)
  assert.ok(sourceLength(legacy) >= SOURCE_LIMIT, `the old generator made ${legacy.length} characters (the reported bug)`)
  const m = effectModules(huge)
  assert.ok(m.data.length >= 2, `${m.data.length} data parts`)
  for (const n of sizes(m)) assert.ok(n < SOURCE_CAP, `module of ${n} characters`)
  assert.deepEqual(m.data.map((d) => d.name), m.data.map((_, i) => `Data${i + 1}`))
  assert.match(m.source, new RegExp(`local DATA = load\\(${m.data.length}\\)`))
  for (const d of m.data) assert.ok(d.source.split('\n').slice(0, 3).some((l) => l.startsWith(DATA_HEADER)))
  // Every instance row is in exactly one part, whole (never split mid-value), in order.
  const rows = m.data.flatMap((d) => d.source.split('\n').filter((l) => /^\t\t\{"/.test(l)))
  assert.equal(rows.length, allNodes(huge.roots).length)
  assert.ok(rows.every((r) => r.endsWith('},')))
  // Much smaller than before in total, too.
  const total = sizes(m).reduce((a, b) => a + b, 0)
  assert.ok(total * 2 < sourceLength(legacy), `${total} vs ${sourceLength(legacy)}`)
  // luauModule is only for effects that fit.
  assert.throws(() => luauModule(huge), /too big for one module/)
  // A scripted one (tweens, prelude, spawns) splits its cue lists too.
  const scripted = effectModules(bigEffect(400, 20, { tweens: true }))
  assert.ok(scripted.data.length >= 2)
  for (const n of sizes(scripted)) assert.ok(n < SOURCE_CAP)
  assert.match(scripted.source, /local SPAWNS = DATA\.spawns/)
  assert.ok(scripted.data.some((d) => /\n\tspawns = \{\n\t\t\["Spawn0"\] = \{/.test(d.source)))
})

test('normal effects stay one module, and smaller than before', () => {
  for (const fx of [example('hollow-purple'), example('charge-slash'), example('ground-slam'), bigEffect(12, 6)]) {
    const m = effectModules(fx)
    assert.deepEqual(m.data, [], fx.name)
    assert.equal(luauModule(fx), m.source)
    assert.ok(sourceLength(m.source) < sourceLength(legacyModule(fx)), `${fx.name}: ${m.source.length} vs ${legacyModule(fx).length}`)
  }
})

// ------------------------------------------------------------ every path

test('bridge jobs, Live and project files carry the data parts; the job guard refuses oversized scripts', async () => {
  const huge = bigEffect(400, 20)
  const parts = effectModules(huge).data.length
  // Test in Studio / Studio checks.
  const job = vfxJob(huge, { id: 'j1' })
  const effect = job.modules.find((m) => m.name === 'Effect')!
  assert.deepEqual(effect.children!.map((c) => c.name), Array.from({ length: parts }, (_, i) => `Data${i + 1}`))
  const all = (list: BridgeModule[]): BridgeModule[] => list.flatMap((m) => [m, ...all(m.children ?? [])])
  for (const m of all(job.modules)) assert.ok(!m.source || sourceLength(m.source) < SOURCE_CAP, m.name)
  // Ability Composer jobs embed the effect modules the same way.
  const ability = normalizeAbility({ name: 'Move', events: [{ kind: 'vfx', at: 0, effect: 'big', effectName: 'Big' }] })
  const aj = abilityJob(ability, { big: huge }, null, { id: 'a1', times: [{ t: 0, label: 'a' }] })
  const vfxFolder = aj.modules.find((m) => m.name === 'VFX')!
  assert.equal(vfxFolder.children!.find((m) => m.name === 'Big')!.children!.length, parts)
  // The guard: a hand-written Timeline at the limit is a clear Forge error, not Studio's.
  const timeline: BridgeModule = { name: 'Timeline', className: 'ModuleScript', source: `return function(fx)\n${'\tfx:wait(0.01)\n'.repeat(15_000)}end\n` }
  assert.ok(sourceLength(timeline.source!) >= MAX_JOB_SOURCE)
  assert.throws(() => assertModuleSizes([{ name: 'Slash', className: 'ModuleScript', source: 'return {}', children: [timeline] }]), (e: Error) => e instanceof ModuleTooLargeError && /timeline script of Slash/.test(e.message) && /200,000/.test(e.message))
  assert.throws(() => vfxJob({ ...huge, script: timeline.source }, { id: 'j2' }), ModuleTooLargeError)
  assert.doesNotThrow(() => assertModuleSizes(job.modules))
  // Bytes, as Roblox counts them: 100,000 two-byte characters are 200,000.
  assert.throws(() => assertModuleSizes([{ name: 'X', className: 'ModuleScript', source: 'é'.repeat(100_000) }]), ModuleTooLargeError)
  // Live in Studio: the payload carries the parts and the live module makes them children.
  const live = livePayload(huge)
  assert.equal(live.data!.length, parts)
  assert.match(liveModuleSource({ port: 1, jobId: 'j', mode: 'dummy', frame: true }), /for _, d in e\.data do[\s\S]*part\.Parent = m/)
  assert.equal(livePayload(bigEffect(3, 4)).data, undefined)
  // An oversized timeline keeps the last good loop and reports why.
  const s = new LiveSchedule()
  s.enabled = true
  s.set({ key: 'a', effect: bigEffect(3, 4), label: 'A' }, 0)
  assert.equal(s.flush(1000), true)
  s.set({ key: 'a', effect: { ...bigEffect(3, 4), script: timeline.source }, label: 'A' }, 2000)
  assert.equal(s.flush(3000), false)
  assert.equal(s.version, 1)
  assert.match(s.lastError!, /timeline script/)
  // Project files (Rojo): init.luau + Data1.luau ...; stale parts go when the effect shrinks.
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-split-'))
  const root = join(dir, 'project')
  await mkdir(root, { recursive: true })
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => root, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const entry = { id: 'big', scope: 'user', kind: 'model', name: 'Big', description: '', tags: [], createdAt: 0, updatedAt: 0, origin: 'Big.rbxm', effect: huge, thumbs: [] } as never
  const files = await svc.exportFiles(entry, 'src/shared/VFX/Big')
  assert.deepEqual(files.filter((f) => /\/Data\d+\.luau$/.test(f.path)).map((f) => f.path), Array.from({ length: parts }, (_, i) => `src/shared/VFX/Big/Data${i + 1}.luau`))
  for (const f of files.filter((f) => f.path.endsWith('.luau'))) assert.ok(sourceLength(f.content) < SOURCE_CAP, f.path)
  const written = await svc.writeProjectFiles(entry)
  const folder = join(root, 'src', 'shared', 'VFX', 'Big')
  assert.equal((await readdir(folder)).filter((f) => /^Data\d+\.luau$/.test(f)).length, parts)
  await writeFile(join(folder, 'Data99.luau'), '-- mine\nreturn {}\n')
  await svc.writeProjectFiles({ ...(written as object), effect: bigEffect(3, 4) } as never)
  assert.deepEqual((await readdir(folder)).filter((f) => /^Data\d+\.luau$/.test(f)), ['Data99.luau'], 'our parts removed, a file we did not write kept')
  assert.doesNotMatch(await readFile(join(folder, 'init.luau'), 'utf8'), /load\(/)
})

// ------------------------------------------------------------ Luau

test('split and single modules compile with Luau; the old generator failed past 200 instances', { skip: !lune }, async () => {
  const huge = effectModules(bigEffect(400, 20))
  const scripted = effectModules(bigEffect(400, 20, { tweens: true }))
  const files: Record<string, string> = {
    'huge.luau': huge.source,
    'scripted.luau': scripted.source,
    'inline250.luau': effectModules(bigEffect(250, 2)).source,
    'example.luau': luauModule(example('hollow-purple')),
    'ForgeFX.luau': FORGEFX_SOURCE
  }
  huge.data.forEach((d, i) => (files[`huge_data${i + 1}.luau`] = d.source))
  scripted.data.forEach((d, i) => (files[`scripted_data${i + 1}.luau`] = d.source))
  assert.deepEqual(await compileAll(files), {})
  // The second bug: one `local iN` per instance did not compile past Luau's 200 locals.
  const old = await compileAll({ 'old250.luau': legacyModule(bigEffect(250, 2)) })
  assert.match(old['old250.luau'] ?? '', /Out of local registers/)
})

// The Lune world: plays each module (old and new generator side by side) and dumps the instance tree
// with every property assigned, plus the Emit calls and Enabled toggles the cues made.
const WORLD_RUN = `local World = require("./forge/world")
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local task = require("@lune/task")
local roblox = require("@lune/roblox")

local cases = serde.decode("json", fs.readFile("cases.json"))
local vfx = { name = "VFX", className = "Folder", children = { { name = "ForgeFX", className = "ModuleScript", filePaths = { "vfx/ForgeFX.luau" } } } }
for _, c in cases do
	local kids = {}
	for _, d in c.data do
		table.insert(kids, { name = d, className = "ModuleScript", filePaths = { "vfx/" .. c.name .. "/" .. d .. ".luau" } })
	end
	table.insert(vfx.children, { name = c.name, className = "ModuleScript", filePaths = { "vfx/" .. c.name .. "/init.luau" }, children = kids })
end
local world = World.new({ root = "", tree = { name = "ReplicatedStorage", className = "ReplicatedStorage", children = { vfx } }, log = function() end })

local finals = {}
local events = {}
local function caseOf(inst)
	return string.match(World.fullName(inst), "Stage_([%w_]+)") or "?"
end
local function event(inst, text)
	local c = caseOf(inst)
	events[c] = events[c] or {}
	table.insert(events[c], World.fullName(inst) .. " " .. text)
end
world.observer = function(inst, key, value)
	local t = finals[inst] or {}
	finals[inst] = t
	t[key] = value
	if key == "Enabled" then
		event(inst, "Enabled=" .. tostring(value))
	end
end
World.method("ParticleEmitter", "Emit", function(self, n)
	event(self, "Emit(" .. tostring(n) .. ")")
end)
-- Kept until dumped (cases of different lengths run together); the lifetime is recorded.
World.method("Debris", "AddItem", function(_self, inst, lifetime)
	event(inst, "Debris(" .. string.format("%.17g", lifetime) .. ")")
end)

local function num(x)
	return string.format("%.17g", x)
end
local function show(v)
	if World.isInstance(v) then
		return "@" .. World.fullName(v)
	end
	local t = typeof(v)
	local out = {}
	if t == "NumberSequence" then
		for _, k in v.Keypoints do
			table.insert(out, num(k.Time) .. "," .. num(k.Value) .. "," .. num(k.Envelope))
		end
	elseif t == "ColorSequence" then
		for _, k in v.Keypoints do
			table.insert(out, num(k.Time) .. "," .. num(k.Value.R) .. "," .. num(k.Value.G) .. "," .. num(k.Value.B))
		end
	elseif t == "Color3" then
		out = { num(v.R), num(v.G), num(v.B) }
	elseif t == "Vector3" then
		out = { num(v.X), num(v.Y), num(v.Z) }
	elseif t == "Vector2" then
		out = { num(v.X), num(v.Y) }
	elseif t == "NumberRange" then
		out = { num(v.Min), num(v.Max) }
	elseif t == "CFrame" then
		for _, x in { v:GetComponents() } do
			table.insert(out, num(x))
		end
	elseif t == "number" then
		out = { num(v) }
	else
		out = { tostring(v) }
	end
	return t .. "(" .. table.concat(out, " ") .. ")"
end
local function dump(inst, depth, out)
	local keys = {}
	for k in finals[inst] or {} do
		if k ~= "Name" then
			table.insert(keys, k)
		end
	end
	table.sort(keys)
	local props = {}
	for _, k in keys do
		table.insert(props, k .. "=" .. show(finals[inst][k]))
	end
	table.insert(out, string.rep(" ", depth) .. inst.ClassName .. " " .. inst.Name .. " {" .. table.concat(props, "; ") .. "}")
	for _, child in inst:GetChildren() do
		dump(child, depth + 1, out)
	end
end

local models = {}
local longest = 0
for _, c in cases do
	local folder = world.globals.Instance.new("Folder", world.globals.workspace)
	folder.Name = "Stage_" .. c.name
	local mod = world:require(world.game.ReplicatedStorage.VFX[c.name])
	models[c.name] = mod.play(roblox.CFrame.new(1, 2, 3), folder)
	longest = math.max(longest, mod.Duration)
end
task.wait(longest + 0.15)
local result = {}
for _, c in cases do
	local out = {}
	dump(models[c.name], 0, out)
	local ev = events[c.name] or {}
	table.sort(ev)
	result[c.name] = { tree = out, events = ev }
end
print(serde.encode("json", result))
`

async function worldDumps(cases: { name: string; source: string; data?: { name: string; source: string }[] }[]): Promise<Record<string, { tree: string[]; events: string[] }>> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-split-w-'))
  await mkdir(join(dir, 'forge'))
  for (const f of ['world.luau', 'signal.luau']) await copyFile(join('resources', 'lune', 'forge', f), join(dir, 'forge', f))
  await mkdir(join(dir, 'vfx'))
  await writeFile(join(dir, 'vfx', 'ForgeFX.luau'), FORGEFX_SOURCE)
  for (const c of cases) {
    await mkdir(join(dir, 'vfx', c.name))
    await writeFile(join(dir, 'vfx', c.name, 'init.luau'), c.source)
    for (const d of c.data ?? []) await writeFile(join(dir, 'vfx', c.name, `${d.name}.luau`), d.source)
  }
  await writeFile(join(dir, 'cases.json'), JSON.stringify(cases.map((c) => ({ name: c.name, data: (c.data ?? []).map((d) => d.name) }))))
  const out = await luneRun(dir, WORLD_RUN)
  return JSON.parse(out.trim().split('\n').pop()!)
}

test('built in the Lune world, the new modules (single or split) make what the old generator made', { skip: !lune }, async () => {
  const effects: Record<string, VfxEffect> = {
    plain: bigEffect(60, 8),
    loose: bigEffect(30, 5, { modelRoot: false, name: 'Loose' }),
    tweened: bigEffect(60, 8, { tweens: true }),
    purple: example('hollow-purple'),
    slash: example('charge-slash')
  }
  const cases: { name: string; source: string; data?: { name: string; source: string }[] }[] = []
  for (const [name, fx] of Object.entries(effects)) {
    const single = effectModules(fx)
    assert.deepEqual(single.data, [], name)
    // Forced split (a small cap) so the data-part path is compared on effects the old code could build.
    const split = effectModules(fx, { cap: 10_000 })
    assert.ok(split.data.length >= 2, `${name}: ${split.data.length} parts`)
    cases.push({ name: `${name}_old`, source: legacyModule(fx) }, { name: `${name}_new`, source: single.source }, { name: `${name}_split`, ...split })
  }
  // The huge effect (the old module neither fit nor compiled): split parts == one inline module.
  const huge = bigEffect(400, 20, { tweens: true })
  const hugeSplit = effectModules(huge)
  assert.ok(hugeSplit.data.length >= 2)
  cases.push({ name: 'huge_split', ...hugeSplit }, { name: 'huge_inline', source: effectModules(huge, { cap: Infinity }).source })
  const dumps = await worldDumps(cases)
  const strip = (d: { tree: string[]; events: string[] }, name: string) => JSON.stringify(d).replaceAll(`Stage_${name}`, 'Stage')
  for (const name of Object.keys(effects)) {
    const old = dumps[`${name}_old`]
    assert.ok(old.tree.length > 3 && old.events.length > 0, `${name}: ${old.tree.length} instances, ${old.events.length} events`)
    assert.equal(strip(dumps[`${name}_new`], `${name}_new`), strip(old, `${name}_old`), `${name}: new module`)
    assert.equal(strip(dumps[`${name}_split`], `${name}_split`), strip(old, `${name}_old`), `${name}: split module`)
  }
  assert.equal(dumps.huge_split.tree.length, allNodes(huge.roots).length)
  assert.equal(strip(dumps.huge_split, 'huge_split'), strip(dumps.huge_inline, 'huge_inline'))
  // Spot checks against the effect data: a 20-keypoint Size sequence and a beam reference.
  const e7 = dumps.huge_split.tree.find((l) => /ParticleEmitter E7 \{/.test(l))!
  assert.match(e7, new RegExp(`Size=NumberSequence\\((\\S+,\\S+,\\S+ ?){20}\\)`))
  assert.match(e7, /Rate=number\(47\)/, "tweened from 27 to 40 + 7")
  assert.ok(dumps.huge_split.tree.some((l) => /Beam Beam \{Attachment0=@\S*Stage_huge_split\.Big\.Part0\.Att; Attachment1=@\S*\.Part0\.Tip;/.test(l)))
  assert.ok(dumps.huge_split.events.some((e) => /E0 Emit\(5\)$/.test(e)))
})
