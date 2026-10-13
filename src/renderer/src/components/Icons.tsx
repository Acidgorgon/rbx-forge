// UI icons: one 16px grid, 1.5px stroke, round caps and joins, currentColor, no fills (SPEC §5).
// Paths follow docs/design/prototype.html. Use <Icon name="…"/> or the named Icon* exports.
import type { CSSProperties, ReactNode } from 'react'

const PATHS = {
  files: <><path d="M3.5 2.5h5l3 3v8h-8z" /><path d="M8.5 2.5v3h3" /></>,
  file: <><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M9.5 2.5V5H12" /></>,
  tree: <><rect x="2" y="2" width="4.5" height="3.5" rx=".8" /><rect x="9.5" y="6.5" width="4.5" height="3" rx=".8" /><rect x="9.5" y="11" width="4.5" height="3" rx=".8" /><path d="M4.2 5.5v6.5h5.3M4.2 8h5.3" /></>,
  script: <><path d="M4 2.5h6l2.5 2.5v8.5H4z" /><path d="M6.2 8.2 5 9.4l1.2 1.2M9.8 8.2 11 9.4l-1.2 1.2" /></>,
  bolt: <path d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z" />,
  package: <><path d="m8 1.8 5.5 3v6.4L8 14.2l-5.5-3V4.8z" /><path d="m2.6 4.9 5.4 3 5.4-3M8 7.9v6.2M5.2 3.4l5.5 3" /></>,
  sync: <><path d="M13 6.5A5.2 5.2 0 0 0 3.6 5M3 9.5A5.2 5.2 0 0 0 12.4 11" /><path d="M3.3 2.6v2.6h2.6M12.7 13.4v-2.6h-2.6" /></>,
  branch: <><circle cx="4.5" cy="3.8" r="1.5" /><circle cx="4.5" cy="12.2" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5.3v5.4M11.5 7c0 2.5-2.5 2.8-7 3.6" /></>,
  bot: <><rect x="3" y="5" width="10" height="8" rx="2" /><path d="M8 2.2V5M6 9h.01M10 9h.01M1.5 8.5v2M14.5 8.5v2" /></>,
  gear: <><circle cx="8" cy="8" r="2.1" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" /><circle cx="8" cy="8" r="4.6" /></>,
  search: <><circle cx="7" cy="7" r="4.3" /><path d="m10.2 10.2 3.3 3.3" /></>,
  chev: <path d="m6 4 4 4-4 4" />,
  chevDown: <path d="m4 6 4 4 4-4" />,
  chevUp: <path d="m4 10 4-4 4 4" />,
  x: <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
  panelL: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6.2 2.5v11" /></>,
  panelB: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 9.8h12" /></>,
  panelR: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M9.8 2.5v11" /></>,
  hammer: <><path d="M9.5 2.5 13.5 6.5l-1.6 1.6-1.2-1.2-6.5 6.5a1.1 1.1 0 0 1-1.6-1.6l6.5-6.5-1.2-1.2z" /><path d="m7.3 4.7 2.2-2.2" /></>,
  folder: <path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.6 3.5H3A1 1 0 0 0 2 4.5z" />,
  folderPlus: <><path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.6 3.5H3A1 1 0 0 0 2 4.5z" /><path d="M8 7.3v3.6M6.2 9.1h3.6" /></>,
  filePlus: <><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M8 7v4M6 9h4" /></>,
  trio: <><rect x="5.5" y="1.8" width="5" height="4" rx=".8" /><rect x="1.8" y="10.2" width="5" height="4" rx=".8" /><rect x="9.2" y="10.2" width="5" height="4" rx=".8" /><path d="M8 5.8v2.2M4.3 10.2V8h7.4v2.2" /></>,
  pencil: <><path d="M10.5 3 13 5.5 5.5 13H3v-2.5z" /><path d="m9 4.5 2.5 2.5" /></>,
  copy: <><rect x="5" y="5" width="8.5" height="8.5" rx="1.2" /><path d="M11 5V3.5A1 1 0 0 0 10 2.5H3.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1H5" /></>,
  trash: <path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.2 4.3l.6 9h6.4l.6-9" />,
  link: <path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.6.6M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.6-.6" />,
  reveal: <><path d="M2 4.5V12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.6 3.5H3A1 1 0 0 0 2 4.5z" /><path d="m7 8.8 1.5 1.5L10.5 8" /></>,
  collapse: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M5.5 8h5" /></>,
  more: <><circle cx="3.5" cy="8" r=".9" fill="currentColor" /><circle cx="8" cy="8" r=".9" fill="currentColor" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" /></>,
  warn: <><path d="M8 2.2 14.2 13H1.8z" /><path d="M8 6.5v3M8 11.2h.01" /></>,
  err: <><circle cx="8" cy="8" r="5.8" /><path d="m6 6 4 4M10 6l-4 4" /></>,
  info: <><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.6M8 5.2h.01" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  terminal: <><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.5" /><path d="m4.5 6.5 2 1.8-2 1.8M8 10.2h3.5" /></>,
  studio: <><path d="m3 3.5 9.5 2.5-2.5 9.5L.5 13z" transform="translate(1.5 -1)" /><rect x="6.3" y="6.3" width="3" height="3" transform="rotate(15 7.8 7.8)" /></>,
  bell: <><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" /><path d="M6.5 14h3" /></>,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" />,
  monitor: <><rect x="2" y="2.8" width="12" height="8.4" rx="1.2" /><path d="M6 13.8h4M8 11.2v2.6" /></>,
  clock: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.8V8l2 1.5" /></>,
  at: <><circle cx="8" cy="8" r="2.4" /><path d="M10.4 8v1a1.8 1.8 0 0 0 3.6 0V8A6 6 0 1 0 11 13.2" /></>,
  arrowUp: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  arrowDown: <path d="M8 3v9.5M4 8.5l4 4 4-4" />,
  arrowRight: <path d="M3 8h9.5M8.5 4l4 4-4 4" />,
  undo: <><path d="M4 6h6a3.5 3.5 0 0 1 0 7H6" /><path d="M6.5 3.5 4 6l2.5 2.5" /></>,
  filter: <path d="M2.5 3.5h11L9.2 8.6v4l-2.4 1V8.6z" />,
  split: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M8 2.5v11" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.2" />,
  restart: <><path d="M3 8a5 5 0 1 0 1.5-3.6" /><path d="M3.5 2.2v2.6h2.6" /></>,
  team: <><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13c.4-2.4 2-3.6 4-3.6s3.6 1.2 4 3.6" /><path d="M10.5 3.6a2.2 2.2 0 0 1 0 4M12 9.6c1.1.4 1.8 1.5 2 3.4" /></>,
  rocket: <><path d="M9.5 2.2c2.4 0 4.3 1.9 4.3 4.3L9 11.3 4.7 7z" /><path d="M4.7 7 2.5 7.2l-.4 2.3 2.8.2M9 11.3l-.2 2.2-2.3.4-.2-2.8" /><circle cx="10.3" cy="5.7" r="1.1" /></>,
  chart: <><path d="M2.5 2.5v11h11" /><path d="m5 10 2.5-3 2.2 1.8L13 4.5" /></>,
  flask: <><path d="M6.2 2.2h3.6M6.8 2.2v4.1L3 12.6a.9.9 0 0 0 .8 1.4h8.4a.9.9 0 0 0 .8-1.4L9.2 6.3V2.2" /><path d="M4.6 10h6.8" /></>,
  code: <path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3" />,
  key: <><circle cx="5.2" cy="10.8" r="2.7" /><path d="m7.2 8.9 5.6-5.6M10.8 5.3l1.6 1.6M9.4 6.7l1.2 1.2" /></>,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />,
  tool: <path d="M10.2 2.4a3.2 3.2 0 0 0-3.9 4.2l-3.9 3.9a1.2 1.2 0 0 0 1.7 1.7l3.9-3.9a3.2 3.2 0 0 0 4.2-3.9l-1.9 1.9-1.6-.4-.4-1.6z" />,
  external: <><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" /></>,
  round: <><circle cx="8" cy="3.2" r="1.4" /><circle cx="3.6" cy="10.8" r="1.4" /><circle cx="12.4" cy="10.8" r="1.4" /><path d="M6.6 4.2 4.4 9.4M9.4 4.2l2.2 5.2M5.2 11.3h5.6" /></>,
  board: <><rect x="2" y="2.5" width="3.4" height="11" rx=".8" /><rect x="6.3" y="2.5" width="3.4" height="7" rx=".8" /><rect x="10.6" y="2.5" width="3.4" height="9" rx=".8" /></>,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></>,
  upload: <><path d="M8 10.5V2.8M5 5.5l3-3 3 3" /><path d="M2.8 10.5v1.7a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.7" /></>,
  download: <><path d="M8 2.8v7.7M5 7.5l3 3 3-3" /><path d="M2.8 10.5v1.7a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.7" /></>,
  pr: <><circle cx="4.5" cy="3.8" r="1.5" /><circle cx="4.5" cy="12.2" r="1.5" /><circle cx="11.5" cy="12.2" r="1.5" /><path d="M4.5 5.3v5.4M11.5 10.7V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" /></>,
  flag: <><path d="M3.5 14V2.5" /><path d="M3.5 3h8l-1.6 2.8 1.6 2.8h-8" /></>,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2" /></>,
  eye: <><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.8" /></>,
  diff: <><path d="M4.5 2v7M1.5 5.5h6M9 11.5h5.5" /><rect x="8.5" y="2.5" width="5.5" height="6" rx="1" /></>,
  pin: <><path d="M6 2.5h4l-.6 3.8 2.1 2.2H4.5l2.1-2.2z" /><path d="M8 8.5v5" /></>,
  image: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><circle cx="5.8" cy="6" r="1.2" /><path d="m2.5 12 3.8-3.6 2.6 2.4 2.2-2 2.4 2.2" /></>,
  memory: <><path d="M4 2.5h8v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" /><path d="M5.8 2.5v11M8.2 5.8h2M8.2 8.2h2" /></>,
  figure: <><circle cx="8.6" cy="2.8" r="1.3" /><path d="M8.2 4.6 7.4 9l-2.6 4.2M7.4 9l2.4 1.6.4 3M8 5.6l2.8 1.6 1.6-1.4M8 5.6 5.2 6.4 4 8.4" /></>,
  sparkle: <><path d="M7 2v2.6M7 9.4V12M2 7h2.6M9.4 7H12M3.6 3.6l1.6 1.6M8.8 8.8l1.6 1.6M10.4 3.6 8.8 5.2M5.2 8.8l-1.6 1.6" /><path d="M12.2 10.6v3.2M10.6 12.2h3.2" /></>
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof PATHS

export interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
  strokeWidth?: number
}

export function Icon({ name, size = 16, className, style, title, strokeWidth }: IconProps & { name: IconName }) {
  return (
    <svg className={`i${className ? ' ' + className : ''}`} viewBox="0 0 16 16" width={size} height={size} style={{ width: size, height: size, ...(strokeWidth ? { strokeWidth } : {}), ...style }} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  )
}

const named = (name: IconName) => {
  const C = (p: IconProps) => <Icon name={name} {...p} />
  C.displayName = `Icon(${name})`
  return C
}

// Named exports kept for components that predate <Icon name>.
export const IconCheck = named('check')
export const IconClose = named('x')
export const IconCopy = named('copy')
export const IconList = named('list')
export const IconPlus = named('plus')
export const IconRound = named('round')
export const IconSearch = named('search')
export const IconChevron = named('chev')
export const IconChevronDown = named('chevDown')
export const IconAlert = named('warn')
export const IconTool = named('tool')
export const IconArrowUp = named('arrowUp')
export const IconStop = named('stop')
export const IconGear = named('gear')
export const IconPlay = named('play')
export const IconBot = named('bot')
export const IconFile = named('file')
