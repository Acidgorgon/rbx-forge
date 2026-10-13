// Roblox class glyphs (SPEC §5): 16px, 1.3px stroke, 12–16% tint. Scripts are a folded page in the
// realm colour of where they live (server blue, client green, shared purple) with a class mark.
import type { ReactNode } from 'react'
import type { Realm } from '../lib/roblox'

const REALM: Record<Realm, string> = {
  server: 'var(--realm-server)',
  client: 'var(--realm-client)',
  shared: 'var(--realm-shared)',
  studio: 'var(--realm-studio)'
}

const tint = (c: string, pct = 14) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

function Svg({ size, children, label }: { size: number; children: ReactNode; label: string }) {
  return (
    <svg className="cg" width={size} height={size} viewBox="0 0 16 16" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-label={label} style={{ flex: 'none' }}>
      {children}
    </svg>
  )
}

function page(c: string, inner: ReactNode) {
  return (
    <>
      <path d="M3.5 1.8h6.2l2.8 2.8v9.6h-9z" stroke={c} strokeWidth="1.3" fill={tint(c)} />
      <path d="M9.6 1.8v2.9h2.9" stroke={c} strokeWidth="1.3" />
      {inner}
    </>
  )
}

const SERVICE_REALM: Record<string, Realm | undefined> = {
  ReplicatedStorage: 'shared',
  ReplicatedFirst: 'client',
  ServerScriptService: 'server',
  ServerStorage: 'server',
  StarterGui: 'client',
  StarterPack: 'client',
  StarterPlayerScripts: 'client',
  StarterCharacterScripts: 'client'
}
const NEUTRAL_SERVICES = new Set(['Lighting', 'SoundService', 'Teams', 'Chat', 'TextChatService', 'Players', 'MaterialService', 'LocalizationService', 'TestService'])
const STUDIO_CLASSES = new Set(['Model', 'Tool', 'Part', 'MeshPart', 'UnionOperation', 'SpawnLocation', 'Accessory', 'Animation', 'Decal', 'Texture', 'ProximityPrompt', 'Attachment'])
const GUI_CLASSES = new Set(['ScreenGui', 'Frame', 'ImageLabel', 'TextLabel', 'TextButton', 'ImageButton', 'ScrollingFrame', 'SurfaceGui', 'BillboardGui'])

export function ClassIcon({ className, realm, size = 16 }: { className: string; realm?: Realm; size?: number }) {
  const c = realm ? REALM[realm] : undefined
  switch (className) {
    case 'Script': {
      const col = c ?? REALM.server
      return <Svg size={size} label="Script">{page(col, <path d="M5.8 8.2h4.4M5.8 10.6h3" stroke={col} strokeWidth="1.3" />)}</Svg>
    }
    case 'LocalScript': {
      const col = c ?? REALM.client
      return (
        <Svg size={size} label="LocalScript">
          {page(col, <><circle cx="8" cy="8.1" r="1.2" stroke={col} strokeWidth="1.2" /><path d="M5.6 12c.4-1.2 1.3-1.8 2.4-1.8s2 .6 2.4 1.8" stroke={col} strokeWidth="1.2" /></>)}
        </Svg>
      )
    }
    case 'ModuleScript': {
      const col = c ?? REALM.shared
      return <Svg size={size} label="ModuleScript">{page(col, <path d="M8 6.8l2.2 1.2v2.4L8 11.6l-2.2-1.2V8z" stroke={col} strokeWidth="1.15" />)}</Svg>
    }
    case 'Folder': {
      const col = 'var(--fg-muted)'
      return (
        <Svg size={size} label="Folder">
          <path d="M1.8 4.2c0-.6.4-1 1-1h3.5l1.4 1.5h5.5c.6 0 1 .4 1 1v6.6c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1z" stroke={col} strokeWidth="1.3" fill={tint(col, 16)} />
        </Svg>
      )
    }
    case 'Workspace':
      return (
        <Svg size={size} label="Workspace">
          <path d="M8 1.8l5.6 3.1v6.2L8 14.2l-5.6-3.1V4.9z" stroke="#7fb3e6" strokeWidth="1.3" fill="rgba(127,179,230,.14)" />
          <path d="M2.5 5 8 8l5.5-3M8 8v6" stroke="#7fb3e6" strokeWidth="1.3" />
        </Svg>
      )
    case 'StarterPlayer':
    case 'Players':
    case 'Player':
      return (
        <Svg size={size} label={className}>
          <circle cx="8" cy="5.5" r="2.5" stroke={REALM.client} strokeWidth="1.3" />
          <path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2" stroke={REALM.client} strokeWidth="1.3" />
        </Svg>
      )
    case 'Package':
    case 'WallyPackage':
      return (
        <Svg size={size} label="Package">
          <path d="m8 1.8 5.5 3v6.4L8 14.2l-5.5-3V4.8z" stroke="var(--fg-muted)" strokeWidth="1.3" />
          <path d="m2.6 4.9 5.4 3 5.4-3M8 7.9v6.2" stroke="var(--fg-muted)" strokeWidth="1.3" />
        </Svg>
      )
    case 'Blink':
    case 'RemoteEvent':
    case 'UnreliableRemoteEvent':
    case 'RemoteFunction': {
      const col = className === 'RemoteFunction' ? REALM.server : className === 'UnreliableRemoteEvent' ? 'var(--realm-studio)' : REALM.client
      return (
        <Svg size={size} label={className}>
          <path d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z" stroke={col} strokeWidth="1.3" fill={className === 'Blink' ? undefined : tint(col)} />
        </Svg>
      )
    }
    case 'Model':
      return (
        <Svg size={size} label="Model">
          <rect x="2.5" y="2.5" width="6" height="6" rx="1" stroke={REALM.studio} strokeWidth="1.3" />
          <rect x="7.5" y="7.5" width="6" height="6" rx="1" stroke={REALM.studio} strokeWidth="1.3" fill={tint(REALM.studio)} />
        </Svg>
      )
    case 'Tool':
      return (
        <Svg size={size} label="Tool">
          <path d="M3 13l6.5-6.5M9 3.5l3.5 3.5-2 2L7 5.5z" stroke={REALM.studio} strokeWidth="1.3" />
        </Svg>
      )
    case 'Sound':
    case 'SoundGroup':
      return (
        <Svg size={size} label={className}>
          <path d="M6 11.5V3.5l6-1.5v8" stroke="var(--fg-muted)" strokeWidth="1.3" />
          <circle cx="4.6" cy="11.6" r="1.6" stroke="var(--fg-muted)" strokeWidth="1.3" />
          <circle cx="10.6" cy="10.1" r="1.6" stroke="var(--fg-muted)" strokeWidth="1.3" />
        </Svg>
      )
  }
  if (SERVICE_REALM[className] !== undefined || NEUTRAL_SERVICES.has(className) || className.endsWith('Service')) {
    const r = SERVICE_REALM[className]
    const col = c ?? (r ? REALM[r] : 'var(--fg-muted)')
    return (
      <Svg size={size} label={className}>
        <rect x="2" y="2.5" width="12" height="11" rx="2" stroke={col} strokeWidth="1.3" fill={tint(col, 12)} />
        <path d="M2 6h12" stroke={col} strokeWidth="1.3" />
        <circle cx="4.3" cy="4.25" r=".5" fill={col} />
      </Svg>
    )
  }
  if (GUI_CLASSES.has(className)) {
    const col = c ?? 'var(--fg-muted)'
    return (
      <Svg size={size} label={className}>
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke={col} strokeWidth="1.3" fill={tint(col, 10)} />
        <path d="M4.5 6h4M4.5 8.5h7" stroke={col} strokeWidth="1.2" />
      </Svg>
    )
  }
  if (STUDIO_CLASSES.has(className)) {
    return (
      <Svg size={size} label={className}>
        <path d="M8 2.2l5 2.8v6L8 13.8 3 11V5z" stroke={REALM.studio} strokeWidth="1.3" fill={tint(REALM.studio, 10)} />
      </Svg>
    )
  }
  const col = c ?? 'var(--fg-faint)'
  return (
    <Svg size={size} label={className}>
      <rect x="3" y="3" width="10" height="10" rx="2" stroke={col} strokeWidth="1.3" fill={tint(col, 10)} />
    </Svg>
  )
}

// Glyph for an open file (tabs, palette): by extension and realm.
export function FileGlyph({ path, size = 16 }: { path: string; size?: number }) {
  if (path.endsWith('.blink')) return <ClassIcon className="Blink" size={size} />
  const realm = /^src\/server\//.test(path) ? 'server' : /^src\/client\//.test(path) ? 'client' : /^src\/shared\//.test(path) ? 'shared' : undefined
  const cls = /\.server\.luau?$/.test(path) ? 'Script' : /\.client\.luau?$/.test(path) ? 'LocalScript' : /\.luau?$/.test(path) ? 'ModuleScript' : 'File'
  if (cls === 'File') {
    return (
      <svg className="cg" width={size} height={size} viewBox="0 0 16 16" fill="none" style={{ flex: 'none' }} aria-hidden>
        <path d="M3.5 1.8h6.2l2.8 2.8v9.6h-9z" stroke="var(--fg-muted)" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    )
  }
  return <ClassIcon className={cls} realm={realm} size={size} />
}
