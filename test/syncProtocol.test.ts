// Forge Sync wire protocol: validation of what the Studio plugin sends (src/shared/sync/protocol.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseChange,
  parseChangesBody,
  parseConfigQuery,
  parseNode,
  parsePath,
  parseSnapshotBody,
  sanitizeConfig,
  SYNC_LIMITS,
  SyncProtocolError,
  utf8Length
} from '../src/shared/sync/protocol.ts'

const node = (over: Record<string, unknown> = {}) => ({ id: '1', path: ['ReplicatedStorage', 'Shared', 'Catalog'], className: 'ModuleScript', source: 'return {}\n', ...over })

test('sync protocol: a full node round-trips', () => {
  const n = node({
    className: 'Script',
    runContext: 'Server',
    attributes: { Damage: 12, Name: 'x', On: true, Tint: { Color3: [1, 0, 0] } },
    tags: ['Hitbox']
  })
  assert.deepEqual(parseNode(n), n)
  const anim = { id: '7', path: ['ReplicatedStorage', 'Animations', 'Slash'], className: 'Animation', properties: { AnimationId: 'rbxassetid://123' } }
  assert.deepEqual(parseNode(anim), anim)
  // Unknown fields are dropped.
  assert.deepEqual(parseNode({ ...anim, extra: 1 }), anim)
})

test('sync protocol: nodes are bounded', () => {
  const bad: [Record<string, unknown>, RegExp][] = [
    [node({ id: '' }), /id/],
    [node({ id: 'x'.repeat(SYNC_LIMITS.maxId + 1) }), /id/],
    [node({ path: [] }), /path/],
    [node({ path: Array(SYNC_LIMITS.maxDepth + 1).fill('A') }), /path/],
    [node({ path: ['A', ''] }), /path\[1\]/],
    [node({ path: ['A', 'x'.repeat(SYNC_LIMITS.maxName + 1)] }), /path\[1\]/],
    [node({ path: ['A', 'b\nc'] }), /control/],
    [node({ path: 'A/B' }), /path/],
    [node({ className: 'Folder; rm' }), /className/],
    [node({ className: 42 }), /className/],
    [node({ source: 5 }), /source/],
    [node({ source: 'x'.repeat(SYNC_LIMITS.maxSource + 1) }), /source is over/],
    [node({ runContext: 'Legacy' }), /runContext/],
    [node({ properties: { Size: { Vector3: [1, 2, 3], Extra: 1 } } }), /RojoType/],
    [node({ properties: { Size: [1, 2, 3] } }), /RojoType|unsupported/],
    [node({ properties: { Speed: Infinity } }), /finite/],
    [node({ properties: Object.fromEntries(Array.from({ length: SYNC_LIMITS.maxKeys + 1 }, (_, i) => [`P${i}`, 1])) }), /too many/],
    [node({ attributes: { Big: 'x'.repeat(SYNC_LIMITS.maxValue + 1) } }), /too long/],
    [node({ tags: ['a', 3] }), /tags\[1\]/],
    [node({ oversize: true }), /oversize but has a source/]
  ]
  for (const [n, re] of bad) assert.throws(() => parseNode(n), (e: unknown) => e instanceof SyncProtocolError && re.test((e as Error).message), JSON.stringify(n).slice(0, 80))
  // 2 MB in UTF-8 bytes, not characters: 700k three-byte characters are 2.1 MB.
  assert.throws(() => parseNode(node({ source: '一'.repeat(700_000) })), /source is over/)
  assert.equal(parseNode(node({ source: 'é'.repeat(1000) })).source?.length, 1000)
  const big = parseNode(node({ source: undefined, oversize: true }))
  assert.equal(big.oversize, true)
  assert.equal(big.source, undefined)
})

test('sync protocol: utf8Length counts bytes', () => {
  for (const s of ['', 'abc', 'é', '一', '😀', 'a😀é一']) assert.equal(utf8Length(s), Buffer.byteLength(s), s)
})

test('sync protocol: paths', () => {
  assert.deepEqual(parsePath(['ServerScriptService', 'Server']), ['ServerScriptService', 'Server'])
  assert.throws(() => parsePath(null), SyncProtocolError)
})

test('sync protocol: changes of every kind', () => {
  const n = node()
  assert.deepEqual(parseChange({ kind: 'source', node: n }), { kind: 'source', node: n })
  assert.deepEqual(parseChange({ kind: 'props', node: n }), { kind: 'props', node: n })
  assert.deepEqual(parseChange({ kind: 'added', node: n, descendants: [node({ id: '2' })] }), { kind: 'added', node: n, descendants: [node({ id: '2' })] })
  assert.deepEqual(parseChange({ kind: 'added', node: n }), { kind: 'added', node: n })
  assert.deepEqual(parseChange({ kind: 'removed', id: '1', path: ['A', 'B'] }), { kind: 'removed', id: '1', path: ['A', 'B'] })
  assert.deepEqual(parseChange({ kind: 'renamed', id: '1', from: ['A', 'Old'], node: n }), { kind: 'renamed', id: '1', from: ['A', 'Old'], node: n })
  assert.deepEqual(parseChange({ kind: 'moved', id: '1', from: ['A', 'Old'], node: n }), { kind: 'moved', id: '1', from: ['A', 'Old'], node: n })
  assert.throws(() => parseChange({ kind: 'deleted', id: '1' }), /kind/)
  assert.throws(() => parseChange({ kind: 'removed', id: '1' }), /path/)
  assert.throws(() => parseChange({ kind: 'moved', id: '1', node: n }), /from/)
})

test('sync protocol: snapshot and changes bodies', () => {
  const place = { placeId: 123, gameId: 9, name: 'FSF' }
  const snap = parseSnapshotBody({ session: 's1', place, seq: 0, final: false, nodes: [node()] })
  assert.deepEqual(snap, { session: 's1', place, seq: 0, final: false, nodes: [node()] })
  assert.deepEqual(parseSnapshotBody({ session: 's1', place: { placeId: 0 }, seq: 3, final: true, nodes: [] }).place, { placeId: 0 })
  assert.throws(() => parseSnapshotBody({ session: 's1', place, seq: -1, final: true, nodes: [] }), /seq/)
  assert.throws(() => parseSnapshotBody({ session: 's1', place, seq: 0, final: 'yes', nodes: [] }), /final/)
  assert.throws(() => parseSnapshotBody({ session: '', place, seq: 0, final: true, nodes: [] }), /session/)
  assert.throws(() => parseSnapshotBody({ session: 's', place: { placeId: 1.5 }, seq: 0, final: true, nodes: [] }), /placeId/)
  assert.throws(() => parseSnapshotBody({ session: 's', place, seq: 0, final: true, nodes: {} }), /nodes/)
  assert.throws(() => parseSnapshotBody({ session: 's', place, seq: 0, final: true, nodes: Array(SYNC_LIMITS.maxNodes + 1).fill(node()) }), /nodes/)
  assert.throws(() => parseSnapshotBody({ session: 's', place, seq: 0, final: true, nodes: [node(), { id: '2' }] }), /nodes\[1\]\.path/)
  assert.throws(() => parseSnapshotBody([]), /object/)

  const changes = parseChangesBody({ session: 's1', place, changes: [{ kind: 'removed', id: '4', path: ['A'] }] })
  assert.equal(changes.changes.length, 1)
  assert.throws(() => parseChangesBody({ session: 's1', place, changes: 'x' }), /changes/)
  const many = Array.from({ length: 3 }, () => ({ kind: 'added', node: node(), descendants: Array(SYNC_LIMITS.maxNodes / 2).fill(node()) }))
  assert.throws(() => parseChangesBody({ session: 's1', place, changes: many }), /descendants/)
})

test('sync protocol: config query and config answer', () => {
  assert.deepEqual(parseConfigQuery(new URLSearchParams('placeId=42&gameId=7&place=My%20Game')), { placeId: 42, gameId: 7, place: 'My Game' })
  assert.deepEqual(parseConfigQuery(new URLSearchParams('placeId=0&place=')), { placeId: 0 })
  assert.throws(() => parseConfigQuery(new URLSearchParams('')), /placeId/)
  assert.throws(() => parseConfigQuery(new URLSearchParams('placeId=-1')), /placeId/)
  assert.throws(() => parseConfigQuery(new URLSearchParams('placeId=1&gameId=x')), /gameId/)
  assert.equal(parseConfigQuery(new URLSearchParams(`placeId=1&place=${'x'.repeat(500)}`)).place?.length, SYNC_LIMITS.maxPlaceName)

  assert.deepEqual(sanitizeConfig({ enabled: false, sessionToken: 'secret', roots: [['A']] }), { enabled: false })
  assert.deepEqual(sanitizeConfig({ enabled: true, sessionToken: 't', roots: [['ReplicatedStorage', 'Shared'], [], [1 as unknown as string]], skip: undefined }), {
    enabled: true,
    sessionToken: 't',
    roots: [['ReplicatedStorage', 'Shared']],
    skip: []
  })
})
