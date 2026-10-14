// Calls for an event/function in the Luau modules Blink generates, for "Copy usage".
// Shared by main (AI tools) and the renderer (Events tab). Verified against Blink 0.18.1
// src/Generator/init.luau and docs/pages/language/{5-events,6-functions}.mdx.
import type { BlinkEvent, BlinkModel } from '../types'

type Casing = 'Pascal' | 'Camel' | 'Snake'
const METHOD_CASES: Record<string, [string, string, string]> = {
  Fire: ['Fire', 'fire', 'fire'],
  FireAll: ['FireAll', 'fireAll', 'fire_all'],
  FireList: ['FireList', 'fireList', 'fire_list'],
  FireExcept: ['FireExcept', 'fireExcept', 'fire_except'],
  On: ['On', 'on', 'on'],
  Invoke: ['Invoke', 'invoke', 'invoke'],
  Iter: ['Iter', 'iter', 'iter']
}

function method(name: keyof typeof METHOD_CASES, casing: unknown): string {
  const index = casing === 'Camel' ? 1 : casing === 'Snake' ? 2 : 0
  return METHOD_CASES[name][index]
}

// Splits a type pack "(A, B)" into its top-level parts; any other type is one value.
export function dataValues(data: string | undefined): string[] {
  if (data === undefined || data.trim() === '') return []
  const text = data.trim()
  if (!text.startsWith('(') || !text.endsWith(')')) return [text]
  // `(a, b)` is a pack only when the outer parens enclose the whole thing.
  let depth = 0
  for (let k = 0; k < text.length; k++) {
    if ('({[<'.includes(text[k])) depth++
    else if (')}]>'.includes(text[k])) depth--
    if (depth === 0 && k < text.length - 1) return [text]
  }
  const inner = text.slice(1, -1)
  const parts: string[] = []
  let cur = ''
  depth = 0
  for (const ch of inner) {
    if ('({[<'.includes(ch)) depth++
    else if (')}]>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

// A readable Luau parameter name for a Blink type.
function paramName(type: string, fallback: string): string {
  const t = type.replace(/\?$/, '').trim()
  const cls = /^Instance\((\w+)\)/.exec(t)
  if (cls) return cls[1].charAt(0).toLowerCase() + cls[1].slice(1)
  if (/^(struct|enum|map|set)\b|^[{(]/.test(t) || /[[\]]/.test(t)) return fallback
  const base = t.split('.').pop()!.replace(/[<(].*$/, '')
  const primitives = /^(u8|u16|u32|i8|i16|i32|f16|f32|f64|string|boolean|buffer|vector|CFrame|Color3|BrickColor|DateTime|DateTimeMillis|Instance|unknown)$/
  if (!base || primitives.test(base)) return fallback
  return base.charAt(0).toLowerCase() + base.slice(1)
}

function params(data: string | undefined, taken: string[] = []): string[] {
  const values = dataValues(data)
  const used = new Set(taken)
  return values.map((type, k) => {
    let name = paramName(type, values.length > 1 ? `value${k + 1}` : 'data')
    if (used.has(name)) name = `other${name.charAt(0).toUpperCase()}${name.slice(1)}`
    let n = 2
    const base = name
    while (used.has(name)) name = `${base}${n++}`
    used.add(name)
    return name
  })
}

export interface BlinkUsage {
  server: string
  client: string
}

// Calls for an event/function in the modules Blink generates (src/Generator/init.luau):
// sender side Fire (server: Fire(player, ...), FireAll, FireList, FireExcept), receiver side
// On(listener) or Iter() for polling; functions: client Invoke(...), server On(function(player, ...) return end).
export function blinkUsage(ev: BlinkEvent, model: Pick<BlinkModel, 'options' | 'requirePaths'>, moduleName = 'Events'): BlinkUsage {
  const casing = model.options.Casing as Casing | undefined
  const access = [moduleName, ...ev.scope, ev.name].join('.')
  const header = (side: 'server' | 'client') => {
    const path = model.requirePaths?.[side]
    if (!path) return `local ${moduleName} = require(PATH_TO_BLINK_${side.toUpperCase()})`
    const service = path.split(/[.[]/)[0]
    return `local ${service} = game:GetService("${service}")\nlocal ${moduleName} = require(${path})`
  }
  const comment = (side: string, what: string) => `-- ${side}: ${what}`
  let server: string
  let client: string
  if (ev.kind === 'function') {
    const args = params(ev.data)
    const rets = params(ev.return).map((n) => (n === 'data' ? 'result' : n))
    const invoke = `${access}.${method('Invoke', casing)}(${args.join(', ')})`
    const assign = rets.length ? `local ${rets.join(', ')} = ` : ''
    // Future/Promise yields return the library object (docs: Future:Await(), Promise:await()).
    const call =
      ev.yield === 'Future' ? `local future = ${invoke}\n${assign}future:Await()`
      : ev.yield === 'Promise' ? `local promise = ${invoke}\n${assign}promise:await()`
      : `${assign}${invoke}`
    client = `${header('client')}\n\n${comment('client', 'invoke the server')}\n${call}`
    const serverArgs = params(ev.data, ['player'])
    server = `${header('server')}\n\n${comment('server', 'answer invocations')}\n${access}.${method('On', casing)}(function(${['player', ...serverArgs].join(', ')})\n\treturn ${rets.length ? rets.map(() => 'nil').join(', ') : ''}\nend)`.replace('return \n', 'return\n')
    return { server, client }
  }
  const polling = ev.call === 'Polling' || ev.poll === true || model.options.UsePolling === true
  const fromServer = ev.from !== 'Client'
  const listen = (withPlayer: boolean) => {
    const args = withPlayer ? ['player', ...params(ev.data, ['player'])] : params(ev.data)
    if (polling) return `for ${['index', ...args].join(', ')} in ${access}.${method('Iter', casing)}() do\n\t-- ...\nend`
    return `${access}.${method('On', casing)}(function(${args.join(', ')})\n\t-- ...\nend)`
  }
  if (fromServer) {
    const v = params(ev.data, ['player']).join(', ')
    const fire = (m: keyof typeof METHOD_CASES, first?: string) => `${access}.${method(m, casing)}(${[first, v].filter(Boolean).join(', ')})`
    server = `${header('server')}\n\n${comment('server', 'send to clients')}\n${fire('Fire', 'player')}\n${fire('FireAll')}\n${fire('FireExcept', 'player')}\n${fire('FireList', '{ player }')}`
    client = `${header('client')}\n\n${comment('client', 'receive')}\n${listen(false)}`
  } else {
    const clientValues = params(ev.data)
    client = `${header('client')}\n\n${comment('client', 'send to the server')}\n${access}.${method('Fire', casing)}(${clientValues.join(', ')})`
    server = `${header('server')}\n\n${comment('server', 'receive')}\n${listen(true)}`
  }
  return { server, client }
}
