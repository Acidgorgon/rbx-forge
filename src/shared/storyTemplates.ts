// UI Labs story and storybook templates for Explorer > New > UI (Vide stories, as UI Preview runs).
// No imports: unit tested directly.

export function storyFile(dir: string, name: string): { path: string; contents: string } {
  const contents = [
    'local ReplicatedStorage = game:GetService("ReplicatedStorage")',
    '',
    'local Vide = require(ReplicatedStorage.Packages.Vide)',
    '',
    'local create = Vide.create',
    '',
    'local story = {',
    '\tvide = Vide,',
    '\tcontrols = {',
    `\t\tText = ${JSON.stringify(name)},`,
    '\t\tVisible = true,',
    '\t},',
    '\tstory = function(props)',
    '\t\treturn create "Frame" {',
    '\t\t\tAnchorPoint = Vector2.new(0.5, 0.5),',
    '\t\t\tPosition = UDim2.fromScale(0.5, 0.5),',
    '\t\t\tSize = UDim2.fromOffset(320, 160),',
    '\t\t\tBackgroundColor3 = Color3.fromRGB(32, 34, 40),',
    '\t\t\tVisible = props.controls.Visible,',
    '',
    '\t\t\tcreate "UICorner" {',
    '\t\t\t\tCornerRadius = UDim.new(0, 12),',
    '\t\t\t},',
    '',
    '\t\t\tcreate "TextLabel" {',
    '\t\t\t\tSize = UDim2.fromScale(1, 1),',
    '\t\t\t\tBackgroundTransparency = 1,',
    '\t\t\t\tText = props.controls.Text,',
    '\t\t\t\tTextColor3 = Color3.fromRGB(255, 255, 255),',
    '\t\t\t\tTextSize = 28,',
    '\t\t\t\tFont = Enum.Font.GothamBold,',
    '\t\t\t},',
    '\t\t}',
    '\tend,',
    '}',
    '',
    'return story',
    ''
  ].join('\n')
  return { path: `${dir}/${name}.story.luau`, contents }
}

export function storybookFile(dir: string, name: string): { path: string; contents: string } {
  const contents = ['local storybook = {', `\tname = ${JSON.stringify(name)},`, '\tstoryRoots = {', '\t\tscript.Parent,', '\t},', '}', '', 'return storybook', ''].join('\n')
  return { path: `${dir}/${name}.storybook.luau`, contents }
}

// Whether the story file belongs to a real storybook (not "Unknown stories") in a UI Preview
// listing; null when the listing does not include the file.
export function storyCovered(list: { storybooks: { file?: string; stories: { file: string }[] }[] }, file: string): boolean | null {
  const books = list.storybooks.filter((b) => b.stories.some((s) => s.file === file))
  if (!books.length) return null
  return books.some((b) => !!b.file)
}

// Story and storybook files in an Explorer tree; changes when one is added, renamed or removed.
interface FileNode {
  filePath?: string
  children: FileNode[]
}

export function storyFilesKey(tree: FileNode[]): string {
  const out: string[] = []
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.filePath && /\.story(book)?\.luau?$/.test(n.filePath)) out.push(n.filePath)
      walk(n.children)
    }
  }
  walk(tree)
  return out.sort().join('\n')
}
