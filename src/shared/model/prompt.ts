// What the Model Lab tells the AI: the BlockyKit API (read from the kit source itself, so the prompt
// follows the kit as it grows), the build-script contract, the block-model style rules, a template
// script as the worked example, and the critic's "compare and fix" instructions. Also reads the
// script and the critic's notes out of an answer. No electron imports.

import type { ModelBuild, ModelTemplateId } from './types.ts'

export const PART_BUDGET = 2500
// Scripts longer than this are sent back to be shortened (Roblox refuses a Source of 200,000+).
export const MAX_SCRIPT_CHARS = 150_000

export interface KitFunction {
  name: string
  signature: string
  doc: string
}

// `function Kit:name(...)` / `function Kit.name(...)` with the comment block right above it.
export function kitApi(source: string): KitFunction[] {
  const lines = String(source ?? '').split(/\r?\n/)
  const out: KitFunction[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^function\s+Kit([:.])([A-Za-z_]\w*)\s*(\(.*)$/.exec(lines[i])
    if (!m) continue
    const doc: string[] = []
    for (let j = i - 1; j >= 0; j--) {
      const c = /^\s*--+\s?(.*)$/.exec(lines[j])
      if (!c || /^─/.test(c[1].trim()) || /^!/.test(c[1])) break
      doc.unshift(c[1].trim())
    }
    out.push({ name: m[2], signature: `Kit${m[1]}${m[2]}${m[3].replace(/\s*$/, '')}`, doc: doc.join(' ').replace(/\s+/g, ' ').trim() })
  }
  return out
}

export function kitApiText(source: string): string {
  return kitApi(source)
    .map((f) => `- ${f.signature}${f.doc ? `\n  ${f.doc}` : ''}`)
    .join('\n')
}

export const TEMPLATE_INFO: Record<ModelTemplateId, { label: string; blurb: string; prompt: string }> = {
  creature: { label: 'Creature', blurb: 'A plated creature with a curved ring body, jaws, fins or limbs and a Motor6D rig.', prompt: 'a plated shark creature' },
  guard: { label: 'Guard', blurb: 'A guard beast; in Studio it can copy an existing guard\'s gameplay pieces (kit:wireGuard).', prompt: 'a spiky four-legged guard beast' },
  egg: { label: 'Egg', blurb: 'A voxel egg coloured per voxel (spots, bands, a face), same-colour runs merged.', prompt: 'a pig egg' }
}

export const STYLE_RULES = `Style (the hand-made Blender "block model" look):
- Bodies follow a curved spine (kit:spine) made of ellipse rings of overlapping plates (kit:body / kit:ring), coloured by sin(angle) around the ring: dark top, mid flank, light belly.
- Dark groove rings between the plate rings (opts.groove = true) and raised panels on the upper flank (opts.panels = true); a bright belly edge (opts.bellyEdge) where it fits.
- Spikes, fins, horns, claws, ears and crests are chunky volumetric 3D shapes (kit:horn, kit:spike, kit:pyramid, kit:tuft), never flat plates.
- Teeth are 45-degree diamonds half-buried in a lip strip so a triangle shows (kit:jaw / kit:tooth).
- Limbs are segmented (kit:limb, or stacked kit:frustum) with dark joint lines between segments.
- Big blocks are bevelled (kit:bevel) or tapered (kit:frustum); no large raw boxes.
- Eggs are voxel eggs (kit:voxelEgg) coloured per voxel (spots, bands, a face); same-colour runs merge on their own.
- Neighbouring parts never share one flat colour: nudge them with kit:vary.
- Rig: an anchored, invisible root part set as model.PrimaryPart; bones are invisible parts joined with kit:motor (Motor6D); every visible part is welded to a bone (pass the bone to kit:part and the kit helpers); an AnimationController with an Animator in the model.
- Keep it under ~${PART_BUDGET} parts (the Lab shows the count). Use loops and helper functions, never long unrolled lists of parts.`

export const SCRIPT_CONTRACT = `The script (one ModuleScript next to BlockyKit):
\`\`\`lua
local Kit = require(script.Parent.BlockyKit)

return function(model: Model, ctx)
	local kit = Kit.new(model, ctx.origin, 7) -- a fixed seed keeps the look stable
	-- build here, in model-local studs: the model stands on y = 0 at the origin, faces -Z, +Y is up
end
\`\`\`
ctx.origin: CFrame where the model is built (Forge's preview: the origin; Studio: the floor in front of the camera). Give the kit model-local CFrames; Kit.new places them with ctx.origin.
ctx.guard: Model? (Studio only, nil in the preview): an existing guard of the place to copy gameplay pieces from with kit:wireGuard. Call wireGuard only when ctx.guard is set.
ctx.areaId: string?; ctx.preview: true in Forge's preview.
Rules: only BlockyKit can be required; no game, workspace, services, yields, scripts or remotes (this is a visual model; gameplay comes from wireGuard copying an existing guard). Build synchronously into \`model\`. The script must stay under ${MAX_SCRIPT_CHARS.toLocaleString('en-US')} characters.`

export function systemPrompt(opts: { kitSource: string; template: ModelTemplateId; templateScript?: string }): string {
  const info = TEMPLATE_INFO[opts.template] ?? TEMPLATE_INFO.creature
  return [
    'You build blocky, plated, voxel-style Roblox models out of Parts for the RBX Forge Model Lab: creatures, guards and eggs in the look of hand-made Blender "block models". You write one Luau build script on the BlockyKit library.',
    SCRIPT_CONTRACT,
    STYLE_RULES,
    `BlockyKit API (model-local frames: -Z forward, +Y up):\n${kitApiText(opts.kitSource)}`,
    opts.templateScript ? `A working ${info.label.toLowerCase()} script to learn the kit from (change everything that the request asks to be different):\n\`\`\`lua\n${opts.templateScript.trim()}\n\`\`\`` : '',
    'Answer with the complete script in one ```lua fence. Before the fence, at most 4 short lines saying what you built.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function composePrompt(opts: { prompt: string; template: ModelTemplateId; refs: number; current?: string }): string {
  const info = TEMPLATE_INFO[opts.template] ?? TEMPLATE_INFO.creature
  return [
    `Make: ${opts.prompt.trim()}`,
    `Kind: ${info.label} (${info.blurb})`,
    opts.refs ? `${opts.refs} reference image${opts.refs === 1 ? '' : 's'} attached: match their silhouette, proportions, colours and signature features in the block style.` : '',
    opts.current ? `Start from the current script and change it to match the request:\n\`\`\`lua\n${opts.current.trim()}\n\`\`\`` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function repairPrompt(base: string, script: string, problem: string): string {
  return `${base}\n\nYour script:\n\`\`\`lua\n${script.slice(0, MAX_SCRIPT_CHARS)}\n\`\`\`\nfailed: ${problem}\nFix it and answer with the whole corrected script in one \`\`\`lua fence.`
}

export const NO_CHANGES = 'NO CHANGES'

export function criticPrompt(opts: { prompt: string; template: ModelTemplateId; views: string[]; refs: number; script: string; build: ModelBuild; round: number; rounds: number }): string {
  const info = TEMPLATE_INFO[opts.template] ?? TEMPLATE_INFO.creature
  const s = opts.build.stats
  return [
    `Request: ${opts.prompt.trim()} (${info.label})`,
    `Critic round ${opts.round} of ${opts.rounds}. The first ${opts.views.length} images are your current model rendered in Forge's preview (${opts.views.join(', ')}; it faces -Z, the floor is y = 0)${opts.refs ? `; the last ${opts.refs} are the user's reference images` : ''}.`,
    `Build: ${opts.build.parts.length} parts${s ? `, ${s.motors} Motor6Ds, ${s.loose} loose parts` : ''}.${opts.build.warnings.length ? ` Checks: ${opts.build.warnings.join(' | ')}` : ''}`,
    `Compare the model with the request${opts.refs ? ' and the references' : ''}: silhouette and proportions, the colour layout (dark top, light belly), the signature features, the block-model style rules, and anything that looks broken (floating or intersecting pieces, spikes pointing the wrong way, flat plates where volume belongs). Then fix the script.`,
    `Current script:\n\`\`\`lua\n${opts.script.trim()}\n\`\`\``,
    `Answer with up to 4 lines "- what you change", then the whole revised script in one \`\`\`lua fence. If it already matches and nothing is worth changing, answer "${NO_CHANGES}" and one line why.`
  ].join('\n\n')
}

// The script in an answer: the last lua / luau fence (critics may quote code first), else text from
// "local Kit" / "return function".
export function extractScript(raw: string): string | null {
  const text = String(raw ?? '')
  const fences = [...text.matchAll(/```(?:lua|luau)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]).filter((c) => /return\s+function/.test(c))
  let code = fences.length ? fences[fences.length - 1] : ''
  if (!code) {
    const at = text.search(/local\s+Kit\s*=|return\s+function\s*\(/)
    if (at >= 0) code = text.slice(at).replace(/```\s*$/, '')
  }
  code = code.trim()
  return code && /return\s+function/.test(code) ? `${code}\n` : null
}

// The critic's notes (lines before the fence) and whether it asked for no change.
export function parseCritic(raw: string): { noChange: boolean; summary: string; script: string | null } {
  const text = String(raw ?? '').trim()
  const script = extractScript(text)
  const before = text.split('```')[0]
  const noChange = !script && new RegExp(`\\b${NO_CHANGES}\\b`, 'i').test(text)
  const lines = before
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l && !new RegExp(`^${NO_CHANGES}$`, 'i').test(l))
  const summary = lines.join('; ').slice(0, 600) || (noChange ? 'kept as it is' : script ? 'revised the script' : 'no usable answer')
  return { noChange, summary, script }
}

// A short name from the request ("a spiky shark guard" -> "Spiky Shark Guard").
export function modelName(prompt: string, fallback = 'Block Model'): string {
  const words = String(prompt ?? '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(a|an|the|with|and|of|make|me|please|some)$/i.test(w))
    .slice(0, 4)
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 60) : fallback
}
