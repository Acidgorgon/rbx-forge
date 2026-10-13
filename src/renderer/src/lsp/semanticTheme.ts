// Theme rules for luau-lsp semantic tokens, in the harness-dark / harness-light palettes
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
    identifier: 'ebe7df',
    type: 'c7b37a',
    builtin: 'a7b8d6',
    func: 'dcc9a6',
    property: 'd5cdbf',
    parameter: 'e3bfa3',
    enumMember: 'c79bd6',
    event: 'd6a35c'
  },
  light: {
    identifier: '2f2c27',
    type: '8a6d1f',
    builtin: '3d5f99',
    func: '5c4a2e',
    property: '4a463f',
    parameter: '7a4f36',
    enumMember: '8650a6',
    event: '9a6a1c'
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
    { token: 'typeParameter', foreground: p.type, fontStyle: 'italic' },
    { token: 'variable.deprecated', fontStyle: 'strikethrough' },
    { token: 'property.deprecated', fontStyle: 'strikethrough' },
    { token: 'function.deprecated', fontStyle: 'strikethrough' },
    { token: 'method.deprecated', fontStyle: 'strikethrough' }
  ]
}
