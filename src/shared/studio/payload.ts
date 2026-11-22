// Builds Forge Bridge jobs (snapshot, rbxmx helpers) using standalone XML/attribute decoding.

import { parseXml, type XmlEl } from './rbxmx.ts'
import { KEY_COLOR } from './crop.ts'
import { BRIDGE_VERSION, type BridgeJob, type InstanceJson, type PropJson } from './protocol.ts'

// Where the plugin puts the job's modules (CoreGui: not saved with the place, not synced by Forge Sync).
export const JOB_ROOT = ['CoreGui', 'ForgeBridgeJob']

const CF_KEYS = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']

function propOf(el: XmlEl): PropJson | null {
  const kids = (n: string) => el.children.find((c) => c.name === n)?.text ?? '0'
  switch (el.name) {
    case 'string':
    case 'ProtectedString':
      return { t: 'string', v: el.text }
    case 'bool':
      return { t: 'bool', v: el.text.trim() === 'true' }
    case 'float':
    case 'double':
    case 'int':
    case 'int64':
      return { t: 'number', v: Number(el.text) || 0 }
    case 'token':
      return { t: 'token', v: Number(el.text) || 0 }
    case 'CoordinateFrame':
      return { t: 'cframe', v: CF_KEYS.map((k) => Number(kids(k)) || 0) }
    case 'Vector3':
      return { t: 'vector3', v: [Number(kids('X')) || 0, Number(kids('Y')) || 0, Number(kids('Z')) || 0] }
    case 'Color3':
      return { t: 'color3', v: [Number(kids('R')) || 0, Number(kids('G')) || 0, Number(kids('B')) || 0] }
    default:
      return null
  }
}

function itemOf(el: XmlEl): InstanceJson {
  const props: Record<string, PropJson> = {}
  let name = el.attrs.class ?? 'Folder'
  const propsEl = el.children.find((c) => c.name === 'Properties')
  for (const p of propsEl?.children ?? []) {
    const key = p.attrs.name
    if (!key) continue
    const v = propOf(p)
    if (!v) continue
    if (key === 'Name' && v.t === 'string') name = v.v
    else props[key] = v
  }
  return { className: el.attrs.class ?? 'Folder', name, props, children: el.children.filter((c) => c.name === 'Item').map(itemOf) }
}

// Top-level items of an .rbxmx document as plain instance data.
export function rbxmxToInstances(xml: string): InstanceJson[] {
  const root = parseXml(xml)
  const doc = root.children.find((c) => c.name === 'roblox') ?? root
  return doc.children.filter((c) => c.name === 'Item').map(itemOf)
}

// Capture the user's own Studio viewport as it is (no stage, camera unchanged).
export function snapshotJob(opts: { id: string; name?: string }): BridgeJob {
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'snapshot',
    mode: 'stepped',
    name: opts.name ?? 'Viewport snapshot',
    rig: 'R15',
    duration: 0,
    beats: [{ t: 0, label: 'view' }],
    camera: { pos: [0, 0, 0], target: [0, 0, -1], fov: 70 },
    modules: [],
    calibrate: true,
    key: KEY_COLOR,
    linger: 0,
    timeout: 20
  }
}
