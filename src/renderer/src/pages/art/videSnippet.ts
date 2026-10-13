// Vide ImageLabel snippet for an uploaded image, and inserting it into a component file open in
// Monaco (as an unsaved edit, so the person reviews it and Cmd+Z undoes it).
import { monaco } from '../../monaco'

export const IMAGES_REQUIRE = 'local Images = require(ReplicatedStorage.Shared.Assets.Images)'

export function videImageLabel(name: string, opts: { width?: number; height?: number; indent?: string } = {}): string {
  const i = opts.indent ?? ''
  const t = '\t'
  const w = opts.width ?? 128
  const h = opts.height ?? 128
  return [
    `${i}create "ImageLabel" {`,
    `${i}${t}Name = "${name}",`,
    `${i}${t}BackgroundTransparency = 1,`,
    `${i}${t}Size = UDim2.fromOffset(${w}, ${h}),`,
    `${i}${t}Image = Images.${name},`,
    `${i}${t}ScaleType = Enum.ScaleType.Fit,`,
    `${i}},`
  ].join('\n')
}

// Candidate component files: Luau modules under UI-looking folders.
export function isComponentPath(path: string): boolean {
  return /\.luau?$/.test(path) && /^src\/(client|shared)\//.test(path) && /(Interface|UI|Ui|Components?|Screens?|Hud|HUD|Views?|Widgets?|Menus?)\//.test(path) && !/\.(spec|story|storybook)\.luau?$/.test(path)
}

const pathOf = (m: monaco.editor.ITextModel) => m.uri.path.replace(/^\/+/, '')

async function waitForModel(path: string, ms = 3000): Promise<monaco.editor.ITextModel | null> {
  const end = Date.now() + ms
  for (;;) {
    const m = monaco.editor.getModels().find((x) => pathOf(x) === path)
    if (m) return m
    if (Date.now() > end) return null
    await new Promise((r) => setTimeout(r, 60))
  }
}

// Inserts the snippet at the cursor when the editor already shows this file with the cursor placed,
// else after the first "children = {" line, else above the last "return". Adds the Images require
// after the last top-level require when missing. Returns the 1-based line it inserted at.
export async function insertIntoComponent(path: string, name: string, open: (path: string) => Promise<void>): Promise<number | null> {
  const before = monaco.editor.getEditors().find((e) => e.getModel() && pathOf(e.getModel()!) === path)
  const cursor = before?.getPosition()
  await open(path)
  const model = await waitForModel(path)
  if (!model) return null
  const editor = monaco.editor.getEditors().find((e) => e.getModel() === model) ?? null
  const lines = model.getLinesContent()
  let line: number
  if (cursor && (cursor.lineNumber > 1 || cursor.column > 1)) line = cursor.lineNumber + 1
  else {
    const kids = lines.findIndex((l) => /\bchildren\s*=\s*\{\s*$/.test(l))
    if (kids >= 0) line = kids + 2
    else {
      let ret = -1
      lines.forEach((l, i) => /^return\b/.test(l) && (ret = i))
      line = ret >= 0 ? ret + 1 : lines.length + 1
    }
  }
  const prev = lines[Math.max(0, line - 2)] ?? ''
  const indent = (/^(\s*)/.exec(prev)?.[1] ?? '') + (/\{\s*$/.test(prev) ? '\t' : '')
  const edits: monaco.editor.IIdentifiedSingleEditOperation[] = []
  const text = videImageLabel(name, { indent }) + '\n'
  edits.push({ range: new monaco.Range(line, 1, line, 1), text, forceMoveMarkers: true })
  let shift = 0
  if (!lines.some((l) => /Assets\.Images\b/.test(l) && /require/.test(l))) {
    let last = -1
    lines.forEach((l, i) => /^local\s+\w+\s*=\s*require\(/.test(l) && (last = i))
    const at = last >= 0 ? last + 2 : 1
    edits.push({ range: new monaco.Range(at, 1, at, 1), text: IMAGES_REQUIRE + '\n' })
    if (at <= line) shift = 1
  }
  if (editor) {
    editor.pushUndoStop()
    editor.executeEdits('forge-art', edits)
    editor.pushUndoStop()
    editor.setPosition({ lineNumber: line + shift, column: indent.length + 1 })
    editor.revealLineInCenter(line + shift)
  } else model.pushEditOperations([], edits, () => null)
  return line + shift
}
