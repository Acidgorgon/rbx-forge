// Roblox rich text (https://create.roblox.com/docs/ui/rich-text) -> styled runs. Supports <b>,
// <i>, <u>, <s>, <font color size face family weight transparency>, <stroke color thickness
// transparency>, <br />, <uppercase>/<uc>, <smallcaps>/<sc>, <mark color transparency>, comments and
// the &lt; &gt; &quot; &apos; &amp; escapes. Unknown tags are dropped, their text kept.

export interface RichStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string // CSS colour
  size?: number
  face?: string
  weight?: string
  transparency?: number
  stroke?: { color: string; thickness: number; transparency: number }
  uppercase?: boolean
  smallcaps?: boolean
  mark?: { color: string; transparency: number }
}

export interface RichRun {
  text: string
  style: RichStyle
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

function unescape(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ENTITIES[e])
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? ''
  return out
}

// "#FF7800", "rgb(255,120,0)" -> CSS colour; null if unreadable.
export function richColor(value: string | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  if (/^#[0-9a-f]{6}$/i.test(v) || /^#[0-9a-f]{3}$/i.test(v)) return v
  const m = /^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v)
  if (m) return `rgb(${m[1]}, ${m[2]}, ${m[3]})`
  return null
}

export function parseRichText(input: string): RichRun[] {
  const runs: RichRun[] = []
  const stack: { tag: string; style: RichStyle }[] = [{ tag: '', style: {} }]
  const top = () => stack[stack.length - 1].style
  const push = (text: string) => {
    if (!text) return
    const style = top()
    const last = runs[runs.length - 1]
    if (last && last.style === style) last.text += text
    else runs.push({ text, style })
  }
  const source = input.replace(/<!--[\s\S]*?-->/g, '')
  const re = /<\s*(\/?)\s*([A-Za-z]+)([^>]*?)(\/?)\s*>/g
  let at = 0
  for (const m of source.matchAll(re)) {
    push(unescape(source.slice(at, m.index)))
    at = m.index! + m[0].length
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    const selfClosing = m[4] === '/'
    if (tag === 'br') {
      push('\n')
      continue
    }
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    if (selfClosing) continue
    const a = attrs(m[3])
    const style: RichStyle = { ...top() }
    switch (tag) {
      case 'b':
        style.bold = true
        break
      case 'i':
        style.italic = true
        break
      case 'u':
        style.underline = true
        break
      case 's':
        style.strike = true
        break
      case 'uppercase':
      case 'uc':
        style.uppercase = true
        break
      case 'smallcaps':
      case 'sc':
        style.smallcaps = true
        break
      case 'font': {
        const color = richColor(a.color)
        if (color) style.color = color
        if (a.size && Number(a.size) > 0) style.size = Number(a.size)
        if (a.face || a.family) style.face = (a.face || a.family).replace(/^rbxasset:\/\/fonts\/families\//, '').replace(/\.json$/, '')
        if (a.weight) style.weight = a.weight
        if (a.transparency !== undefined && !Number.isNaN(Number(a.transparency))) style.transparency = Number(a.transparency)
        break
      }
      case 'stroke':
        style.stroke = { color: richColor(a.color) ?? '#000000', thickness: Number(a.thickness ?? 1) || 1, transparency: Number(a.transparency ?? 0) || 0 }
        break
      case 'mark':
        style.mark = { color: richColor(a.color) ?? '#FFFF00', transparency: Number(a.transparency ?? 0) || 0 }
        break
    }
    stack.push({ tag: tag === 'uc' ? 'uc' : tag === 'sc' ? 'sc' : tag, style })
  }
  push(unescape(source.slice(at)))
  return runs
}
