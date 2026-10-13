// Edit mode writes: find the literal for an element's property in the story or one of the
// project modules it loaded, rewrite it, and save. When the file is open in an editor tab, the
// change goes through that Monaco model (one undo step, Ctrl+Z in the editor reverts it);
// otherwise it is written to disk directly. Either way the page keeps its own undo stack, and the
// preview's file watcher hot-reloads the story.
import * as monaco from 'monaco-editor'
import type { UiValue } from '@shared/types'
import { applyEdit, planPropertyEdit, position, type EditPlan, type TextEdit } from '@shared/uiPreview/edit'

export interface StoreBits {
  files: { path: string; current: string; loading?: boolean }[]
  editFile(path: string, contents: string): void
  saveFile(path: string): Promise<void>
}

export interface AppliedEdit {
  file: string
  line: number
  how: Extract<EditPlan, { ok: true }>['how']
  // Inverse, for undo: replace `after` at `start` with `before`.
  start: number
  before: string
  after: string
  label: string
  viaEditor: boolean
}

export type EditOutcome = { ok: true; edit: AppliedEdit } | { ok: false; reason: string; file?: string; line?: number; expression?: string }

function modelFor(path: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && m.uri.path.replace(/^\/+/, '') === path && !m.isDisposed()) ?? null
}

async function readSource(path: string, store: StoreBits): Promise<string | null> {
  const model = modelFor(path)
  if (model) return model.getValue()
  const open = store.files.find((f) => f.path === path && !f.loading)
  if (open) return open.current
  try {
    return await window.harness.readFile(path)
  } catch {
    return null
  }
}

async function writeText(path: string, src: string, edit: TextEdit, store: StoreBits, label: string): Promise<boolean> {
  const model = modelFor(path)
  const next = applyEdit(src, edit)
  if (model && model.getValue() === src) {
    const a = position(src, edit.start)
    const b = position(src, edit.end)
    model.pushStackElement()
    model.pushEditOperations([], [{ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: edit.text, forceMoveMarkers: true }], () => null)
    model.pushStackElement()
    store.editFile(path, model.getValue())
    await store.saveFile(path)
    void label
    return true
  }
  await window.harness.writeFile(path, next)
  if (store.files.some((f) => f.path === path)) store.editFile(path, next)
  return false
}

// Candidate files: the story first, then project modules it required (not Packages).
export function candidateFiles(story: string, modules: string[]): string[] {
  const rest = modules.filter((m) => m !== story && !/^Packages\//.test(m) && !/(^|\/)_Index\//.test(m) && /\.luau?$/.test(m))
  return [story, ...rest]
}

export async function applyPropertyEdit(o: { files: string[]; name: string; cls: string; prop: string; current: UiValue | undefined; value: UiValue; store: StoreBits }): Promise<EditOutcome> {
  let best: Extract<EditOutcome, { ok: false }> | null = null
  for (const file of o.files) {
    const src = await readSource(file, o.store)
    if (src == null) continue
    const plan = planPropertyEdit(src, { name: o.name, cls: o.cls, ...(o.current !== undefined ? { current: o.current } : {}) }, o.prop, o.value)
    if (plan.ok) {
      const label = `${o.name}.${o.prop}`
      const viaEditor = await writeText(file, src, plan.edit, o.store, label)
      return { ok: true, edit: { file, line: plan.line, how: plan.how, start: plan.edit.start, before: src.slice(plan.edit.start, plan.edit.end), after: plan.edit.text, label, viaEditor } }
    }
    // Prefer the most specific failure: a computed expression in a file that names the element.
    if (!best || (plan.expression && !best.expression)) best = { ok: false, reason: plan.reason, file, ...(plan.line ? { line: plan.line } : {}), ...(plan.expression ? { expression: plan.expression } : {}) }
  }
  return best ?? { ok: false, reason: 'the story source could not be read' }
}

export async function undoEdit(edit: AppliedEdit, store: StoreBits): Promise<boolean> {
  const src = await readSource(edit.file, store)
  if (src == null || src.slice(edit.start, edit.start + edit.after.length) !== edit.after) return false
  await writeText(edit.file, src, { start: edit.start, end: edit.start + edit.after.length, text: edit.before }, store, `undo ${edit.label}`)
  return true
}
