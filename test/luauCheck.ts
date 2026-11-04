// A small structural checker for generated Luau, used where Lune is not installed: tokenises the
// source (comments, strings, long brackets), checks block keywords balance (function / if / do /
// while / for / repeat against end / until; Luau if-expressions have no end), flags C-style
// operators (!=, &&, ||, !), a "(" that starts a line right after an expression (Luau rejects it as
// ambiguous call syntax), and identifiers that are neither declared anywhere in the file nor a
// known Roblox / Luau global (catches misspelled helpers). Not a parser: it cannot prove the code
// compiles, only rule out the usual slips. The real check is luau.compile under Lune.

export interface LuauToken {
  t: string
  line: number
  kind: 'word' | 'str' | 'num' | 'op'
}

const OPS = ['...', '..=', '//=', '..', '==', '~=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '^=', '//', '::', '->']

export function luauTokens(src: string): LuauToken[] {
  const out: LuauToken[] = []
  let i = 0
  let line = 1
  const lines = (s: string) => s.split('\n').length - 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (src.startsWith('--', i)) {
      const m = /^--\[(=*)\[/.exec(src.slice(i, i + 20))
      if (m) {
        const close = `]${m[1]}]`
        const j = src.indexOf(close, i)
        if (j < 0) throw new Error(`line ${line}: unterminated long comment`)
        line += lines(src.slice(i, j))
        i = j + close.length
        continue
      }
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j
      continue
    }
    const long = /^\[(=*)\[/.exec(src.slice(i, i + 20))
    if (long) {
      const close = `]${long[1]}]`
      const j = src.indexOf(close, i)
      if (j < 0) throw new Error(`line ${line}: unterminated long string`)
      out.push({ t: '<str>', line, kind: 'str' })
      line += lines(src.slice(i, j))
      i = j + close.length
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++
        else if (src[j] === '\n') throw new Error(`line ${line}: unterminated string`)
        j++
      }
      if (j >= src.length) throw new Error(`line ${line}: unterminated string`)
      out.push({ t: '<str>', line, kind: 'str' })
      i = j + 1
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 200))
    if (word) {
      out.push({ t: word[0], line, kind: 'word' })
      i += word[0].length
      continue
    }
    const n = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(\.\d*)?([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)/.exec(src.slice(i, i + 100))
    if (n) {
      out.push({ t: n[0], line, kind: 'num' })
      i += n[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? c
    out.push({ t: op, line, kind: 'op' })
    i += op.length
  }
  return out
}

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'export', 'type'])
const EXPR_BEFORE_IF = new Set(['=', '(', ',', 'return', '{', 'and', 'or', 'not', '..', '+', '-', '*', '/', '[', '==', '~=', '<', '>', '<=', '>=', '+=', '-=', '*=', '/=', '..=', 'in'])
const GLOBALS = new Set(
  (
    'game workspace script plugin shared Instance Vector3 Vector2 CFrame Color3 ColorSequence ColorSequenceKeypoint NumberSequence NumberSequenceKeypoint ' +
    'NumberRange UDim UDim2 Enum Random TweenInfo Ray RaycastParams Rect Region3 BrickColor Font Content Axes Faces task math string table utf8 bit32 buffer debug os coroutine ' +
    'typeof type pairs ipairs next pcall xpcall error assert tostring tonumber setmetatable getmetatable rawget rawset rawequal rawlen select unpack require warn print tick time wait delay spawn ' +
    // type names used in annotations
    'number boolean any nil never unknown thread userdata Instance BasePart Part MeshPart Model Folder Attachment PVInstance ParticleEmitter Beam Trail Light Highlight SpecialMesh Decal ' +
    'ModuleScript RBXScriptConnection RBXScriptSignal EnumItem self'
  ).split(' ')
)

export function luauCheck(src: string): string[] {
  const errors: string[] = []
  let tokens: LuauToken[]
  try {
    tokens = luauTokens(src)
  } catch (e) {
    return [(e as Error).message]
  }
  // ------------------------------------------------ blocks
  const stack: { t: string; line: number }[] = []
  let pendingDo = 0
  let exprIfs = 0
  tokens.forEach((tok, i) => {
    if (tok.kind !== 'word') return
    const prev = tokens[i - 1]
    switch (tok.t) {
      case 'function':
      case 'repeat':
        stack.push(tok)
        break
      case 'if':
        if (prev && EXPR_BEFORE_IF.has(prev.t)) exprIfs++
        else stack.push(tok)
        break
      case 'while':
      case 'for':
        stack.push(tok)
        pendingDo++
        break
      case 'do':
        if (pendingDo > 0) pendingDo--
        else stack.push(tok)
        break
      case 'else':
        // An if-expression's else comes before any later else of an enclosing if statement.
        if (exprIfs > 0) exprIfs--
        else if (stack[stack.length - 1]?.t !== 'if') errors.push(`line ${tok.line}: else outside an if`)
        break
      case 'elseif':
        if (exprIfs === 0 && stack[stack.length - 1]?.t !== 'if') errors.push(`line ${tok.line}: elseif outside an if`)
        break
      case 'end': {
        const top = stack.pop()
        if (!top || top.t === 'repeat') errors.push(`line ${tok.line}: end without a block${top ? ` (repeat at line ${top.line} needs until)` : ''}`)
        break
      }
      case 'until': {
        const top = stack.pop()
        if (!top || top.t !== 'repeat') errors.push(`line ${tok.line}: until without repeat`)
        break
      }
    }
  })
  for (const open of stack) errors.push(`line ${open.line}: ${open.t} is never closed`)
  if (pendingDo) errors.push('while / for without do')
  // ------------------------------------------------ operators and ambiguous calls
  tokens.forEach((tok, i) => {
    if (tok.kind === 'op' && ['!', '&&', '||'].includes(tok.t) || (tok.t === '&' && tokens[i + 1]?.t === '&') || (tok.t === '|' && tokens[i + 1]?.t === '|')) errors.push(`line ${tok.line}: "${tok.t}" is not Luau`)
    if (tok.t === '!' || (tok.t === '=' && tokens[i - 1]?.t === '!')) return
    if (tok.t === '(' && i > 0 && tokens[i - 1].line < tok.line) {
      const p = tokens[i - 1]
      if (p.kind === 'str' || (p.t === ')' && !closesParams(tokens, i - 1)) || p.t === ']' || p.t === '}' || (p.kind === 'word' && !KEYWORDS.has(p.t))) errors.push(`line ${tok.line}: "(" at the start of a line after an expression (ambiguous call syntax)`)
    }
  })
  // ------------------------------------------------ undeclared identifiers
  const declared = new Set<string>()
  tokens.forEach((tok, i) => {
    // local a, b: T = ... / local function f / for k, v in / for i = 1, n
    if (tok.t === 'type' && tokens[i + 1]?.kind === 'word') declared.add(tokens[i + 1].t)
    if (tok.t === 'local' || tok.t === 'for' || tok.t === 'function') {
      for (let k = i + 1; k < tokens.length; k++) {
        const x = tokens[k]
        if (x.t === '=' || x.t === 'in' || x.t === '(' || (x.kind === 'word' && KEYWORDS.has(x.t) && x.t !== 'function')) break
        if (x.kind === 'word' && !KEYWORDS.has(x.t) && ['local', 'for', 'function', ','].includes(tokens[k - 1].t)) declared.add(x.t)
        if (tok.t === 'function') break
      }
    }
    // parameters: function (a, b: T, ...) / function a.b:c(x)
    if (tok.t === '(' && (tokens[i - 1]?.t === 'function' || isFunctionName(tokens, i - 1))) {
      for (let k = i + 1; k < tokens.length && tokens[k].t !== ')'; k++) {
        if (tokens[k].kind === 'word' && ['(', ','].includes(tokens[k - 1].t)) declared.add(tokens[k].t)
      }
    }
  })
  tokens.forEach((tok, i) => {
    if (tok.kind !== 'word' || KEYWORDS.has(tok.t) || declared.has(tok.t) || GLOBALS.has(tok.t)) return
    const prev = tokens[i - 1]?.t
    const next = tokens[i + 1]?.t
    // fields, methods, type annotations, table-constructor keys
    if (prev === '.' || prev === ':' || prev === '::' || prev === '->') return
    if (next === '=' && (prev === '{' || prev === ',')) return
    if (prev === '?' || next === '?') return
    errors.push(`line ${tok.line}: "${tok.t}" is not declared in this file`)
  })
  return errors
}

// function a.b.c( / function a:b(
function isFunctionName(tokens: LuauToken[], end: number): boolean {
  let j = end
  while (j > 0 && ((tokens[j].kind === 'word' && !KEYWORDS.has(tokens[j].t)) || tokens[j].t === '.' || tokens[j].t === ':')) j--
  return tokens[j]?.t === 'function'
}

// The ")" at `end` closes a function's parameter list (a body follows, not an expression).
function closesParams(tokens: LuauToken[], end: number): boolean {
  let depth = 0
  for (let j = end; j >= 0; j--) {
    if (tokens[j].t === ')') depth++
    else if (tokens[j].t === '(') {
      depth--
      if (depth === 0) return tokens[j - 1]?.t === 'function' || isFunctionName(tokens, j - 1)
    }
  }
  return false
}
