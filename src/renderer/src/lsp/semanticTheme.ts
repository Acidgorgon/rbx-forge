// Theme rules for luau-lsp semantic tokens, in the forge-dark / forge-light palettes
// (src/renderer/src/monaco.ts). Spread them into the themes' `rules`.
//
// Token types and modifiers are luau-lsp's legend (src/include/Protocol/SemanticTokens.hpp,
// SemanticTokenTypesList / SemanticTokenModifiersList). What the server emits
// (src/operations/SemanticTokens.cpp): variable, parameter, property, function, method,
// event (RBXScriptSignal), class (upper-case builtin globals: Vector3, Instance...),
// enum (Enum, Enum.X), enumMember, namespace (type prefixes) and type; builtin globals and
// their members get "readonly" + "defaultLibrary".
//
// Monaco's standalone theme matches a semantic token as "<type>.<modifier>..." with the
// modifiers in legend order (declaration, definition, readonly, static, deprecated,
// abstract, async, modification, documentation, defaultLibrary), longest rule prefix wins.
// Every type the server emits needs a rule: an unmatched semantic token is painted with the
// default foreground and would override the Monarch colour underneath.

type Rule = { token: string; foreground?: string; fontStyle?: string }

const PALETTES = {
  dark: {
    identifier: 'c8c8c8',
    type: 'c8c8c8',
    builtin: '8fb8de',
    func: 'd6d6d6',
    property: 'c8c8c8',
    parameter: '9cc4e4',
    enumMember: 'c5d18a',
    event: 'c9b6f2'
  },
  light: {
    identifier: '2b2b2b',
    type: '3a3a3a',
    builtin: '2f6aa8',
    func: '2b2b2b',
    property: '3a3a3a',
    parameter: '2f5f8a',
    enumMember: '6f7a1f',
    event: '6b4fb0'
  }
}

export function semanticTokenRules(theme: 'dark' | 'light'): Rule[] {
  const p = PALETTES[theme]
  return [
    { token: 'variable', foreground: p.identifier },
    { token: 'variable.readonly.defaultLibrary', foreground: p.builtin },
    { token: 'parameter', foreground: p.parameter },
    { token: 'property', foreground: p.property },
    { token: 'property.readonly.defaultLibrary', foreground: p.property },
    { token: 'function', foreground: p.func },
    { token: 'function.readonly.defaultLibrary', foreground: p.builtin },
    { token: 'method', foreground: p.func },
    { token: 'method.defaultLibrary', foreground: p.func },
    { token: 'event', foreground: p.event },
    { token: 'class', foreground: p.type },
    { token: 'class.defaultLibrary', foreground: p.type },
    { token: 'enum', foreground: p.type },
    { token: 'enum.defaultLibrary', foreground: p.builtin },
    { token: 'enumMember', foreground: p.enumMember },
    { token: 'namespace', foreground: p.type },
    { token: 'type', foreground: p.type },
    { token: 'interface', foreground: p.type },
    { token: 'struct', foreground: p.type },
    { token: 'typeParameter', foreground: p.type },
    { token: 'variable.deprecated', fontStyle: 'strikethrough' },
    { token: 'property.deprecated', fontStyle: 'strikethrough' },
    { token: 'function.deprecated', fontStyle: 'strikethrough' },
    { token: 'method.deprecated', fontStyle: 'strikethrough' }
  ]
}
