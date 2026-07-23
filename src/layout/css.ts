import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'

// Bounded plain-CSS class geometry resolution. The line-box containment claim needs the declared
// geometry of stylesheet classes — font-size, line-height, padding, borders, margins, alignment —
// and nothing else. The resolver therefore reads only what it can be honest about: rules whose
// every selector is exactly one class (`.pill--prompt-bar`, possibly comma-listed). Any other
// appearance of a class — descendant combinators, pseudo-classes, @media blocks — SHADOWS the
// properties that rule declares: reading a shadowed property reports unknown with the reason,
// while properties those rules never touch stay decidable (a `:focus` rule that only recolors
// must not block a strut claim).
//
// Within one stylesheet, later declarations win and `!important` beats normal, like the cascade.
// Across stylesheets the load order is unknowable statically, so the same property declared for
// the same class in two files is a conflict that taints the class rather than a guess.

export type CssDeclaration = {
  value: string
  important: boolean
  // Position of the declaration in its stylesheet; resolves same-file conflicts like the cascade.
  order: number
  file: string
}

export type CssClassIndex = {
  // class name → property → winning declaration (per file; cross-file conflicts taint instead)
  classes: Map<string, Map<string, CssDeclaration>>
  tainted: Map<string, string>
  // class name → property → why the property cannot be trusted: an unsupported selector or a
  // conditional at-rule also sets it. Shadowing is per property, so a `:focus` rule touching
  // only paint never blocks a strut claim, while one touching line-height does.
  shadowed: Map<string, Map<string, string>>
  stylesheets: string[]
}

const skippedDirectories = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out'])

export function resolveCssClasses(rootDirectory: string): CssClassIndex {
  const stylesheets: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) walk(join(directory, entry.name))
      } else if (entry.name.endsWith('.css')) {
        stylesheets.push(join(directory, entry.name))
      }
    }
  }
  if (statSync(rootDirectory).isDirectory()) walk(rootDirectory)
  stylesheets.sort()

  const index: CssClassIndex = {classes: new Map(), tainted: new Map(), shadowed: new Map(), stylesheets: []}
  for (const stylesheet of stylesheets) {
    index.stylesheets.push(relative(rootDirectory, stylesheet))
    parseStylesheet(readFileSync(stylesheet, 'utf8'), relative(rootDirectory, stylesheet), index)
  }
  return index
}

const simpleClassPattern = /^\.([A-Za-z0-9_-]+)$/
const classMentionPattern = /\.([A-Za-z0-9_-]+)/g

function parseStylesheet(source: string, file: string, index: CssClassIndex): void {
  const text = source.replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
  let order = 0
  const shadow = (selector: string, body: string, reason: string): void => {
    // Pseudo-element rules style a generated box, never the element the class names: a
    // `.prompt-editable:empty::before` line-height belongs to the ::before, and shadowing the
    // class with it would block claims its own strut arithmetic fully supports.
    if (/::[a-z-]+|:(before|after|first-line|first-letter|placeholder)\b/.test(selector)) return
    const properties = declaredProperties(body)
    if (properties.length === 0) return
    // A combinator rule's declarations style its subject — the rightmost compound — only:
    // `.pill .pill__thumb { height: 20px }` sizes the thumb, and must not shadow the pill.
    const compounds = selector.split(/[\s>+~]+/).filter(part => part !== '')
    const subject = compounds[compounds.length - 1] ?? selector
    for (const match of subject.matchAll(classMentionPattern)) {
      let perClass = index.shadowed.get(match[1]!)
      if (perClass == null) {
        perClass = new Map()
        index.shadowed.set(match[1]!, perClass)
      }
      for (const property of properties) {
        if (!perClass.has(property)) perClass.set(property, reason)
      }
    }
  }

  const parseRules = (block: string, insideConditional: boolean): void => {
    let position = 0
    while (position < block.length) {
      const braceStart = block.indexOf('{', position)
      if (braceStart === -1) return
      const prelude = block.slice(position, braceStart).trim()
      const braceEnd = matchingBrace(block, braceStart)
      if (braceEnd === -1) return
      const body = block.slice(braceStart + 1, braceEnd)
      position = braceEnd + 1

      if (prelude.startsWith('@')) {
        if (/^@(media|supports|layer|container|scope)\b/.test(prelude)) {
          // Conditionally-applied rules can change a property in states the model does not
          // track: every property they declare is shadowed for the classes they mention.
          parseRules(body, true)
        }
        // @keyframes, @font-face, @import, @charset and friends style no classes directly.
        continue
      }

      const selectors = prelude.split(',').map(selector => selector.trim()).filter(selector => selector !== '')
      for (const selector of selectors) {
        const simple = selector.match(simpleClassPattern)
        if (simple == null) {
          shadow(selector, body, `also set by unsupported selector '${selector}' in ${file}`)
          continue
        }
        const className = simple[1]!
        if (insideConditional) {
          shadow(selector, body, `also set inside a conditional at-rule in ${file}`)
          continue
        }
        recordDeclarations(className, body, file, order, index)
      }
      order += 1
    }
  }
  parseRules(text, false)
}

function declaredProperties(body: string): string[] {
  const properties: string[] = []
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon === -1) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    // Nested rule bodies (inside conditional at-rules) reach here with selector fragments;
    // property names are plain identifiers, so anything else is not a declaration.
    if (/^[a-z-]+$/.test(property)) properties.push(property)
  }
  return properties
}

function matchingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < text.length; index++) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function recordDeclarations(
  className: string,
  body: string,
  file: string,
  order: number,
  index: CssClassIndex,
): void {
  let properties = index.classes.get(className)
  if (properties == null) {
    properties = new Map()
    index.classes.set(className, properties)
  }
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon === -1) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    let value = declaration.slice(colon + 1).trim()
    if (property === '' || value === '') continue
    let important = false
    if (/!important$/i.test(value)) {
      important = true
      value = value.replace(/!important$/i, '').trim()
    }
    const previous = properties.get(property)
    if (previous != null && previous.file !== file) {
      index.tainted.set(
        className,
        `'${property}' is declared in both ${previous.file} and ${file}; stylesheet load order is unknown`,
      )
      continue
    }
    if (previous == null || important || (!previous.important && order >= previous.order)) {
      if (previous == null || important || !previous.important) {
        properties.set(property, {value, important, order, file})
      }
    }
  }
}
