// Explorer > New > UI: UI Labs story/storybook templates (Vide), and the same files run through
// the real UI Preview (lune + vendored Vide fixture) when lune is available.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { storyCovered, storyFile, storyFilesKey, storybookFile } from '../src/shared/storyTemplates.ts'
import { findLune } from '../src/main/services/tests/index.ts'
import { UiPreviewService } from '../src/main/services/uiPreview/service.ts'

test('story template: Vide story with controls, a centered Frame and a TextLabel', () => {
  const f = storyFile('src/shared/Interface/Hud', 'Ammo')
  assert.equal(f.path, 'src/shared/Interface/Hud/Ammo.story.luau')
  const c = f.contents
  assert.match(c, /^local ReplicatedStorage = game:GetService\("ReplicatedStorage"\)\n/)
  assert.match(c, /local Vide = require\(ReplicatedStorage\.Packages\.Vide\)/)
  assert.match(c, /\tvide = Vide,/)
  assert.match(c, /\tcontrols = \{\n\t\tText = "Ammo",\n\t\tVisible = true,\n\t\},/)
  assert.match(c, /\tstory = function\(props\)\n\t\treturn create "Frame" \{/)
  assert.match(c, /AnchorPoint = Vector2\.new\(0\.5, 0\.5\)/)
  assert.match(c, /Position = UDim2\.fromScale\(0\.5, 0\.5\)/)
  assert.match(c, /create "TextLabel" \{[^}]*Text = props\.controls\.Text,/)
  assert.match(c, /Visible = props\.controls\.Visible,/)
  assert.match(c, /\nreturn story\n$/)
  assert.doesNotMatch(c, /--/, 'no comments')
  assert.doesNotMatch(c, /function\(props:/, 'props stays unannotated')
  assert.doesNotMatch(c, /\r/)
})

test('storybook template: storyRoots is the folder it lives in', () => {
  const f = storybookFile('src/shared/Interface', 'Interface')
  assert.equal(f.path, 'src/shared/Interface/Interface.storybook.luau')
  assert.equal(f.contents, 'local storybook = {\n\tname = "Interface",\n\tstoryRoots = {\n\t\tscript.Parent,\n\t},\n}\n\nreturn storybook\n')
})

test('storyCovered: real storybook vs Unknown stories vs not listed', () => {
  const list = {
    storybooks: [
      { name: 'UI', file: 'src/shared/UI/UI.storybook.luau', stories: [{ file: 'src/shared/UI/A.story.luau' }] },
      { name: 'Unknown stories', stories: [{ file: 'src/shared/Lab/B.story.luau' }] }
    ]
  }
  assert.equal(storyCovered(list, 'src/shared/UI/A.story.luau'), true)
  assert.equal(storyCovered(list, 'src/shared/Lab/B.story.luau'), false)
  assert.equal(storyCovered(list, 'src/shared/Lab/C.story.luau'), null)
  const fallback = { storybooks: [{ name: 'Stories', stories: [{ file: 'x/D.story.luau' }] }] }
  assert.equal(storyCovered(fallback, 'x/D.story.luau'), false)
})

test('storyFilesKey changes only when story files change', () => {
  const tree = [{ filePath: undefined, children: [{ filePath: 'src/a.luau', children: [] }, { filePath: 'src/A.story.luau', children: [] }] }]
  const k = storyFilesKey(tree)
  assert.equal(k, 'src/A.story.luau')
  tree[0].children.push({ filePath: 'src/b.luau', children: [] })
  assert.equal(storyFilesKey(tree), k)
  tree[0].children.push({ filePath: 'src/S.storybook.luau', children: [] })
  assert.equal(storyFilesKey(tree), 'src/A.story.luau\nsrc/S.storybook.luau')
})

const lune = findLune(process.env.LUNE_PATH || null)
const skip = lune ? false : 'lune not found; skipping story template preview test'

test('generated story renders in UI Preview; storybook template covers it', { skip, timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-story-tpl-'))
  try {
    cpSync(resolve(import.meta.dirname, 'fixtures', 'ui-preview-project'), root, { recursive: true })
    const dir = 'src/shared/Interface/Lab'
    mkdirSync(join(root, dir), { recursive: true })
    const story = storyFile(dir, 'Card')
    writeFileSync(join(root, story.path), story.contents)
    const s = new UiPreviewService({ lunePath: () => lune, projectFile: () => 'default.project.json' })
    s.setRoot(root)
    assert.equal(storyCovered(await s.listStories(), story.path), false)

    const out = await s.render({ file: story.path, width: 800, height: 600 })
    assert.equal(out.error, undefined, out.error)
    assert.equal(out.kind, 'vide')
    assert.deepEqual(out.console.filter((c) => c.level === 'error'), [])
    const label = out.tree.nodes.find((n) => n.cls === 'TextLabel')
    assert.equal(label?.props.Text, 'Card')
    const relabeled = await s.render({ file: story.path, width: 800, height: 600, controls: { Text: 'Hello', Visible: false } })
    assert.equal(relabeled.tree.nodes.find((n) => n.cls === 'TextLabel')?.props.Text, 'Hello')
    assert.equal(relabeled.tree.nodes.find((n) => n.cls === 'Frame' && n.name === 'Frame')?.props.Visible, false)

    const book = storybookFile(dir, 'Lab')
    writeFileSync(join(root, book.path), book.contents)
    const list = await s.listStories()
    assert.equal(storyCovered(list, story.path), true)
    assert.ok(list.storybooks.find((b) => b.name === 'Lab')?.stories.some((x) => x.name === 'Card'), JSON.stringify(list))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
