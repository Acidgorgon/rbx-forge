// Small stroke icons (24px grid, drawn at 16px by default).
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {children}
    </svg>
  )
}

export const IconSidebar = (p: P) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></Svg>
)
export const IconPlus = (p: P) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>)
export const IconFolder = (p: P) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>
)
export const IconChat = (p: P) => (
  <Svg {...p}><path d="M5 18l-1.5 3L8 19.5A9 9 0 1 0 5 18z" /></Svg>
)
export const IconSearch = (p: P) => (<Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></Svg>)
export const IconChevron = (p: P) => (<Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>)
export const IconChevronDown = (p: P) => (<Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>)
export const IconClose = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>)
export const IconArrowUp = (p: P) => (<Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>)
export const IconStop = (p: P) => (
  <Svg {...p}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></Svg>
)
export const IconCopy = (p: P) => (
  <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></Svg>
)
export const IconSync = (p: P) => (
  <Svg {...p}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></Svg>
)
export const IconTerminal = (p: P) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 9l3 3-3 3M12 15h5" /></Svg>
)
export const IconSpark = (p: P) => (
  <Svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" /></Svg>
)
export const IconRobot = (p: P) => (
  <Svg {...p}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M2 13v2M22 13v2" /></Svg>
)
export const IconTool = (p: P) => (
  <Svg {...p}><path d="M14.5 6.5a4 4 0 0 0 5 5L13 18l-3 1 1-3 6.5-6.5" /><path d="M14.5 6.5L9 12" /></Svg>
)
export const IconCode = (p: P) => (<Svg {...p}><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" /></Svg>)
export const IconKey = (p: P) => (
  <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3" /></Svg>
)
export const IconCheck = (p: P) => (<Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>)
export const IconAlert = (p: P) => (
  <Svg {...p}><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" /></Svg>
)
export const IconPlay = (p: P) => (<Svg {...p}><path d="M8 5v14l11-7z" fill="currentColor" stroke="none" /></Svg>)
export const IconRestart = (p: P) => (<Svg {...p}><path d="M4 12a8 8 0 1 0 2.5-5.8L4 8" /><path d="M4 4v4h4" /></Svg>)
export const IconSquare = (p: P) => (<Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>)
export const IconList = (p: P) => (<Svg {...p}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></Svg>)
export const IconTree = (p: P) => (
  <Svg {...p}><rect x="3" y="3" width="6" height="5" rx="1.5" /><rect x="13" y="10" width="8" height="5" rx="1.5" /><rect x="13" y="17" width="8" height="4" rx="1.5" /><path d="M6 8v11h7M6 12.5h7" /></Svg>
)
export const IconGit = (p: P) => (
  <Svg {...p}><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="9" r="2.2" /><path d="M6 8.2v7.6M18 11.2c0 3-4 3.5-10 5.5" /></Svg>
)
export const IconLink = (p: P) => (
  <Svg {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>
)
export const IconFile = (p: P) => (
  <Svg {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Svg>
)
export const IconQuote = (p: P) => (<Svg {...p}><path d="M4 7h16M4 12h10M4 17h7" /><path d="M17 15l3 3-3 3" /></Svg>)
export const IconGear = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
)
