// Auto-import relevance for luau-lsp completions (src/renderer/src/lsp/completionFilter.ts).
// Item shapes follow luau-lsp 1.70.1's createSuggestRequire / createSuggestService.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMMON_SERVICES, filterCompletionItems, isVendoredAutoImport } from '../src/renderer/src/lsp/completionFilter.ts'
import { defaultSettings } from '../src/renderer/src/lsp/index.ts'

const edit = (newText: string) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText })
const requireItem = (label: string, path: string) => ({
  label,
  kind: 9,
  detail: path,
  labelDetails: { description: path },
  insertText: label,
  sortText: '999',
  additionalTextEdits: [edit(`local ${label} = require(${path})\n`)]
})

test('drops auto-imports of modules inside Packages/_Index, keeps re-exports and game modules', () => {
  const items = [
    { label: 'print', kind: 3 },
    { label: 'printidentity', kind: 3 },
    requireItem('vide', 'ReplicatedStorage.Packages._Index["alicesaidhi_vide@0.4.0"].vide'),
    requireItem('videx', 'ReplicatedStorage.Packages._Index["ukendio_videx@0.1.0"].videx'),
    requireItem('Vide', 'ReplicatedStorage.Packages.Vide'),
    requireItem('Videcharm', 'Packages.Videcharm'),
    requireItem('validateType', 'ServerScriptService.ServerPackages._Index["evaera_t@3.0.0"].t.validateType'),
    requireItem('visibility_cascade', 'Packages._Index.foo.visibility_cascade'),
    requireItem('PrGame', 'ReplicatedStorage.Shared.PrGame'),
    // String requires (completion.imports.stringRequires).
    requireItem('signal', '"@Packages/_Index/sleitnick_signal@2.0.0/signal"'),
    requireItem('Util', '"./Util"'),
    { label: 'VideoService', kind: 7, detail: 'Auto-import', additionalTextEdits: [edit('local VideoService = game:GetService("VideoService")\n')] },
    // Member access on the folder itself is not an auto-import: kept.
    { label: '_Index', kind: 5, detail: 'Folder' },
    { label: 'centau_vide@0.4.0', kind: 5, detail: 'Packages._Index' }
  ]
  const kept = filterCompletionItems(items).map((i) => i.label)
  assert.deepEqual(kept, ['print', 'printidentity', 'Vide', 'Videcharm', 'PrGame', 'Util', 'VideoService', '_Index', 'centau_vide@0.4.0'])
})

test('detects _Index only as a path segment, also via the require edit', () => {
  assert.equal(isVendoredAutoImport({ label: 'x', additionalTextEdits: [edit('local x = require(script.Parent._Index.x)\n')] }), true)
  assert.equal(isVendoredAutoImport({ label: 'x', detail: 'Packages\\_Index\\x', additionalTextEdits: [edit('')] }), true)
  assert.equal(isVendoredAutoImport(requireItem('My_Index', 'ReplicatedStorage.Shared.My_Index')), false)
  assert.equal(isVendoredAutoImport(requireItem('Search_IndexBuilder', 'ReplicatedStorage.Search_IndexBuilder')), false)
  assert.equal(isVendoredAutoImport({ label: 'x', detail: 'Packages._Index.x' }), false, 'no edit: not an auto-import')
})

test('returns the same array when nothing is dropped', () => {
  const items = [{ label: 'a' }, requireItem('B', 'ReplicatedStorage.B')]
  assert.equal(filterCompletionItems(items), items)
  assert.deepEqual(filterCompletionItems([]), [])
})

test('settings: service auto-imports limited to common services, _Index ignored', () => {
  const imports = (defaultSettings() as any).completion.imports
  assert.equal(imports.suggestServices, true)
  assert.deepEqual(imports.includedServices, COMMON_SERVICES)
  for (const s of ['Players', 'ReplicatedStorage', 'RunService', 'TweenService', 'UserInputService', 'Workspace']) assert.ok(imports.includedServices.includes(s), s)
  for (const s of ['ProcessInstancePhysicsService', 'PlatformFriendsService', 'PermissionsService', 'VideoCaptureService', 'PerformanceControlService']) {
    assert.ok(!imports.includedServices.includes(s), s)
  }
  assert.equal(new Set(COMMON_SERVICES).size, COMMON_SERVICES.length)
  assert.deepEqual(imports.ignoreGlobs, ['**/_Index/**'])
  // A copy, so callers merging settings cannot mutate the shared list.
  imports.includedServices.push('X')
  assert.ok(!COMMON_SERVICES.includes('X'))
})
