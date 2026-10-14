// UI Motion Lab service: the effect-stack library (user + project), Figma imports (plugin JSON or a
// Figma link through the REST API, token from the secret store), the scratch lab story the preview
// runs, "describe the feel" compose (default tier), the critique of captured preview frames (critic
// tier, UI principles measured in code), ratings feeding memory + principle weights, and the export
// of the compiled client module (+ a story) into the project. No electron imports: the model, the
// secret store, fetch and the preview check come in as functions.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { UiComponentRef, UiMotionComposeResult, UiMotionCritique, UiMotionEntry, UiMotionExportResult, UiMotionScope, UiMotionStatus, FigmaImportResult, FigmaTokenStatus } from '../../../shared/uiMotionTypes.ts'
import { applyChanges, composePrompt, critiquePrompt, heuristicStack, parseComposeAnswer, parseCritique, UI_COMPOSE_SYSTEM, UI_CRITIC_SYSTEM, UI_MOTION_GUIDE, type UiMotionVision } from '../../../shared/uimotion/ai.ts'
import { componentModule, requireBetween, storybookModule, storyModule } from '../../../shared/uimotion/codegen.ts'
import { compileMotionModule, labStoryLuau, type LabSubject } from '../../../shared/uimotion/compile.ts'
import { mapFigmaNode, walkInst, type MappingReport } from '../../../shared/uimotion/figma/map.ts'
import { FigmaRest, FigmaRestError, parseFigmaUrl, type FetchLike } from '../../../shared/uimotion/figma/rest.ts'
import { parseForgeFigmaDoc, type FigmaNode } from '../../../shared/uimotion/figma/types.ts'
import { describeSpec, luauName, normalizeSpec, type MotionSpec } from '../../../shared/uimotion/spec.ts'
import { storyExportPlan, storySnippet } from '../../../shared/uimotion/story.ts'
import { uiPrincipleChecks } from '../../../shared/principles/uiChecks.ts'
import { principleIds, scoresForRating } from '../../../shared/principles/attach.ts'
import { buildCritique } from '../../../shared/uimotion/critique.ts'
import { parsePlanObject, principleCriticBlock, principlePlan } from '../../../shared/principles/select.ts'
import type { PrincipleHooks, PrincipleWeights } from '../../../shared/principles/types.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import type { LabGate } from '../../../shared/gating/hooks.ts'
import { rephraseNote } from '../../../shared/gating/gates.ts'
import { composeWithGate } from '../../../shared/gating/compose.ts'
import { criticBrief, restatementBlock } from '../../../shared/restate/prompt.ts'
import { normalizeRestatement, type Restatement } from '../../../shared/restate/types.ts'
import { instanceOf, planLayout, projectTree } from './layout.ts'
import { PROJECT_UIMOTION_DIR, uiMotionId, UiMotionStore } from './store.ts'

export interface ImagePayload {
  mime: string
  base64: string
}
export type ModelFn = (system: string, prompt: string, images: ImagePayload[]) => Promise<string>

export interface MemoryLike {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<{ entry: { name: string } }>
}

export interface SecretsLike {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export const FIGMA_TOKEN_KEY = 'figma.token'

export interface UiMotionServiceDeps {
  // userData/uimotion (the user library is <userDir>/library).
  userDir: string
  projectRoot: () => string | null
  // The active place's Rojo project file (repo-relative), for instance paths.
  projectFile?: () => string | null
  model?: (tier: LabTier) => ModelFn | null
  memory?: MemoryLike
  principles?: PrincipleHooks
  gate?: LabGate
  secrets?: SecretsLike
  canStoreSecrets?: () => boolean
  fetch?: FetchLike
  lune?: () => Promise<boolean>
  emit?: (event: 'uimotion:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
}

export class UiMotionServiceError extends Error {}

const COMPONENTS_FILE = 'components.json'
const LAB_DIR = 'lab'
// A require expression the lab story may embed: game:GetService("X") followed by .Name / ["Name"].
const REQUIRE_RE = /^game:GetService\("[A-Za-z]+"\)(\.[A-Za-z_][A-Za-z0-9_]*|\["[^"\\\n]{1,80}"\]){0,20}$/

function dataUrlBytes(url: string): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(url ?? ''))
  return m ? Buffer.from(m[1], 'base64') : null
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false
  )
}

export class UiMotionService {
  readonly user: UiMotionStore
  private deps: UiMotionServiceDeps
  private projectStore: { root: string; store: UiMotionStore } | null = null
  private now: () => number
  private guideSaved = false

  constructor(deps: UiMotionServiceDeps) {
    this.deps = deps
    this.user = new UiMotionStore('user', join(deps.userDir, 'library'))
    this.now = deps.now ?? Date.now
  }

  get userLibraryDir(): string {
    return this.user.dir
  }

  project(): UiMotionStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) this.projectStore = { root, store: new UiMotionStore('project', join(root, ...PROJECT_UIMOTION_DIR.split('/'), 'library')) }
    return this.projectStore.store
  }

  private changed(): void {
    this.deps.emit?.('uimotion:changed', { at: this.now() })
  }

  private needRoot(): string {
    const root = this.deps.projectRoot()
    if (!root) throw new UiMotionServiceError('Open the game project first: imports and exports are written into it.')
    return root
  }

  private within(root: string, rel: string): string {
    const p = resolve(root, rel)
    if (!p.startsWith(resolve(root) + sep)) throw new UiMotionServiceError(`path escapes the project: ${rel}`)
    return p
  }

  // ------------------------------------------------------------ library

  async list(): Promise<UiMotionEntry[]> {
    const p = this.project()
    return [...(p ? await p.list() : []), ...(await this.user.list())]
  }

  async find(id: string): Promise<{ entry: UiMotionEntry; store: UiMotionStore } | null> {
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      const e = await s.read(id).catch(() => null)
      if (e) return { entry: e, store: s }
    }
    return null
  }

  async get(id: string): Promise<UiMotionEntry> {
    const hit = await this.find(String(id))
    if (!hit) throw new UiMotionServiceError(`no motion stack "${id}"`)
    return hit.entry
  }

  async status(): Promise<UiMotionStatus> {
    const p = this.project()
    const root = this.deps.projectRoot()
    return {
      projectRoot: root,
      compose: !!this.deps.model?.('default'),
      vision: !!this.deps.model?.('critic'),
      lune: (await this.deps.lune?.().catch(() => false)) ?? false,
      figmaToken: !!(await this.token()),
      entries: { user: (await this.user.list()).length, project: p ? (await p.list()).length : 0 },
      uiDir: root ? (await planLayout(root)).uiDir : null
    }
  }

  async save(raw: unknown, opts: { id?: string; origin?: string; scope?: UiMotionScope; component?: string; story?: string; name?: string; restatement?: Restatement } = {}): Promise<UiMotionEntry> {
    const prev = opts.id ? await this.find(opts.id) : null
    if (opts.id && !prev) throw new UiMotionServiceError(`no motion stack "${opts.id}"`)
    const spec = normalizeSpec(raw, opts.name ?? prev?.entry.name ?? 'Motion')
    if (opts.name) spec.name = luauName(opts.name)
    const store = prev?.store ?? (opts.scope === 'user' ? this.user : (this.project() ?? this.user))
    const now = this.now()
    const entry: UiMotionEntry = {
      ...(prev?.entry ?? { createdAt: now, thumbs: [], tags: [], origin: opts.origin ?? 'manual' }),
      id: prev?.entry.id ?? uiMotionId(spec.name),
      scope: store.scope,
      name: spec.name,
      description: describeSpec(spec).slice(0, 300),
      updatedAt: now,
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.component ? { component: opts.component } : {}),
      ...(opts.story ? { story: checkStoryFile(opts.story) } : {}),
      ...(opts.restatement ? { restatement: opts.restatement } : {}),
      spec
    } as UiMotionEntry
    const saved = await store.save(entry)
    this.changed()
    return saved
  }

  async remove(id: string): Promise<boolean> {
    const hit = await this.find(id)
    if (!hit) return false
    const ok = await hit.store.remove(id)
    this.changed()
    return ok
  }

  async file(id: string, file: string): Promise<string | null> {
    const hit = await this.find(id)
    if (!hit) return null
    const bytes = await hit.store.readFile(id, file).catch(() => null)
    return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null
  }

  // ------------------------------------------------------------ components (imported UI)

  private componentsPath(root: string): string {
    return join(root, ...PROJECT_UIMOTION_DIR.split('/'), COMPONENTS_FILE)
  }

  async components(): Promise<UiComponentRef[]> {
    const root = this.deps.projectRoot()
    if (!root) return []
    try {
      const list = JSON.parse(await readFile(this.componentsPath(root), 'utf8')) as UiComponentRef[]
      const out: UiComponentRef[] = []
      for (const c of Array.isArray(list) ? list : []) if (c && typeof c.module === 'string' && (await exists(join(root, c.module)))) out.push(c)
      return out.sort((a, b) => b.importedAt - a.importedAt)
    } catch {
      return []
    }
  }

  async component(name: string): Promise<UiComponentRef | null> {
    return (await this.components()).find((c) => c.name === name) ?? null
  }

  private async saveComponent(root: string, ref: UiComponentRef): Promise<void> {
    const list = (await this.components()).filter((c) => c.name !== ref.name)
    const p = this.componentsPath(root)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify([ref, ...list], null, 1), 'utf8')
  }

  // ------------------------------------------------------------ Figma token (never leaves main)

  private async token(): Promise<string | null> {
    return ((await this.deps.secrets?.get(FIGMA_TOKEN_KEY).catch(() => undefined)) ?? '').trim() || null
  }

  async tokenStatus(): Promise<FigmaTokenStatus> {
    return { set: !!(await this.token()), canStore: this.deps.canStoreSecrets?.() ?? !!this.deps.secrets }
  }

  async setToken(token: string): Promise<FigmaTokenStatus> {
    const t = String(token ?? '').trim()
    if (!this.deps.secrets) throw new UiMotionServiceError('No secret store on this computer.')
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) throw new UiMotionServiceError('That does not look like a Figma personal access token (figd_...).')
    await this.deps.secrets.set(FIGMA_TOKEN_KEY, t)
    this.changed()
    return this.tokenStatus()
  }

  async clearToken(): Promise<FigmaTokenStatus> {
    await this.deps.secrets?.delete(FIGMA_TOKEN_KEY)
    this.changed()
    return this.tokenStatus()
  }

  private async rest(): Promise<FigmaRest> {
    const token = await this.token()
    if (!token) throw new UiMotionServiceError('No Figma token: add one under Settings > Integrations > Figma (or use the Figma plugin and paste its JSON).')
    if (!this.deps.fetch) throw new UiMotionServiceError('No network client.')
    return new FigmaRest({ token, fetch: this.deps.fetch })
  }

  async testToken(): Promise<{ ok: boolean; message: string }> {
    try {
      const me = await (await this.rest()).me()
      return { ok: true, message: `Token works (signed in as ${me.handle || 'unknown'}).` }
    } catch (e) {
      // GET /v1/me needs current_user:read; a file_content:read-only token is fine for imports.
      if (e instanceof FigmaRestError && e.status === 403 && !/invalid/i.test(e.message)) return { ok: true, message: 'Token accepted; it has no current_user:read scope (not needed: imports use file_content:read).' }
      return { ok: false, message: (e as Error).message }
    }
  }

  // ------------------------------------------------------------ Figma import

  async importFigmaDoc(json: string, opts: { name?: string } = {}): Promise<FigmaImportResult> {
    const doc = parseForgeFigmaDoc(String(json ?? ''))
    return this.importNode(doc.root, {
      name: opts.name,
      source: 'figma-plugin',
      from: `Figma plugin: ${doc.source.fileName ? `${doc.source.fileName} / ` : ''}${doc.source.nodeName}`,
      image: async (req) => {
        const b64 = doc.images[req.key]
        return b64 ? Buffer.from(b64, 'base64') : null
      }
    })
  }

  async importFigmaUrl(url: string, opts: { name?: string } = {}): Promise<FigmaImportResult> {
    const link = parseFigmaUrl(String(url ?? ''))
    if (!link) throw new UiMotionServiceError('Not a Figma link. Copy it with right-click > Copy/Paste as > Copy link to selection.')
    if (!link.nodeId) throw new UiMotionServiceError('The link has no node-id: select the frame or component in Figma and use "Copy link to selection".')
    const api = await this.rest()
    const key = link.branchKey ?? link.fileKey
    const node = await api.getNode(key, link.nodeId)
    let renders: Record<string, string | null> | null = null
    let fills: Record<string, string> | null = null
    const failed: string[] = []
    return this.importNode(node.document, {
      name: opts.name,
      source: 'figma-link',
      from: `Figma file ${key}${node.name ? ` (${node.name})` : ''}, node ${link.nodeId}`,
      prepare: async (report) => {
        const renderIds = report.images.filter((r) => r.kind === 'render').map((r) => r.ref)
        if (renderIds.length) renders = await api.renderImages(key, renderIds, { scale: 2 })
        if (report.images.some((r) => r.kind === 'fill')) fills = await api.imageFills(key)
      },
      image: async (req) => {
        const src = req.kind === 'render' ? renders?.[req.ref] : fills?.[req.ref]
        if (!src) return null
        try {
          return Buffer.from(await api.download(src))
        } catch (e) {
          failed.push(`${req.node}: ${(e as Error).message}`)
          return null
        }
      }
    })
  }

  private async importNode(
    root: FigmaNode,
    o: { name?: string; source: UiComponentRef['source']; from: string; prepare?: (report: MappingReport) => Promise<void>; image: (req: MappingReport['images'][number]) => Promise<Buffer | null> }
  ): Promise<FigmaImportResult> {
    const projectRoot = this.needRoot()
    const name = luauName(o.name || root.name || 'Component', 'Component')
    const layout = await planLayout(projectRoot)
    const mapped = mapFigmaNode(root, { name, imageDir: `art/ui/${name}` })
    const report = mapped.report
    const warnings: string[] = []
    const files: string[] = []
    await o.prepare?.(report)
    for (const req of report.images) {
      const bytes = await o.image(req)
      if (!bytes) {
        warnings.push(`image for "${req.node}" was not exported (${req.kind === 'render' ? 'render' : 'image fill'}); the ImageLabel points at ${req.file}`)
        continue
      }
      const p = this.within(projectRoot, req.file)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, bytes)
      files.push(req.file)
    }
    const tree = await projectTree(projectRoot, this.deps.projectFile?.() ?? null)
    const moduleFile = `${layout.components}/${name}.luau`
    const storyFile = `${layout.stories}/${name}.story.luau`
    const moduleInst = instanceOf(tree, moduleFile)
    const storyInst = instanceOf(tree, storyFile)
    if (!moduleInst) warnings.push(`${layout.components} is not mapped in the project file: Rojo / Forge Sync will not sync it`)
    await this.writeText(projectRoot, moduleFile, componentModule(mapped.root, { from: o.from, report }))
    files.push(moduleFile)
    const component = requireBetween(storyInst, moduleInst, { from: storyFile, to: moduleFile })
    await this.writeText(projectRoot, storyFile, storyModule({ name, component }))
    files.push(storyFile)
    if (!layout.storybookExists) {
      await this.writeText(projectRoot, layout.storybook, storybookModule(luauName(layout.uiDir.split('/').pop() ?? 'Interface')))
      files.push(layout.storybook)
    }
    const elements: UiComponentRef['elements'] = []
    walkInst(mapped.root, (i, path) => {
      if (elements.length < 60 && !/^UI(Corner|Stroke|Gradient|Padding|ListLayout|FlexItem|Scale|AspectRatioConstraint|SizeConstraint|GridLayout)$/.test(i.className)) elements.push({ path, className: i.className })
    })
    const ref: UiComponentRef = { name, module: moduleFile, story: storyFile, instance: moduleInst, elements, source: o.source, from: o.from, importedAt: this.now(), summary: report.summary }
    await this.saveComponent(projectRoot, ref)
    this.changed()
    return { component: ref, files, report, warnings }
  }

  private async writeText(root: string, rel: string, text: string): Promise<void> {
    const p = this.within(root, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, text, 'utf8')
  }

  // ------------------------------------------------------------ lab story

  async labStory(subject: LabSubject): Promise<{ file: string }> {
    const root = this.needRoot()
    if (!subject || (subject.kind !== 'component' && subject.kind !== 'story')) throw new UiMotionServiceError('bad lab subject')
    if (!REQUIRE_RE.test(String(subject.require ?? ''))) throw new UiMotionServiceError('The component is not mapped into the game (no require path): map its folder in the project file.')
    const name = luauName(subject.name || 'Subject')
    const dir = join(root, ...PROJECT_UIMOTION_DIR.split('/'), LAB_DIR)
    await mkdir(dir, { recursive: true })
    // Scratch files: never part of the game or git.
    if (!(await exists(join(dir, '.gitignore')))) await writeFile(join(dir, '.gitignore'), '*\n', 'utf8')
    const rel = `${PROJECT_UIMOTION_DIR}/${LAB_DIR}/${name}.story.luau`
    const src = labStoryLuau({ kind: subject.kind, require: subject.require, name })
    const cur = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (cur !== src) await writeFile(join(root, rel), src, 'utf8')
    return { file: rel }
  }

  // ------------------------------------------------------------ compose

  async compose(brief: string, opts: { restatement?: Restatement; component?: string; story?: string; elements?: { path: string; className: string }[]; target?: string; current?: MotionSpec } = {}): Promise<UiMotionComposeResult> {
    const text = String(brief ?? '').trim()
    if (text.length < 3) throw new UiMotionServiceError('Describe the feel, e.g. "snappy shop button with a shine every few seconds".')
    const restatement = normalizeRestatement(opts.restatement) ?? undefined
    const story = opts.story ? checkStoryFile(opts.story) : null
    const comp = !story && opts.component ? await this.component(opts.component) : null
    // A story source: the elements of its rendered tree; the picked one stands in for the root.
    const target = story && opts.target ? String(opts.target) : ''
    const elements = story ? (opts.elements ?? []).filter((e) => e && typeof e.path === 'string' && e.path).slice(0, 120).map((e) => ({ path: String(e.path), className: String(e.className ?? '') })) : (comp?.elements.filter((e) => e.path) ?? [])
    const notes: string[] = []
    const subject = comp?.name ?? (story ? storyNameOf(story) : '')
    const fallbackName = luauName(`${subject} ${text.split(/\s+/).slice(0, 3).join(' ')}`, 'Motion')
    let spec: MotionSpec
    let source: 'model' | 'heuristic' = 'heuristic'
    const model = this.deps.model?.('default')
    const h = heuristicStack(text, target)
    spec = { ...h.spec, name: fallbackName }
    if (model) {
      const liked = (await this.list()).filter((e) => e.rating === 'up').slice(0, 2).map((e) => ({ name: e.name, spec: e.spec }))
      const prompt = composePrompt({
        brief: text,
        restatement: restatementBlock(restatement),
        elements,
        current: opts.current ? normalizeSpec(opts.current) : null,
        liked,
        plan: principlePlan('uimotion', text, { weights: await this.principleWeights() })
      })
      const paths = elements.map((e) => e.path)
      try {
        const done = await composeWithGate({
          lab: 'uimotion',
          gate: this.deps.gate,
          ask: () => model(UI_COMPOSE_SYSTEM, prompt, []),
          check: async (raw) => {
            const r = parseComposeAnswer(raw, paths, fallbackName)
            return r.ok ? { ok: true as const, value: r } : { ok: false as const, kind: r.kind, message: r.message }
          },
          repair: (raw, message) => model(UI_COMPOSE_SYSTEM, `${prompt}\n\nYour answer:\n${raw.slice(0, 4000)}\nwas rejected: ${message}\nFix it and answer with the whole corrected JSON.`, []),
          rephrase: () => model(UI_COMPOSE_SYSTEM, `${prompt}\n\n${rephraseNote('json')}`, [])
        })
        spec = done.value.spec
        source = 'model'
        if (done.value.notes) notes.push(done.value.notes)
        const plan = parsePlanObject(done.value.plan)
        if (Object.keys(plan).length) notes.push(`plan: ${Object.entries(plan).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
      } catch (e) {
        notes.push(`model stack unusable (${(e as Error).message}); started from the "${h.preset}" preset`)
        this.deps.log?.(`uimotion: compose model: ${(e as Error).message}`, 'stderr')
      }
    } else notes.push(`no model: started from the "${h.preset}" preset`)
    // The story's slot is not an element: a root target means the picked element.
    if (story && target) spec = normalizeSpec({ ...spec, targets: spec.targets.map((t) => (t.path === '' ? { ...t, path: target } : t)) }, spec.name)
    const entry = await this.save(spec, { origin: text, ...(comp ? { component: comp.name } : {}), ...(story ? { story } : {}), ...(restatement ? { restatement } : {}) })
    await this.ensureSkill()
    return { entry, source, notes }
  }

  async ensureSkill(): Promise<void> {
    if (this.guideSaved || !this.deps.memory) return
    this.guideSaved = true
    await this.deps.memory
      .remember({ scope: 'user', kind: 'skill', name: 'ui-motion-feel', description: 'How Roblox UI motion should feel: spring model, 100 ms feedback, press-in, overshoot restraint, reduced motion (UI Motion Lab)', body: UI_MOTION_GUIDE.slice(0, 7900) }, 'agent')
      .catch((e) => {
        this.guideSaved = false
        this.deps.log?.(`uimotion: guide skill: ${(e as Error).message}`, 'stderr')
      })
  }

  // ------------------------------------------------------------ critique

  async critique(id: string, opts: { frames?: string[]; labels?: string[]; apply?: boolean } = {}): Promise<{ entry: UiMotionEntry; critique: UiMotionCritique; applied: string[] }> {
    const hit = await this.find(id)
    if (!hit) throw new UiMotionServiceError(`no motion stack "${id}"`)
    const spec = hit.entry.spec
    const weights = await this.principleWeights()
    const request = criticBrief(hit.entry.origin === 'manual' ? '' : hit.entry.origin, hit.entry.restatement)
    const checks = uiPrincipleChecks(spec)
    const ids = principleIds('uimotion', request)
    const pngs = (opts.frames ?? []).map(dataUrlBytes).filter((b): b is Buffer => !!b).slice(0, 8)
    const labels = (opts.labels ?? []).map((l) => String(l).slice(0, 40))
    const frames: string[] = []
    let vision: UiMotionVision | undefined
    let raw: string | undefined
    const model = this.deps.model?.('critic')
    if (model && pngs.length) {
      const prev = hit.entry.critique
      const prevFrames: Buffer[] = []
      const gate = this.deps.gate
      if (gate && prev?.vision) for (const f of prev.frames) {
        const b = await hit.store.readFile(id, f).catch(() => null)
        if (b) prevFrames.push(b)
      }
      const g = gate ? await gate.beforeCritique({ lab: 'uimotion', entryId: id, iteration: 1, frames: pngs, previousFrames: prevFrames, previousScore: prev?.vision ? prev.overall : null, changes: 0, threshold: 7.5 }) : null
      for (const [i, png] of pngs.entries()) {
        const f = `frames/critique-${i + 1}.png`
        await hit.store.writeFile(id, f, png)
        frames.push(f)
      }
      if (g?.skip && prev?.vision) vision = { ...prev.vision, changes: [], summary: `Critic skipped (${g.reason ?? 'frames unchanged'}): scores carried over. ${prev.vision.summary}`.slice(0, 600) }
      else {
        try {
          const measured = Object.fromEntries(checks.filter((c) => ids.includes(c.id)).map((c) => [c.id, c]))
          const block = principleCriticBlock(ids, { weights, measured, focus: hit.entry.critique?.focus })
          raw = await model(UI_CRITIC_SYSTEM, critiquePrompt({ brief: request, spec, frames: pngs.map((_, i) => labels[i] ?? `frame ${i + 1}`), principles: block }), pngs.map((p) => ({ mime: 'image/png', base64: p.toString('base64') })))
          vision = parseCritique(raw)
          if (gate) await gate.afterCritique({ lab: 'uimotion', entryId: id, iteration: 1, score: vision.overall, threshold: 7.5, remaining: 0, changes: vision.changes.length, summary: vision.summary })
        } catch (e) {
          this.deps.log?.(`uimotion: vision critique unavailable (${(e as Error).message}); principle checks only`, 'stderr')
        }
      }
    }
    const critique = buildCritique(spec, request, { at: this.now(), raw, vision, weights, frames })
    let next = spec
    const applied: string[] = []
    if (opts.apply && critique.vision?.changes.length) {
      const res = applyChanges(spec, critique.vision.changes)
      next = res.spec
      applied.push(...res.applied)
    }
    const entry = await hit.store.save({ ...hit.entry, spec: next, description: describeSpec(next).slice(0, 300), critique, updatedAt: this.now(), thumbs: frames.length ? [frames[Math.min(1, frames.length - 1)]] : hit.entry.thumbs })
    this.changed()
    return { entry, critique, applied }
  }

  // ------------------------------------------------------------ rating

  async rate(id: string, rating: 'up' | 'down' | null): Promise<UiMotionEntry> {
    const hit = await this.find(id)
    if (!hit) throw new UiMotionServiceError(`no motion stack "${id}"`)
    const e: UiMotionEntry = { ...hit.entry, updatedAt: this.now() }
    if (rating) e.rating = rating
    else delete e.rating
    if (rating === 'up') e.quality = 'good'
    else if (rating === 'down') e.quality = 'avoid'
    else delete e.quality
    const saved = await hit.store.save(e)
    await this.recordPrinciples(saved, rating).catch((err) => this.deps.log?.(`uimotion: principle feedback: ${(err as Error).message}`, 'stderr'))
    if (this.deps.memory && rating) {
      const up = rating === 'up'
      const body = [
        up ? `A UI motion stack the user liked in the UI Motion Lab ("${saved.origin}"). Reuse its feel for similar UI.` : `A UI motion stack the user disliked ("${saved.origin}"). Avoid these choices.`,
        saved.critique ? `Critique (${saved.critique.overall}/10): ${saved.critique.summary.slice(0, 300)}` : '',
        describeSpec(saved.spec),
        up ? '```json' : '',
        up ? JSON.stringify({ reducedMotion: saved.spec.reducedMotion, targets: saved.spec.targets }).slice(0, 5000) : '',
        up ? '```' : ''
      ]
        .filter(Boolean)
        .join('\n')
      await this.deps.memory
        .remember(up ? { scope: 'user', kind: 'skill', name: `ui-motion-example-${saved.name}`.slice(0, 60), description: `Liked UI motion: ${saved.origin}`.slice(0, 200), body: body.slice(0, 7900) } : { scope: 'user', kind: 'memory', type: 'feedback', name: `ui-motion-avoid-${saved.name}`.slice(0, 60), description: `Disliked UI motion: ${saved.origin}`.slice(0, 200), body: body.slice(0, 2900) }, 'user')
        .catch((err) => this.deps.log?.(`uimotion: rating memory: ${(err as Error).message}`, 'stderr'))
    }
    this.changed()
    return saved
  }

  private async recordPrinciples(e: UiMotionEntry, rating: 'up' | 'down' | null): Promise<void> {
    const p = this.deps.principles
    if (!p) return
    if (!rating) return void (await p.forget?.('uimotion', e.id))
    const scores = scoresForRating(e.critique?.principles, () => uiPrincipleChecks(e.spec))
    await p.record({ lab: 'uimotion', entryId: e.id, name: e.name, rating, scores })
  }

  private async principleWeights(): Promise<PrincipleWeights> {
    return (await this.deps.principles?.weights().catch(() => ({}))) ?? {}
  }

  // ------------------------------------------------------------ export

  async export(id: string, opts: { component?: string; story?: string } = {}): Promise<UiMotionExportResult> {
    const root = this.needRoot()
    const entry = await this.get(id)
    const spec = entry.spec
    if (!spec.targets.some((t) => t.effects.length)) throw new UiMotionServiceError('The stack is empty: add an effect first.')
    const layout = await planLayout(root)
    const tree = await projectTree(root, this.deps.projectFile?.() ?? null)
    const warnings: string[] = []
    const name = luauName(spec.name)
    const moduleFile = `${layout.motion}/${name}Effects.luau`
    const story = opts.story ? checkStoryFile(opts.story) : !opts.component && !entry.component && entry.story ? entry.story : null
    if (story) return this.exportStory(root, id, entry, { story, moduleFile, tree, layoutMotion: layout.motion })
    await this.writeText(root, moduleFile, compileMotionModule(spec, { source: `${entry.component ? `${entry.component} / ` : ''}${entry.name}` }))
    const files = [moduleFile]
    const moduleInst = instanceOf(tree, moduleFile)
    if (!moduleInst) warnings.push(`${layout.motion} is not mapped in the project file: Rojo / Forge Sync will not sync it`)
    let storyFile: string | undefined
    const comp = (opts.component ?? entry.component) ? await this.component(String(opts.component ?? entry.component)) : null
    if (comp) {
      storyFile = `${layout.stories}/${comp.name}${name === comp.name ? 'Motion' : name}.story.luau`
      const storyInst = instanceOf(tree, storyFile)
      const component = requireBetween(storyInst, comp.instance, { from: storyFile, to: comp.module })
      const effects = requireBetween(storyInst, moduleInst, { from: storyFile, to: moduleFile })
      await this.writeText(root, storyFile, storyModule({ name: `${comp.name} + ${name}`, component, effects }))
      files.push(storyFile)
      if (!layout.storybookExists) {
        await this.writeText(root, layout.storybook, storybookModule(luauName(layout.uiDir.split('/').pop() ?? 'Interface')))
        files.push(layout.storybook)
      }
      const paths = new Set(comp.elements.map((e) => e.path))
      for (const t of spec.targets) if (t.path && !paths.has(t.path)) warnings.push(`target "${t.path}" is not in ${comp.name}; that part of the stack does nothing`)
    } else warnings.push('no component chosen: wrote the module only (require it and call Effects.attach(button))')
    const requirePath = moduleInst ? absoluteRequirePath(moduleInst) : null
    const hit = await this.find(id)
    if (hit) await hit.store.save({ ...hit.entry, written: { module: moduleFile, ...(storyFile ? { story: storyFile } : {}), at: this.now() } })
    this.changed()
    return { files, module: moduleFile, ...(storyFile ? { story: storyFile } : {}), requirePath, warnings }
  }

  // A story source: only the module (every target rebased to its own attach root) and the lines the
  // user adds to their own component. Their story and component files are left alone.
  private async exportStory(root: string, id: string, entry: UiMotionEntry, o: { story: string; moduleFile: string; tree: Awaited<ReturnType<typeof projectTree>>; layoutMotion: string }): Promise<UiMotionExportResult> {
    const plan = storyExportPlan(entry.spec)
    const warnings: string[] = []
    await this.writeText(root, o.moduleFile, compileMotionModule(plan.spec, { source: `${storyNameOf(o.story)} story / ${entry.name}`, stacks: plan.stacks }))
    const moduleInst = instanceOf(o.tree, o.moduleFile)
    if (!moduleInst) warnings.push(`${o.layoutMotion} is not mapped in the project file: Rojo / Forge Sync will not sync it`)
    const requirePath = moduleInst ? absoluteRequirePath(moduleInst) : null
    const snippet = storySnippet({ requirePath, module: o.moduleFile, attach: plan.attach })
    const hit = await this.find(id)
    if (hit) await hit.store.save({ ...hit.entry, written: { module: o.moduleFile, at: this.now() } })
    this.changed()
    return { files: [o.moduleFile], module: o.moduleFile, requirePath, warnings, snippet, attach: plan.attach }
  }
}

function absoluteRequirePath(inst: string[]): string {
  return `game:GetService(${JSON.stringify(inst[0])})${inst.slice(1).map((p) => (/^[A-Za-z_]\w*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join('')}`
}

// A repo-relative *.story.luau path (the story a stack was designed on).
function checkStoryFile(file: string): string {
  const f = String(file ?? '').replace(/\\/g, '/').trim()
  if (!/\.story\.luau?$/.test(f) || f.startsWith('/') || f.split('/').includes('..') || f.length > 400) throw new UiMotionServiceError(`not a story file: ${f.slice(0, 120)}`)
  return f
}

function storyNameOf(file: string): string {
  return luauName((file.split('/').pop() ?? '').replace(/\.story\.luau?$/, ''), 'Story')
}
