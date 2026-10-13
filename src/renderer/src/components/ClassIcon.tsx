// Tiny colored glyph per Roblox className (Explorer + Scripts lists).

interface Glyph {
  label: string
  color: string
  shape: 'circle' | 'square' | 'diamond' | 'folder' | 'doc'
}

const G = (label: string, color: string, shape: Glyph['shape'] = 'square'): Glyph => ({ label, color, shape })

const glyphs: Record<string, Glyph> = {
  // Services
  Workspace: G('W', '#6aa5d9', 'circle'),
  Lighting: G('L', '#e2c25b', 'circle'),
  ReplicatedStorage: G('R', '#5fb3a6', 'circle'),
  ServerScriptService: G('S', '#7f9cf0', 'circle'),
  ServerStorage: G('S', '#8c88d8', 'circle'),
  StarterGui: G('G', '#d888b8', 'circle'),
  StarterPlayer: G('P', '#e09a5d', 'circle'),
  StarterPlayerScripts: G('P', '#d0905a', 'circle'),
  SoundService: G('♪', '#c49ad9', 'circle'),
  // Containers
  Folder: G('', '#c9a669', 'folder'),
  Model: G('M', '#8fb3a0', 'diamond'),
  // Scripts
  ModuleScript: G('M', '#a58be0', 'doc'),
  Script: G('S', '#6f9fe8', 'doc'),
  LocalScript: G('L', '#5fb8a5', 'doc'),
  // Networking (Blink events.blink)
  RemoteEvent: G('E', '#e0b25a', 'diamond'),
  UnreliableRemoteEvent: G('U', '#d98f5a', 'diamond'),
  RemoteFunction: G('F', '#e08a8a', 'diamond'),
  // Parts & assets
  Part: G('', '#9aa3ad', 'square'),
  MeshPart: G('', '#b0a59a', 'diamond'),
  SpawnLocation: G('', '#7fae6a', 'square'),
  Sound: G('♪', '#c49ad9', 'square'),
  SoundGroup: G('♪', '#b38fd0', 'square'),
  Decal: G('D', '#d9a46a', 'square'),
  Texture: G('T', '#cf9a6a', 'square'),
  Animation: G('A', '#e08a8a', 'square'),
  Tool: G('T', '#d6b25e', 'diamond'),
  ProximityPrompt: G('E', '#7fb8d9', 'square'),
  Camera: G('C', '#8a9bb0', 'square'),
  Atmosphere: G('', '#8fc0e0', 'circle'),
  Sky: G('', '#7fb0e8', 'circle'),
  // UI
  ScreenGui: G('', '#d888b8', 'square'),
  Frame: G('', '#c78bb0', 'square'),
  ImageLabel: G('I', '#c78bb0', 'square'),
  TextLabel: G('T', '#c78bb0', 'square'),
  TextButton: G('B', '#c78bb0', 'square'),
  DataModel: G('', '#9aa3ad', 'circle')
}

const fallback = G('', '#8a857b', 'square')

export function ClassIcon({ className, size = 14 }: { className: string; size?: number }) {
  const g = glyphs[className] ?? fallback
  const s = size
  let shape
  switch (g.shape) {
    case 'circle':
      shape = <circle cx={s / 2} cy={s / 2} r={s / 2 - 1} fill={g.color} fillOpacity={0.22} stroke={g.color} strokeWidth={1.2} />
      break
    case 'diamond':
      shape = <path d={`M${s / 2} 1 L${s - 1} ${s / 2} L${s / 2} ${s - 1} L1 ${s / 2} Z`} fill={g.color} fillOpacity={0.22} stroke={g.color} strokeWidth={1.2} strokeLinejoin="round" />
      break
    case 'folder':
      shape = (
        <path
          d={`M1.5 ${s * 0.28} q0 -1.2 1.2 -1.2 h${s * 0.26} l1.4 1.5 h${s * 0.38} q1.2 0 1.2 1.2 v${s * 0.48} q0 1.2 -1.2 1.2 h-${s - 5.4} q-1.2 0 -1.2 -1.2 z`}
          fill={g.color}
          fillOpacity={0.3}
          stroke={g.color}
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      )
      break
    case 'doc':
      shape = <rect x={1.5} y={0.8} width={s - 3} height={s - 1.6} rx={2.2} fill={g.color} fillOpacity={0.2} stroke={g.color} strokeWidth={1.2} />
      break
    default:
      shape = <rect x={1} y={1} width={s - 2} height={s - 2} rx={3} fill={g.color} fillOpacity={0.22} stroke={g.color} strokeWidth={1.2} />
  }
  return (
    <svg className="class-icon" width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-label={className}>
      {shape}
      {g.label && (
        <text x={s / 2} y={s / 2 + 0.5} textAnchor="middle" dominantBaseline="central" fontSize={s * 0.56} fontWeight={700} fill={g.color} fontFamily="Inter, system-ui, sans-serif">
          {g.label}
        </text>
      )}
    </svg>
  )
}
