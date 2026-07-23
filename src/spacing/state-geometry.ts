import * as ts from 'typescript'
import {canonicalTransform, classifyToken, edgeNames, edgeSpread, pixelsOf, responsiveGate, stateVariantPattern, transformFamilyPattern, transformOnlyFamilies} from '../tailwind/core.ts'

// State-variant geometry scan: across the branches of one conditional className expression, only
// paint may vary — geometry must be invariant or explicitly reserved. A conditional border width,
// padding, size, display, or font-size means selecting that state moves layout; the fix is
// reserving the geometry (border-transparent) or meaning the shift. The scan reads syntax only,
// like the spacing scan: findings are advisory, dynamic parts become coverage rather than guesses,
// and it never type-checks and never fails the command.

export {classifyToken, pixelsOf} from '../tailwind/core.ts'

export type StateGeometryFinding = {
  file: string
  line: number
  kind: 'branchGeometry' | 'variantGeometry' | 'instanceGeometry' | 'styleGeometry' | 'childGeometry'
  // branchGeometry: two extracted branches evaluate to different local box geometry.
  // variantGeometry: a state-variant token adds or changes geometry with no matching base token.
  // instanceGeometry: two call sites of the same component evaluate to different effective boxes.
  // styleGeometry: branches of a conditional inside a style attribute disagree on a modeled
  // property — literal against literal quantifies, literal against a runtime value differs
  // unless proven equal, and identical source text on both sides IS proven equal.
  // childGeometry: the branches of a conditional JSX child disagree on their root geometry —
  // selecting the state swaps one box for another, or for nothing at all.
  detail: string
  // Largest pixel delta when both sides of a difference resolve to pixels (per edge for
  // border/padding/margin, per family for sizes the scale quantifies), null for changes the
  // scale cannot quantify (display, position, symbolic sizes). Reports rank by magnitude.
  magnitudePx: number | null
  // Two-axis severity. 'shift': the discriminant can change while the element is mounted (state or
  // pseudo-state), so the geometry difference is visible motion — or a call site overrides the
  // component template's own geometry. 'motion': the discriminant is (or may be) live, but the
  // difference cannot displace a sibling — either every differing family is a transform
  // (translate, scale, rotate move pixels without reflowing neighbors), or the element is out of
  // normal flow in every branch (or nested inside an always-out-of-flow ancestor), bounding the
  // change to the overlay; slide-reveals, hover nudges, and overlay reveals land here.
  // 'config': provably immobile — every call site fixes the discriminant with a literal, or the
  // instance difference lies in caller-owned families the template never declared. 'unclear': the
  // bounded analysis cannot decide.
  severity: 'shift' | 'motion' | 'unclear' | 'config'
  evidence: string
  // instanceGeometry only: the anchor call site this divergent site was compared against —
  // deterministically the lexicographically smallest file, then earliest line, among the
  // component's instances, so adding a call site elsewhere cannot re-anchor the group.
  // Structured so cross-tree delta tooling keys on the site pair instead of parsing (and
  // churning on) file:line text embedded in the detail; the text report renders it after the
  // detail.
  anchor?: {file: string; line: number}
}

export type StateGeometryCoverage = {
  file: string
  line: number
  reason: 'dynamicClassPart' | 'branchFanOut' | 'dynamicStylePart' | 'dynamicChildBranch'
}

export type StateGeometryFileAudit = {
  file: string
  findings: StateGeometryFinding[]
  coverage: StateGeometryCoverage[]
  instances: ComponentInstance[]
}

// A component whose className prop splices into exactly one className attribute — the ubiquitous
// `${className}` pattern — can have its call sites' effective boxes compared. Components applying
// className any other way are simply not registered: no cross-instance claim is made either way.
export type ComponentTemplate = {
  file: string
  branches: string[][]
  complete: boolean
  // Geometry the component's own tokens declare (cells and categorical families). A call site
  // overriding these contradicts the component; differences outside them are caller-owned sizing.
  ownGeometry: Set<string>
}

// A component's identity is its declaring module plus its declared name — never the bare tag
// text. Three unrelated <Pill>s in three files are three identities and must not cross-compare;
// only a name declared twice within ONE module is 'ambiguous' and makes no claim.
export type ModuleTemplates = {
  byName: Map<string, ComponentTemplate | 'ambiguous'>
  // The declared name behind `export default`, when it is a named declaration the scan can see —
  // lets a default import resolve to the declaring name without guessing from the importer's
  // chosen alias.
  defaultExportName: string | null
}

export type ComponentRegistry = Map<string, ModuleTemplates>

export type ComponentInstance = {
  // The template's declared name: canonical across aliased imports, used for display.
  component: string
  template: ComponentTemplate
  file: string
  line: number
  tokens: string[]
}

const holeToken = '\u0000className'

// How props of components are fed across call sites. `literalOnly`: every call site fixes the
// prop with a literal, so no mounted element can transition between the branches it selects.
// `hookFed`: at least one call site feeds it an expression rooted in a hook binding — the prop
// can change while that instance is mounted, so branches it gates are live. `nonLiteral`:
// something else the bounded analysis cannot classify.
export type PropLiteralIndex = Map<string, Map<string, 'literalOnly' | 'nonLiteral' | 'hookFed'>>

export function collectPropLiterals(sourceFile: ts.SourceFile, index: PropLiteralIndex): void {
  const bindings = localBindingIndex(sourceFile)
  const feed = (attribute: ts.JsxAttribute): 'literalOnly' | 'nonLiteral' | 'hookFed' => {
    if (jsxAttributeIsLiteral(attribute)) return 'literalOnly'
    const initializer = attribute.initializer
    if (initializer != null && ts.isJsxExpression(initializer) && initializer.expression != null) {
      for (const name of discriminantRoots(initializer.expression)) {
        if (name != null && bindings.get(name) === 'hook') return 'hookFed'
      }
    }
    return 'nonLiteral'
  }
  // hookFed beats nonLiteral beats literalOnly: one live call site makes the prop live.
  const strength = {literalOnly: 0, nonLiteral: 1, hookFed: 2} as const
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName)
      && /^[A-Z]/.test(node.tagName.text)) {
      let props = index.get(node.tagName.text)
      if (props == null) {
        props = new Map()
        index.set(node.tagName.text, props)
      }
      for (const property of node.attributes.properties) {
        if (ts.isJsxAttribute(property) && ts.isIdentifier(property.name)) {
          const usage = feed(property)
          const previous = props.get(property.name.text)
          props.set(property.name.text,
            previous == null || strength[usage] > strength[previous] ? usage : previous)
        } else {
          // A spread can feed any prop anything.
          for (const [key, previous] of props) {
            if (strength[previous] < strength.nonLiteral) props.set(key, 'nonLiteral')
          }
          props.set('\u0000spread', 'nonLiteral')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function jsxAttributeIsLiteral(attribute: ts.JsxAttribute): boolean {
  const initializer = attribute.initializer
  if (initializer == null) return true
  if (ts.isStringLiteral(initializer)) return true
  if (!ts.isJsxExpression(initializer) || initializer.expression == null) return false
  const expression = initializer.expression
  return ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword
}

type Mobility = 'mobile' | 'unknown' | 'immobile'

// Classify whether the discriminants gating a conditional className can change while the element
// is mounted. Hook-produced values are mobile; props that every call site fixes with a literal are
// immobile; everything the bounded analysis cannot resolve stays unknown.
function classifyDiscriminants(
  conditions: ts.Expression[],
  site: ts.Node,
  sourceFile: ts.SourceFile,
  propIndex: PropLiteralIndex | undefined,
): {mobility: Mobility; evidence: string} {
  if (conditions.length === 0) return {mobility: 'immobile', evidence: 'no conditions'}
  let sawUnknown = false
  let mobileEvidence: string | null = null
  let immobileEvidence: string | null = null
  const unresolvedNames: string[] = []
  const enclosing = enclosingComponent(site)
  const bindings = localBindingIndex(sourceFile)
  for (const condition of conditions) {
    for (const name of discriminantRoots(condition)) {
      if (name == null) {
        sawUnknown = true
        continue
      }
      const binding = bindings.get(name)
      if (binding === 'hook') {
        mobileEvidence = `'${name}' comes from a hook`
        continue
      }
      if (binding === 'literal') {
        immobileEvidence = `'${name}' is a local literal`
        continue
      }
      if (enclosing != null && enclosing.props.has(name)) {
        const usage = propIndex?.get(enclosing.name)?.get(name)
        const spread = propIndex?.get(enclosing.name)?.has('\u0000spread') ?? false
        if (usage === 'hookFed') {
          mobileEvidence = `a call site feeds '${name}' from a hook`
          continue
        }
        if (usage === 'literalOnly' && !spread) {
          immobileEvidence = `every call site fixes '${name}' with a literal`
          continue
        }
        sawUnknown = true
        unresolvedNames.push(name)
        continue
      }
      sawUnknown = true
      unresolvedNames.push(name)
    }
  }
  if (mobileEvidence != null) return {mobility: 'mobile', evidence: mobileEvidence}
  if (sawUnknown) {
    // Naming the roots makes unresolved findings legible AND makes cross-tree deltas sensitive
    // to discriminant changes: gating the same geometry on a different condition set is a real
    // semantic change even when the geometry claim reads identically.
    const named = [...new Set(unresolvedNames)].slice(0, 4)
    return {
      mobility: 'unknown',
      evidence: named.length === 0
        ? 'the discriminant could not be resolved'
        : `unresolved discriminants: ${named.join(', ')}`,
    }
  }
  return {mobility: 'immobile', evidence: immobileEvidence ?? 'the discriminants never change while mounted'}
}

// Identifier roots of a condition; null marks something the analysis will not follow (calls,
// element access, this).
function discriminantRoots(expression: ts.Expression): Array<string | null> {
  if (ts.isParenthesizedExpression(expression)) return discriminantRoots(expression.expression)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return discriminantRoots(expression.operand)
  }
  if (ts.isBinaryExpression(expression)) {
    return [...discriminantRoots(expression.left), ...discriminantRoots(expression.right)]
  }
  if (ts.isPropertyAccessExpression(expression)) return discriminantRoots(expression.expression)
  if (ts.isIdentifier(expression)) return [expression.text]
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword) {
    return []
  }
  return [null]
}

function enclosingComponent(node: ts.Node): {name: string; props: Set<string>} | null {
  let current: ts.Node | undefined = node
  while (current != null) {
    let name: string | null = null
    let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | null = null
    if (ts.isFunctionDeclaration(current) && current.name != null) {
      name = current.name.text
      fn = current
    } else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      // .parent is typed non-nullable but is undefined on unbound trees.
      const parent = current.parent as ts.Node | undefined
      if (parent != null && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        name = parent.name.text
        fn = current
      }
    }
    if (name != null && fn != null && /^[A-Z]/.test(name)) {
      const props = new Set<string>()
      const parameter = fn.parameters[0]
      if (parameter != null && ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (ts.isIdentifier(element.name)) props.add(element.name.text)
        }
      }
      return {name, props}
    }
    current = current.parent as ts.Node | undefined
  }
  return null
}

// The viewports worth testing are declared by the source itself: every responsive variant names a
// threshold. Default Tailwind screens plus arbitrary min-[Npx]/max-[Npx] variants; unparseable
// media logic is not represented here, so the derived set is a lower bound.
export type BreakpointUsage = {
  thresholdPx: number
  variants: Map<string, number>
}

export function collectBreakpoints(sourceFile: ts.SourceFile, usage: Map<number, BreakpointUsage>): void {
  const record = (thresholdPx: number, variant: string): void => {
    let entry = usage.get(thresholdPx)
    if (entry == null) {
      entry = {thresholdPx, variants: new Map()}
      usage.set(thresholdPx, entry)
    }
    entry.variants.set(variant, (entry.variants.get(variant) ?? 0) + 1)
  }
  const visitToken = (token: string): void => {
    for (const segment of token.split(':').slice(0, -1)) {
      const gate = responsiveGate(segment)
      if (gate != null) record(gate.px, segment)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      for (const token of node.text.split(/\s+/)) {
        if (token.includes(':')) visitToken(token)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

export function formatBreakpointReport(usage: Map<number, BreakpointUsage>): string {
  const thresholds = [...usage.values()].sort((left, right) => left.thresholdPx - right.thresholdPx)
  if (thresholds.length === 0) return 'breakpoints: none declared in class tokens'
  const lines = thresholds.map(entry => {
    const variants = [...entry.variants.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([variant, count]) => `${variant} ×${count}`)
      .join(', ')
    return `${entry.thresholdPx}px — ${variants}`
  })
  const seams = thresholds.flatMap(entry => [entry.thresholdPx - 1, entry.thresholdPx])
  lines.push(`test seams: ${[...new Set(seams)].sort((a, b) => a - b).join(', ')}`)
  return lines.join('\n')
}

const bindingIndexCache = new WeakMap<ts.SourceFile, Map<string, 'hook' | 'literal' | 'other'>>()

function localBindingIndex(sourceFile: ts.SourceFile): Map<string, 'hook' | 'literal' | 'other'> {
  const cached = bindingIndexCache.get(sourceFile)
  if (cached != null) return cached
  const index = new Map<string, 'hook' | 'literal' | 'other'>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer != null) {
      const fromHook = ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && /^use[A-Z]/.test(node.initializer.expression.text)
      const fromLiteral = ts.isStringLiteralLike(node.initializer) || ts.isNumericLiteral(node.initializer)
        || node.initializer.kind === ts.SyntaxKind.TrueKeyword || node.initializer.kind === ts.SyntaxKind.FalseKeyword
      const kind = fromHook ? 'hook' : fromLiteral ? 'literal' : 'other'
      const record = (binding: ts.BindingName): void => {
        if (ts.isIdentifier(binding)) {
          index.set(binding.text, kind)
        } else {
          for (const element of binding.elements) {
            if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) index.set(element.name.text, kind)
          }
        }
      }
      record(node.name)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  bindingIndexCache.set(sourceFile, index)
  return index
}

export function collectComponentTemplates(sourceFile: ts.SourceFile, registry: ComponentRegistry): void {
  let moduleTemplates = registry.get(sourceFile.fileName)
  if (moduleTemplates == null) {
    moduleTemplates = {byName: new Map(), defaultExportName: null}
    registry.set(sourceFile.fileName, moduleTemplates)
  }
  const register = (name: string, body: ts.Node): void => {
    if (!/^[A-Z]/.test(name)) return
    const attributes: ts.JsxAttribute[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)
        && (node.name.text === 'className' || node.name.text === 'class')
        && node.initializer != null && ts.isJsxExpression(node.initializer)
        && node.initializer.expression != null
        && expressionMentionsIdentifier(node.initializer.expression, 'className')) {
        attributes.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    if (attributes.length !== 1) return
    const initializer = attributes[0]!.initializer
    if (initializer == null || !ts.isJsxExpression(initializer) || initializer.expression == null) return
    const extraction = extractBranches(initializer.expression, 'className')
    if (!extraction.branches.some(branch => branch.includes(holeToken))) return
    const ownBranch = (extraction.branches.find(branch => branch.includes(holeToken)) ?? [])
      .filter(token => token !== holeToken)
    const template: ComponentTemplate = {
      file: sourceFile.fileName,
      branches: extraction.branches,
      complete: extraction.complete,
      ownGeometry: syntacticGeometryKeys(ownBranch),
    }
    moduleTemplates.byName.set(name, moduleTemplates.byName.has(name) ? 'ambiguous' : template)
  }
  const visitTop = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name != null && node.body != null) {
      register(node.name.text, node.body)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer != null
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      register(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visitTop)
  }
  visitTop(sourceFile)
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      moduleTemplates.defaultExportName = statement.expression.text
    } else if (ts.isFunctionDeclaration(statement) && statement.name != null
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true) {
      moduleTemplates.defaultExportName = statement.name.text
    }
  }
}

function expressionMentionsIdentifier(expression: ts.Node, name: string): boolean {
  if (ts.isIdentifier(expression) && expression.text === name) return true
  let found = false
  ts.forEachChild(expression, child => {
    if (!found && expressionMentionsIdentifier(child, name)) found = true
  })
  return found
}

// Cross-instance comparison over the collected call sites: every instance compares against the
// first, so one divergent call site is one finding. Instances group by their resolved template —
// the declaring module plus name — so same-name components in different files never
// cross-compare.
export function compareComponentInstances(instances: ComponentInstance[]): StateGeometryFinding[] {
  const byTemplate = new Map<ComponentTemplate, ComponentInstance[]>()
  for (const instance of instances) {
    const list = byTemplate.get(instance.template)
    if (list == null) byTemplate.set(instance.template, [instance])
    else list.push(instance)
  }
  const findings: StateGeometryFinding[] = []
  for (const [template, list] of byTemplate) {
    const component = list[0]!.component
    const ownGeometry = template.ownGeometry
    // Anchor election is deterministic under insertion: the lexicographically smallest file,
    // then the earliest line, anchors the group — collection order (which churns whenever the
    // instance set changes across trees) never decides what every other call site compares
    // against.
    const sorted = [...list].sort((left, right) =>
      left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line)
    const anchor = sorted[0]!
    for (let index = 1; index < sorted.length; index++) {
      for (const difference of compareTokensAcrossIntervals(anchor.tokens, sorted[index]!.tokens)) {
        const overridesTemplate = difference.keys.some(key => ownGeometry.has(key))
        findings.push({
          file: sorted[index]!.file,
          line: sorted[index]!.line,
          kind: 'instanceGeometry',
          severity: overridesTemplate ? 'shift' : 'config',
          evidence: overridesTemplate
            ? 'a call site overrides geometry the component itself declares'
            : 'the difference is caller-owned sizing the template never declares',
          magnitudePx: difference.magnitudePx,
          detail: `<${component}> instances disagree${difference.label == null ? '' : ` ${difference.label}`}: `
            + difference.detail.replace('state shifts layout: ', ''),
          anchor: {file: anchor.file, line: anchor.line},
        })
      }
    }
  }
  return findings
}

const classCombinerNames = new Set(['cn', 'clsx', 'cx', 'classnames', 'twmerge', 'twjoin'])
const branchLimit = 16

export type StateGeometryOptions = {
  tailwind?: boolean
  // Resolves an import specifier from a file to the project source it names. Instance
  // comparison uses it to key call sites on the declaring module rather than the bare tag name;
  // without it (or when it returns null), imported components make no instance claim.
  resolveModule?: (specifier: string, fromFile: string) => string | null
}

export function auditStateGeometrySource(
  file: string,
  source: string,
  options: StateGeometryOptions = {},
): StateGeometryFileAudit {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const registry: ComponentRegistry = new Map()
  collectComponentTemplates(sourceFile, registry)
  const propIndex: PropLiteralIndex = new Map()
  collectPropLiterals(sourceFile, propIndex)
  const audit = auditStateGeometryFile(sourceFile, registry, propIndex, options)
  audit.findings.push(...compareComponentInstances(audit.instances))
  return audit
}

// What a capitalized JSX tag in one file can refer to, read from syntax alone: a declaration in
// the same file (whether or not it qualified as a template), or a default/named import. A tag
// with neither referent is unknown and makes no instance claim.
type ImportBinding = {specifier: string; imported: {kind: 'named'; name: string} | {kind: 'default'}}

function collectImportBindings(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    const clause = statement.importClause
    if (clause == null) continue
    if (clause.name != null) bindings.set(clause.name.text, {specifier, imported: {kind: 'default'}})
    if (clause.namedBindings != null && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text,
          {specifier, imported: {kind: 'named', name: (element.propertyName ?? element.name).text}})
      }
    }
  }
  return bindings
}

// Every name the file declares itself — functions, classes, variables, binding elements. A local
// declaration shadows any template registered elsewhere under the same name, qualified or not:
// this is what keeps a file's own unqualified <Pill> from matching another module's Pill.
function collectLocalDeclarationNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const recordBinding = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) {
      names.add(binding.text)
      return
    }
    for (const element of binding.elements) {
      if (ts.isBindingElement(element)) recordBinding(element.name)
    }
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name != null) {
      names.add(node.name.text)
    } else if (ts.isVariableDeclaration(node)) {
      recordBinding(node.name)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return names
}

export function auditStateGeometryFile(
  sourceFile: ts.SourceFile,
  registry?: ComponentRegistry,
  propIndex?: PropLiteralIndex,
  options: StateGeometryOptions = {},
): StateGeometryFileAudit {
  // Without Tailwind, className tokens have no vocabulary: evaluating them by the default scale
  // on a project that hand-writes look-alike classes would answer wrongly with confidence. The
  // className channels (branches, variants, instances, overlay containment) sit out; the
  // style-attribute channel reads real values and needs no vocabulary, so it always runs.
  const tailwind = options.tailwind ?? true
  const audit: StateGeometryFileAudit = {file: sourceFile.fileName, findings: [], coverage: [], instances: []}
  const localNames = registry == null ? null : collectLocalDeclarationNames(sourceFile)
  const importBindings = registry == null ? null : collectImportBindings(sourceFile)
  // A tag resolves to a template through its referent's identity, never the bare name: a local
  // declaration binds to this file's entry (present or not), an import binds to the module the
  // resolver names, and an unknown referent binds to nothing.
  const resolveTemplate = (tagName: string): {name: string; template: ComponentTemplate} | null => {
    if (registry == null) return null
    if (localNames!.has(tagName)) {
      const entry = registry.get(sourceFile.fileName)?.byName.get(tagName)
      return entry == null || entry === 'ambiguous' ? null : {name: tagName, template: entry}
    }
    const binding = importBindings!.get(tagName)
    if (binding == null) return null
    const moduleFile = options.resolveModule?.(binding.specifier, sourceFile.fileName)
    if (moduleFile == null) return null
    const moduleTemplates = registry.get(moduleFile)
    if (moduleTemplates == null) return null
    const name = binding.imported.kind === 'named' ? binding.imported.name : moduleTemplates.defaultExportName
    if (name == null) return null
    const entry = moduleTemplates.byName.get(name)
    return entry == null || entry === 'ambiguous' ? null : {name, template: entry}
  }
  // The overlay flag travels down the JSX tree during the one visit pass (program-loaded source
  // files carry no parent pointers, so ancestry cannot be walked upward). An element's own
  // className is judged from outside its overlay: only its JSX children inherit the containment.
  // Const initializers resolve through lexical scopes built during the same descent: a name
  // looks up the innermost enclosing function's declaration, so two components declaring the
  // same const name never collide. Declarations register in source order, before the JSX that
  // reads them is visited.
  const scopeStack: Array<Map<string, ts.Expression>> = [new Map<string, ts.Expression>()]
  const resolveName = (name: string): ts.Expression | null => {
    for (let index = scopeStack.length - 1; index >= 0; index--) {
      const found = scopeStack[index]!.get(name)
      if (found != null) return found
    }
    return null
  }
  const visit = (node: ts.Node, insideOverlay: boolean): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)) {
      scopeStack.push(new Map<string, ts.Expression>())
      ts.forEachChild(node, child => { visit(child, insideOverlay) })
      scopeStack.pop()
      return
    }
    // The const flag lives on the declaration LIST and must be read there: the combined-flags
    // helper walks parent pointers, which program-loaded source files do not have.
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer != null) {
          scopeStack[scopeStack.length - 1]!.set(declaration.name.text, declaration.initializer)
        }
      }
    }
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name)) continue
        if (tailwind && (property.name.text === 'className' || property.name.text === 'class')) {
          auditClassAttribute(property, sourceFile, audit, propIndex, insideOverlay)
        } else if (property.name.text === 'style') {
          auditStyleAttribute(property, sourceFile, audit, {
            propIndex,
            resolveName,
            insideOverlay: insideOverlay || (tailwind && elementAlwaysOutOfFlow(node)),
          })
        }
      }
    }
    if (tailwind && registry != null && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text)) {
      const resolved = resolveTemplate(node.tagName.text)
      if (resolved != null) {
        collectInstance(node, resolved.name, resolved.template, sourceFile, audit)
      }
    }
    if (ts.isJsxElement(node)) {
      const overlayForChildren = insideOverlay || (tailwind && elementAlwaysOutOfFlow(node.openingElement))
      visit(node.openingElement, insideOverlay)
      for (const child of node.children) {
        if (ts.isJsxExpression(child)) {
          auditConditionalChild(child, sourceFile, audit,
            {propIndex, resolveName, insideOverlay: overlayForChildren, tailwind})
        }
        visit(child, overlayForChildren)
      }
      visit(node.closingElement, insideOverlay)
      return
    }
    if (ts.isJsxFragment(node)) {
      for (const child of node.children) {
        if (ts.isJsxExpression(child)) {
          auditConditionalChild(child, sourceFile, audit, {propIndex, resolveName, insideOverlay, tailwind})
        }
        visit(child, insideOverlay)
      }
      return
    }
    ts.forEachChild(node, child => { visit(child, insideOverlay) })
  }
  visit(sourceFile, false)
  return audit
}

// Whether an intrinsic element is out of normal flow in every branch of its own className. Only
// intrinsic elements make the claim (a component's className lands who knows where), and a
// className that cannot be fully extracted makes no claim at all.
function elementAlwaysOutOfFlow(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  if (!ts.isIdentifier(opening.tagName) || !/^[a-z]/.test(opening.tagName.text)) return false
  const className = opening.attributes.properties.find((property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === 'className')
  const initializer = className?.initializer
  const expression = initializer == null
    ? null
    : ts.isStringLiteral(initializer)
      ? initializer
      : ts.isJsxExpression(initializer) && initializer.expression != null
        ? initializer.expression
        : null
  if (expression == null) return false
  const extraction = extractBranches(expression, undefined, [])
  return extraction.complete && extraction.branches.length > 0
    && extraction.branches.every(branch => outOfFlowTokens(branch))
}

// The inline-style properties the scan models: reflow levers a JSX author reaches for through
// style={{...}} when no utility token fits — a data-driven aspect ratio, a measured width.
// Everything else in a style object is ignored; a modeled property (or the whole attribute)
// that resists extraction becomes a dynamicStylePart coverage record, never a silent gap.
const modeledStyleProperties = new Map<string, string>([
  ['aspectRatio', 'aspect-ratio'],
  ['width', 'width'], ['height', 'height'],
  ['minWidth', 'min-width'], ['minHeight', 'min-height'],
  ['maxWidth', 'max-width'], ['maxHeight', 'max-height'],
  ['top', 'top'], ['right', 'right'], ['bottom', 'bottom'], ['left', 'left'],
  ['display', 'display'], ['position', 'position'],
])

type StyleValue = {kind: 'literal' | 'dynamic'; text: string}
type StyleBranch = Map<string, StyleValue>

const styleBranchLimit = 8

function auditStyleAttribute(
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  audit: StateGeometryFileAudit,
  context: {
    propIndex: PropLiteralIndex | undefined
    resolveName: (name: string) => ts.Expression | null
    insideOverlay: boolean
  },
): void {
  const initializer = attribute.initializer
  if (initializer == null || !ts.isJsxExpression(initializer) || initializer.expression == null) return
  const line = sourceFile.getLineAndCharacterOfPosition(attribute.getStart(sourceFile)).line + 1
  const conditions: ts.Expression[] = []
  const branches = extractStyleBranches(
    resolveOneHop(initializer.expression, context.resolveName),
    sourceFile,
    context.resolveName,
    conditions,
  )
  if (branches == null) {
    audit.coverage.push({file: audit.file, line, reason: 'dynamicStylePart'})
    return
  }
  let sawDynamicDisagreement = false
  if (branches.length > 1) {
    const {mobility, evidence} = classifyDiscriminants(conditions, attribute, sourceFile, context.propIndex)
    const reported = new Set<string>()
    for (let index = 1; index < branches.length; index++) {
      for (const [cssName, difference] of compareStyleBranches(branches[0]!, branches[index]!)) {
        if (difference == null) {
          sawDynamicDisagreement = true
          continue
        }
        if (reported.has(cssName + difference.detail)) continue
        reported.add(cssName + difference.detail)
        const clauses = [
          evidence,
          difference.unproven ? 'a runtime branch differs unless proven equal' : null,
          context.insideOverlay ? 'out of flow in every branch' : null,
        ].filter(clause => clause != null)
        audit.findings.push({
          file: audit.file,
          line,
          kind: 'styleGeometry',
          severity: liveSeverity(mobility, context.insideOverlay
            && cssName !== 'display' && cssName !== 'position'),
          evidence: clauses.join('; '),
          magnitudePx: difference.magnitudePx,
          detail: `style ${cssName} ${difference.detail}`,
        })
      }
    }
  }
  // A dynamic value that agrees across every branch is state-invariant: no state claim is
  // missable, so only disagreeing runtime values (and unextractable attributes) are coverage.
  if (sawDynamicDisagreement) {
    audit.coverage.push({file: audit.file, line, reason: 'dynamicStylePart'})
  }
}

function resolveOneHop(
  expression: ts.Expression,
  resolveName: (name: string) => ts.Expression | null,
): ts.Expression {
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  if (ts.isIdentifier(unwrapped)) {
    const initializer = resolveName(unwrapped.text)
    if (initializer != null) return initializer
  }
  return unwrapped
}

// Branches of the whole style attribute: a plain object literal is one branch; a ternary of
// resolvable expressions multiplies branches (conditions recorded for mobility); anything else
// is unextractable — null, meaning the caller records coverage and claims nothing.
function extractStyleBranches(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  resolveName: (name: string) => ts.Expression | null,
  conditions: ts.Expression[],
): StyleBranch[] | null {
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  if (ts.isConditionalExpression(unwrapped)) {
    conditions.push(unwrapped.condition)
    const whenTrue = extractStyleBranches(resolveOneHop(unwrapped.whenTrue, resolveName), sourceFile, resolveName, conditions)
    const whenFalse = extractStyleBranches(resolveOneHop(unwrapped.whenFalse, resolveName), sourceFile, resolveName, conditions)
    if (whenTrue == null || whenFalse == null) return null
    const merged = [...whenTrue, ...whenFalse]
    return merged.length > styleBranchLimit ? merged.slice(0, styleBranchLimit) : merged
  }
  if (!ts.isObjectLiteralExpression(unwrapped)) return null
  let branches: StyleBranch[] = [new Map()]
  for (const property of unwrapped.properties) {
    if (ts.isSpreadAssignment(property)) return null
    // `{ aspectRatio }` shorthand reads the like-named binding; the scope resolver turns it into
    // the same value expression a longhand assignment would carry.
    const shorthand = ts.isShorthandPropertyAssignment(property)
    if (!shorthand && !ts.isPropertyAssignment(property)) return null
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
    if (name == null) return null
    const cssName = modeledStyleProperties.get(name)
    if (cssName == null) continue
    const value = shorthand
      ? resolveName(name) ?? property.name
      : resolveOneHop(property.initializer, resolveName)
    if (ts.isConditionalExpression(value)) {
      conditions.push(value.condition)
      const whenTrue = styleValueOf(resolveOneHop(value.whenTrue, resolveName), sourceFile)
      const whenFalse = styleValueOf(resolveOneHop(value.whenFalse, resolveName), sourceFile)
      branches = branches.flatMap(branch => [
        new Map(branch).set(cssName, whenTrue),
        new Map(branch).set(cssName, whenFalse),
      ])
      if (branches.length > styleBranchLimit) branches = branches.slice(0, styleBranchLimit)
      continue
    }
    const resolved = styleValueOf(value, sourceFile)
    for (const branch of branches) branch.set(cssName, resolved)
  }
  return branches
}

// getText must receive the source file explicitly: program-loaded nodes carry no parent
// pointers, and the argless overload walks them.
function styleValueOf(expression: ts.Expression, sourceFile: ts.SourceFile): StyleValue {
  if (ts.isStringLiteralLike(expression)) return {kind: 'literal', text: expression.text}
  if (ts.isNumericLiteral(expression)) return {kind: 'literal', text: expression.text}
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(expression.operand)) {
    return {kind: 'literal', text: `-${expression.operand.text}`}
  }
  return {kind: 'dynamic', text: expression.getText(sourceFile)}
}

// Per-property comparison between two style branches. A map entry of null marks a
// dynamic-against-dynamic disagreement — not decidable, so the caller records coverage instead
// of claiming a finding.
function compareStyleBranches(
  base: StyleBranch,
  other: StyleBranch,
): Map<string, {detail: string; magnitudePx: number | null; unproven: boolean} | null> {
  const results = new Map<string, {detail: string; magnitudePx: number | null; unproven: boolean} | null>()
  for (const cssName of new Set([...base.keys(), ...other.keys()])) {
    const from = base.get(cssName)
    const to = other.get(cssName)
    if (from == null || to == null) {
      const present = (from ?? to)!
      results.set(cssName, {
        detail: from == null
          ? `unset vs ${renderStyleValue(present)}`
          : `${renderStyleValue(present)} vs unset`,
        magnitudePx: null,
        unproven: present.kind === 'dynamic',
      })
      continue
    }
    if (from.text === to.text && from.kind === to.kind) continue
    if (from.kind === 'dynamic' && to.kind === 'dynamic') {
      results.set(cssName, null)
      continue
    }
    const fromPx = literalPixels(from)
    const toPx = literalPixels(to)
    results.set(cssName, {
      detail: `${renderStyleValue(from)} vs ${renderStyleValue(to)}`,
      magnitudePx: fromPx != null && toPx != null ? Math.abs(toPx - fromPx) : null,
      unproven: from.kind === 'dynamic' || to.kind === 'dynamic',
    })
  }
  return results
}

function renderStyleValue(value: StyleValue): string {
  return value.kind === 'literal' ? `'${value.text}'` : `dynamic \`${value.text}\``
}

function literalPixels(value: StyleValue): number | null {
  if (value.kind !== 'literal') return null
  const match = value.text.match(/^(-?\d+(?:\.\d+)?)(px)?$/)
  return match == null ? null : Number(match[1])
}

// Element-level state swaps: a JSX child that is a conditional whose branches are elements.
// `{isEditing ? <input className="h-7"/> : <span className="text-sm"/>}` swaps one root box for
// another — the same claim a conditional className makes, one syntax level up. Each branch
// contributes its ROOT's className tokens and modeled style literals; the roots' children are
// out of scope (their own attributes are audited when the walk reaches them). A branch that is
// neither an element nor provably empty — a fragment, a mapped list, a variable — is a
// dynamicChildBranch coverage record, never a guess.
type ChildArm =
  | {kind: 'element'; opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement}
  | {kind: 'absent'}
  | {kind: 'opaque'}

function flattenChildArms(expression: ts.Expression, conditions: ts.Expression[], arms: ChildArm[]): void {
  if (arms.length >= branchLimit) return
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  if (ts.isConditionalExpression(unwrapped)) {
    conditions.push(unwrapped.condition)
    flattenChildArms(unwrapped.whenTrue, conditions, arms)
    flattenChildArms(unwrapped.whenFalse, conditions, arms)
    return
  }
  if (ts.isBinaryExpression(unwrapped)) {
    const operator = unwrapped.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      conditions.push(unwrapped.left)
      flattenChildArms(unwrapped.right, conditions, arms)
      arms.push({kind: 'absent'})
      return
    }
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      conditions.push(unwrapped.left)
      flattenChildArms(unwrapped.left, conditions, arms)
      flattenChildArms(unwrapped.right, conditions, arms)
      return
    }
    arms.push({kind: 'opaque'})
    return
  }
  if (ts.isJsxElement(unwrapped)) {
    arms.push({kind: 'element', opening: unwrapped.openingElement})
    return
  }
  if (ts.isJsxSelfClosingElement(unwrapped)) {
    arms.push({kind: 'element', opening: unwrapped})
    return
  }
  // Renders nothing: null, undefined, booleans, and the empty string.
  if (unwrapped.kind === ts.SyntaxKind.NullKeyword
    || unwrapped.kind === ts.SyntaxKind.TrueKeyword || unwrapped.kind === ts.SyntaxKind.FalseKeyword
    || (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined')
    || (ts.isStringLiteralLike(unwrapped) && unwrapped.text === '')) {
    arms.push({kind: 'absent'})
    return
  }
  arms.push({kind: 'opaque'})
}

function auditConditionalChild(
  container: ts.JsxExpression,
  sourceFile: ts.SourceFile,
  audit: StateGeometryFileAudit,
  context: {
    propIndex: PropLiteralIndex | undefined
    resolveName: (name: string) => ts.Expression | null
    insideOverlay: boolean
    tailwind: boolean
  },
): void {
  const expression = container.expression
  if (expression == null) return
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression
  const conditionalForm = ts.isConditionalExpression(unwrapped)
    || (ts.isBinaryExpression(unwrapped) && (
      unwrapped.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || unwrapped.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
  if (!conditionalForm) return
  const conditions: ts.Expression[] = []
  const arms: ChildArm[] = []
  flattenChildArms(unwrapped, conditions, arms)
  const line = sourceFile.getLineAndCharacterOfPosition(container.getStart(sourceFile)).line + 1
  if (arms.some(arm => arm.kind === 'opaque')) {
    audit.coverage.push({file: audit.file, line, reason: 'dynamicChildBranch'})
  }
  const compared = arms.filter(arm => arm.kind !== 'opaque')
  if (compared.length < 2 || !compared.some(arm => arm.kind === 'element')) return

  // Representative root geometry per arm: the first extracted className branch (the root's own
  // conditionality is the className channel's claim, not this one's) and the first style branch.
  const rootTokens = (opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string[] => {
    const attribute = opening.attributes.properties.find((property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name)
      && (property.name.text === 'className' || property.name.text === 'class'))
    const initializer = attribute?.initializer
    const attributeExpression = initializer == null
      ? null
      : ts.isStringLiteral(initializer)
        ? initializer
        : ts.isJsxExpression(initializer) && initializer.expression != null
          ? initializer.expression
          : null
    if (attributeExpression == null) return []
    return extractBranches(attributeExpression).branches[0] ?? []
  }
  const rootStyle = (opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): StyleBranch => {
    const attribute = opening.attributes.properties.find((property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === 'style')
    const initializer = attribute?.initializer
    if (initializer == null || !ts.isJsxExpression(initializer) || initializer.expression == null) {
      return new Map()
    }
    const branches = extractStyleBranches(
      resolveOneHop(initializer.expression, context.resolveName), sourceFile, context.resolveName, [])
    return branches?.[0] ?? new Map()
  }

  const {mobility, evidence} = classifyDiscriminants(conditions, container, sourceFile, context.propIndex)
  // An absent arm is vacuously bounded: nothing in flow. An element arm is bounded when it is
  // out of normal flow in every branch of its own className — an appearing overlay cannot
  // displace a sibling, however live its discriminant.
  const armBounded = (arm: ChildArm): boolean =>
    arm.kind === 'absent' || (context.tailwind && arm.kind === 'element' && elementAlwaysOutOfFlow(arm.opening))
  const base = compared[0]!
  for (let index = 1; index < compared.length; index++) {
    const other = compared[index]!
    if (base.kind === 'absent' && other.kind === 'absent') continue
    const involvesAbsent = base.kind === 'absent' || other.kind === 'absent'
    const selfBounded = armBounded(base) && armBounded(other)
    const bounded = selfBounded || context.insideOverlay
    const overlayClause = (overlay: boolean): string | null =>
      overlay ? selfBounded ? 'out of flow in every branch' : 'inside an out-of-flow ancestor' : null
    const absentClause = involvesAbsent ? 'one branch renders no element' : null
    let emitted = false

    const tokenDifferences = context.tailwind
      ? compareTokensAcrossIntervals(
        base.kind === 'element' ? rootTokens(base.opening) : [],
        other.kind === 'element' ? rootTokens(other.opening) : [])
      : []
    for (const difference of tokenDifferences) {
      // Two mounted elements disagreeing on position toggle the flow mode — the opposite of an
      // overlay; an element appearing against nothing keeps its bound whatever families differ.
      const overlay = bounded && (involvesAbsent || !difference.keys.includes('position'))
      const clauses = [evidence, absentClause, overlayClause(overlay)].filter(clause => clause != null)
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'childGeometry',
        severity: liveSeverity(mobility, transformOnlyFamilies(difference.keys) || overlay),
        evidence: clauses.join('; '),
        magnitudePx: difference.magnitudePx,
        detail: `branch roots disagree${difference.label == null ? '' : ` ${difference.label}`}: `
          + difference.detail.replace('state shifts layout: ', ''),
      })
      emitted = true
    }

    let sawDynamicDisagreement = false
    const reported = new Set<string>()
    for (const [cssName, difference] of compareStyleBranches(
      base.kind === 'element' ? rootStyle(base.opening) : new Map(),
      other.kind === 'element' ? rootStyle(other.opening) : new Map())) {
      if (difference == null) {
        sawDynamicDisagreement = true
        continue
      }
      if (reported.has(cssName + difference.detail)) continue
      reported.add(cssName + difference.detail)
      const overlay = bounded && (involvesAbsent || (cssName !== 'display' && cssName !== 'position'))
      const clauses = [
        evidence,
        absentClause,
        difference.unproven ? 'a runtime branch differs unless proven equal' : null,
        overlayClause(overlay),
      ].filter(clause => clause != null)
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'childGeometry',
        severity: liveSeverity(mobility, overlay),
        evidence: clauses.join('; '),
        magnitudePx: difference.magnitudePx,
        detail: `branch root style ${cssName} ${difference.detail}`,
      })
      emitted = true
    }
    if (sawDynamicDisagreement) {
      audit.coverage.push({file: audit.file, line, reason: 'dynamicChildBranch'})
    }
    if (emitted) break
  }
}

function collectInstance(
  element: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  component: string,
  template: ComponentTemplate,
  sourceFile: ts.SourceFile,
  audit: StateGeometryFileAudit,
): void {
  const line = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1
  const attribute = element.attributes.properties.find(property =>
    ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === 'className')
  let callBranches: string[][] = [[]]
  if (attribute != null && ts.isJsxAttribute(attribute) && attribute.initializer != null) {
    const initializer = attribute.initializer
    const expression = ts.isStringLiteral(initializer)
      ? initializer
      : ts.isJsxExpression(initializer) && initializer.expression != null
        ? initializer.expression
        : null
    if (expression != null) {
      const extraction = extractBranches(expression)
      callBranches = extraction.branches
      if (!extraction.complete) {
        audit.coverage.push({file: audit.file, line, reason: 'dynamicClassPart'})
      }
    }
  }
  // Representative box: the first template branch with the first call-site branch substituted at
  // the hole. Call-site conditionals are already covered by the per-expression analysis.
  const templateBranch = template.branches.find(branch => branch.includes(holeToken)) ?? template.branches[0] ?? []
  const callBranch = callBranches[0] ?? []
  const effective = templateBranch.flatMap(token => token === holeToken ? callBranch : [token])
  audit.instances.push({component, template, file: audit.file, line, tokens: effective})
}

// The geometry families a token list touches, independent of width or override resolution — the
// component-ownership axis only needs to know which families the template itself speaks for.
function syntacticGeometryKeys(tokens: string[]): Set<string> {
  const keys = new Set<string>()
  for (const token of tokens) {
    const parsed = classifyToken(token)
    if (parsed.kind !== 'geometry') continue
    const spread = edgeSpread(parsed.family)
    if (spread != null) {
      for (const edge of spread.edges) keys.add(`${spread.group}:${edge}`)
    } else {
      keys.add(parsed.family)
    }
  }
  return keys
}

function auditClassAttribute(
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  audit: StateGeometryFileAudit,
  propIndex: PropLiteralIndex | undefined,
  insideOverlay: boolean,
): void {
  const initializer = attribute.initializer
  if (initializer == null) return
  const line = sourceFile.getLineAndCharacterOfPosition(attribute.getStart(sourceFile)).line + 1
  const expression = ts.isStringLiteral(initializer)
    ? initializer
    : ts.isJsxExpression(initializer) && initializer.expression != null
      ? initializer.expression
      : null
  if (expression == null) return
  const conditions: ts.Expression[] = []
  const extraction = extractBranches(expression, undefined, conditions)
  if (!extraction.complete) {
    audit.coverage.push({file: audit.file, line, reason: extraction.overflow ? 'branchFanOut' : 'dynamicClassPart'})
  }
  const branches = extraction.branches.slice(0, branchLimit)

  // Findings still come from the branches that were extracted: a geometry delta between two
  // literal branches is real regardless of any dynamic remainder. Branches are evaluated to local
  // box arithmetic, so token spellings that produce identical geometry (border p-4 vs p-[17px])
  // compare equal and compensated states are dismissed rather than flagged.
  for (let index = 1; index < branches.length; index++) {
    const differences = compareTokensAcrossIntervals(branches[0]!, branches[index]!)
    if (differences.length === 0) continue
    const {mobility, evidence} = classifyDiscriminants(conditions, attribute, sourceFile, propIndex)
    // Overlay bounding for this comparison: out of flow in both branches (and the branches not
    // disagreeing on position itself), or nested inside an always-out-of-flow ancestor.
    const selfOverlay = outOfFlowTokens(branches[0]!) && outOfFlowTokens(branches[index]!)
    const ancestorOverlay = selfOverlay ? false : insideOverlay
    for (const difference of differences) {
      const overlay = (selfOverlay || ancestorOverlay) && !difference.keys.includes('position')
      const timing = transitionNote(difference.keys, [...branches[0]!, ...branches[index]!])
      const clauses = [
        evidence,
        overlay ? selfOverlay ? 'out of flow in every branch' : 'inside an out-of-flow ancestor' : null,
        timing == null ? null : `transition: ${timing}`,
      ].filter(clause => clause != null)
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'branchGeometry',
        severity: liveSeverity(mobility, transformOnlyFamilies(difference.keys) || overlay),
        evidence: clauses.join('; '),
        magnitudePx: difference.magnitudePx,
        detail: difference.label == null
          ? difference.detail
          : difference.detail.replace('state shifts layout: ', `state shifts layout ${difference.label}: `),
      })
    }
    break
  }

  for (const branch of branches) {
    const baseFamilies = new Map<string, {family: string; value: string}>()
    for (const token of branch) {
      const parsed = classifyToken(token)
      if (parsed.variants.length === 0 && parsed.kind === 'geometry') {
        baseFamilies.set(canonicalTransform(parsed.family)?.family ?? parsed.family,
          {family: parsed.family, value: parsed.value})
      }
    }
    const reported = new Set<string>()
    for (const token of branch) {
      const parsed = classifyToken(token)
      if (parsed.kind !== 'geometry') continue
      const stateVariants = parsed.variants.filter(variant => stateVariantPattern.test(variant))
      if (stateVariants.length === 0) continue
      const canonicalFamily = canonicalTransform(parsed.family)?.family ?? parsed.family
      const base = baseFamilies.get(canonicalFamily)
      if (base != null && base.family === parsed.family && base.value === parsed.value) continue
      const key = `${audit.file}:${token}`
      if (reported.has(key)) continue
      reported.add(key)
      const sign = (family: string): number => canonicalTransform(family)?.sign ?? 1
      const variantMagnitude = pixelsOf(parsed.family, parsed.value)
      const variantPx = variantMagnitude == null ? null : sign(parsed.family) * variantMagnitude
      const baseMagnitude = base == null ? 0 : pixelsOf(base.family, base.value)
      const basePx = base == null ? 0 : baseMagnitude == null ? null : sign(base.family) * baseMagnitude
      const magnitudePx = variantPx != null && basePx != null ? Math.abs(variantPx - basePx) : null
      if (magnitudePx === 0) continue
      // Overlay bounding: the variant fires on a mounted element whose base position is already
      // out of flow (or whose ancestor is), unless the variant toggles position itself.
      const selfOutOfFlow = outOfFlowTokens(branch)
      const overlay = parsed.family !== 'position' && (selfOutOfFlow || insideOverlay)
      const timing = transitionNote([parsed.family], branch)
      const clauses = [
        'pseudo-state variants transition on mounted elements',
        overlay ? selfOutOfFlow ? 'out of flow in every branch' : 'inside an out-of-flow ancestor' : null,
        timing == null ? null : `transition: ${timing}`,
      ].filter(clause => clause != null)
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'variantGeometry',
        severity: liveSeverity('mobile', transformOnlyFamilies([parsed.family]) || overlay),
        evidence: clauses.join('; '),
        magnitudePx,
        detail: base == null
          ? `'${token}' adds ${parsed.family}${variantMagnitude == null ? '' : ` (+${trim(variantMagnitude)}px)`} on a state with no base reservation`
          : `'${token}' changes ${canonicalFamily} from the base '${base.family.startsWith('-') ? '-' : ''}${base.value}' on a state`,
      })
    }
  }
}


// One rule for both live finding sites: a sibling-safe (bounded) difference is motion however
// mobile its discriminant, an immobile discriminant is configuration either way, and only an
// unbounded difference distinguishes live shift from unresolved. Pseudo-state variants fire on
// mounted elements, so the variant site passes 'mobile'.
function liveSeverity(mobility: Mobility, bounded: boolean): StateGeometryFinding['severity'] {
  if (mobility === 'immobile') return 'config'
  if (bounded) return 'motion'
  return mobility === 'mobile' ? 'shift' : 'unclear'
}

// An element that is absolutely positioned or fixed in EVERY branch is out of normal flow in
// every state, so no difference between its branches can displace a sibling — the change is
// bounded to the overlay itself. The claim needs the position utility variantless (a responsive
// or state-gated `absolute` proves nothing about the other widths and states), and it is void
// when the branches disagree on position: a state that toggles the flow mode itself is the
// opposite of an overlay — siblings collapse in or get pushed out, top-tier shift.
function outOfFlowTokens(tokens: string[]): boolean {
  for (const token of tokens) {
    const parsed = classifyToken(token)
    if (parsed.family === 'position' && parsed.variants.length === 0
      && (parsed.value === 'absolute' || parsed.value === 'fixed')) return true
  }
  return false
}

// How the difference plays out in time. The same token list that declares the state's geometry
// declares its transitions, so the scan can say whether the change snaps, tweens smoothly, or
// animates a reflow — the failure modes live in the journey between states, not just at the two
// ends. Only variantless transition utilities count; keyframe `animate-*` utilities are outside
// this claim. Returns null when no transition is declared (the change is simply instant).
function transitionNote(families: Iterable<string>, tokens: string[]): string | null {
  let scope: 'all' | 'default' | 'transform' | 'paint' | 'none' | null = null
  let arbitrary: string | null = null
  const broadness = {none: 0, paint: 1, transform: 2, default: 3, all: 4} as const
  for (const token of tokens) {
    const parsed = classifyToken(token)
    if (parsed.variants.length > 0) continue
    const bare = token
    if (bare === 'transition' || bare === 'transition-DEFAULT') {
      if (scope == null || broadness[scope] < broadness.default) scope = 'default'
    } else if (bare === 'transition-all') scope = 'all'
    else if (bare === 'transition-none') scope ??= 'none'
    else if (bare === 'transition-transform') {
      if (scope == null || broadness[scope] < broadness.transform) scope = 'transform'
    } else if (/^transition-(colors|opacity|shadow)$/.test(bare)) {
      if (scope == null || broadness[scope] < broadness.paint) scope = 'paint'
    } else if (/^transition-\[.+\]$/.test(bare)) arbitrary = bare.slice('transition-['.length, -1)
  }
  if (scope == null && arbitrary == null) return null
  if (scope === 'none') return null

  const shorthandCss: Record<string, string> = {
    'w': 'width', 'h': 'height', 'max-w': 'max-width', 'max-h': 'max-height',
    'min-w': 'min-width', 'min-h': 'min-height', 'gap': 'gap', 'inset': 'inset',
  }
  const cssName = (family: string): string => {
    if (transformFamilyPattern.test(family)) return 'transform'
    const bare = family.replace(/^-/, '')
    const cell = bare.match(/^(border|padding|margin):/)
    if (cell != null) return cell[1]!
    return shorthandCss[bare] ?? bare
  }
  const covered = (family: string): boolean => {
    if (family === 'display' || family === 'position') return false
    if (arbitrary != null && arbitrary.includes(cssName(family))) return true
    if (scope === 'all') return true
    if (scope === 'default' || scope === 'transform') return transformFamilyPattern.test(family)
    return false
  }

  const familyArray = [...families]
  if (familyArray.some(family => family === 'display' || family === 'position')) {
    return 'a declared transition cannot tween display or position, so the flip pops'
  }
  const tweenNames = new Set<string>()
  const snapNames = new Set<string>()
  for (const family of familyArray) (covered(family) ? tweenNames : snapNames).add(cssName(family))
  if (snapNames.size === 0) {
    return [...tweenNames].every(name => name === 'transform')
      ? 'the differing transforms tween under the declared transition'
      : `box properties (${[...tweenNames].join(', ')}) tween under the declared transition — layout reflows every frame of it`
  }
  if (tweenNames.size === 0) return 'the declared transition covers none of the differing properties, so the change snaps beside it'
  return `partial tween: ${[...tweenNames].join(', ')} tween while ${[...snapNames].join(', ')} snap mid-flight`
}

type BranchExtraction = {branches: string[][]; complete: boolean; overflow: boolean}

function extractBranches(
  expression: ts.Expression,
  holeName?: string,
  conditions?: ts.Expression[],
): BranchExtraction {
  if (holeName != null && ts.isIdentifier(expression) && expression.text === holeName) {
    return {branches: [[holeToken]], complete: true, overflow: false}
  }
  if (ts.isParenthesizedExpression(expression)) return extractBranches(expression.expression, holeName, conditions)
  if (ts.isStringLiteralLike(expression)) return single(expression.text)
  if (ts.isConditionalExpression(expression)) {
    conditions?.push(expression.condition)
    return unionOf([
      extractBranches(expression.whenTrue, holeName, conditions),
      extractBranches(expression.whenFalse, holeName, conditions),
    ])
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      conditions?.push(expression.left)
      return unionOf([extractBranches(expression.right, holeName, conditions), single('')])
    }
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      conditions?.push(expression.left)
      return unionOf([
        extractBranches(expression.left, holeName, conditions),
        extractBranches(expression.right, holeName, conditions),
      ])
    }
    if (operator === ts.SyntaxKind.PlusToken) {
      return crossProduct([
        extractBranches(expression.left, holeName, conditions),
        extractBranches(expression.right, holeName, conditions),
      ])
    }
    return dynamic()
  }
  if (ts.isTemplateExpression(expression)) {
    const parts: BranchExtraction[] = [single(expression.head.text)]
    for (const span of expression.templateSpans) {
      parts.push(extractBranches(span.expression, holeName, conditions))
      parts.push(single(span.literal.text))
    }
    return crossProduct(parts)
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && classCombinerNames.has(expression.expression.text.toLowerCase())) {
    return crossProduct(expression.arguments.map(argument => extractBranches(argument, holeName, conditions)))
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const parts: BranchExtraction[] = []
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))) {
        conditions?.push(property.initializer)
        parts.push(unionOf([single(property.name.text), single('')]))
      } else {
        parts.push(dynamic())
      }
    }
    return crossProduct(parts)
  }
  return dynamic()
}

function single(text: string): BranchExtraction {
  return {branches: [text.split(/\s+/).filter(token => token !== '')], complete: true, overflow: false}
}

function dynamic(): BranchExtraction {
  return {branches: [[]], complete: false, overflow: false}
}

function unionOf(parts: BranchExtraction[]): BranchExtraction {
  const branches = parts.flatMap(part => part.branches)
  const overflow = branches.length > branchLimit || parts.some(part => part.overflow)
  return {
    branches: branches.slice(0, branchLimit),
    complete: parts.every(part => part.complete) && branches.length <= branchLimit,
    overflow,
  }
}

function crossProduct(parts: BranchExtraction[]): BranchExtraction {
  let branches: string[][] = [[]]
  let overflow = parts.some(part => part.overflow)
  for (const part of parts) {
    const next: string[][] = []
    for (const left of branches) {
      for (const right of part.branches) {
        next.push([...left, ...right])
        if (next.length > branchLimit) break
      }
      if (next.length > branchLimit) break
    }
    if (branches.length * part.branches.length > branchLimit) overflow = true
    branches = next.slice(0, branchLimit)
  }
  return {branches, complete: parts.every(part => part.complete) && !overflow, overflow}
}

// Local box arithmetic per branch: border, padding, and margin resolve to pixels per physical
// edge through the Tailwind scale, so compensated spellings compare equal. Families the scale
// cannot quantify (display, position, symbolic sizes, unparsed values) stay categorical and are
// compared as normalized strings — a difference is still a finding, just unranked.
// cells: resolved pixels per property group and edge (`border:left`), null when equally
// targeted utilities disagree and stylesheet order would decide — an honest unknown.
type BranchBox = {
  cells: Map<string, number | null>
  categorical: Map<string, string>
}


// gateOrder models Tailwind's stylesheet ordering: media-variant blocks are emitted after the
// base utilities, so a responsive token beats an ungated one in its interval; among responsive
// tokens a higher threshold sorts later and wins.
type EdgeCandidate = {px: number; important: boolean; specificity: number; gateOrder: number}

export function evaluateBranchBox(tokens: string[], width: number | null = null): BranchBox {
  const box: BranchBox = {cells: new Map(), categorical: new Map()}
  // Candidates per property group and edge; groups then resolve independently and the edge total
  // sums the resolved groups, so `border p-4` adds while `border border-b-0` overrides.
  const cells = new Map<string, EdgeCandidate[]>()
  for (const token of tokens) {
    const parsed = classifyToken(token)
    if (parsed.kind !== 'geometry') continue
    if (parsed.variants.some(variant => stateVariantPattern.test(variant))) continue
    // Responsive variants gate the token to the evaluation width. Variants that are neither state
    // nor responsive (dark:, ltr:, print:), including mixed prefixes, keep their token out of the
    // width cells and compare as their own categorical dimension instead of merging with the base.
    const gates = parsed.variants.map(variant => responsiveGate(variant))
    if (gates.some(gate => gate == null) && parsed.variants.length > 0) {
      const transform = canonicalTransform(parsed.family)
      const key = `${parsed.variants.join(':')}:${transform?.family ?? parsed.family}`
      const normalized = pixelsOf(parsed.family, parsed.value)
      box.categorical.set(key, normalized == null
        ? parsed.value
        : `${trim((transform?.sign ?? 1) * normalized)}px`)
      continue
    }
    let gateOrder = 0
    if (gates.length > 0) {
      if (width == null) continue
      const applies = gates.every(gate =>
        gate!.kind === 'min' ? width >= gate!.px : width < gate!.px)
      if (!applies) continue
      gateOrder = Math.max(...gates.map(gate => gate!.px))
    }
    const spread = edgeSpread(parsed.family)
    const px = pixelsOf(parsed.family, parsed.value)
    if (spread != null && px != null) {
      // Tailwind orders all-edge utilities before axis pairs before single edges, so a more
      // targeted utility deterministically wins its edges; equal targeting with distinct values
      // depends on stylesheet order and stays unresolved.
      const specificity = spread.edges.length === 4 ? 0 : spread.edges.length === 2 ? 1 : 2
      for (const edge of spread.edges) {
        const key = `${spread.group}:${edge}`
        const cell = cells.get(key)
        const candidate = {px: spread.negative ? -px : px, important: parsed.important, specificity, gateOrder}
        if (cell == null) cells.set(key, [candidate])
        else cell.push(candidate)
      }
      continue
    }
    const transform = canonicalTransform(parsed.family)
    const key = `${parsed.variants.join(':')}${parsed.variants.length > 0 ? ':' : ''}${transform?.family ?? parsed.family}`
    const normalized = pixelsOf(parsed.family, parsed.value)
    box.categorical.set(key, normalized == null
      ? parsed.value
      : `${trim((transform?.sign ?? 1) * normalized)}px`)
  }
  for (const [key, candidates] of cells) {
    box.cells.set(key, resolveCell(candidates))
  }
  return box
}

// Thresholds declared by the tokens under comparison; the representatives sample one width per
// interval, including just below the lowest threshold.
export function tokenThresholds(tokenLists: string[][]): number[] {
  const thresholds = new Set<number>()
  for (const tokens of tokenLists) {
    for (const token of tokens) {
      for (const variant of classifyToken(token).variants) {
        const gate = responsiveGate(variant)
        if (gate != null) thresholds.add(gate.px)
      }
    }
  }
  return [...thresholds].sort((left, right) => left - right)
}

type IntervalDifference = {label: string | null; detail: string; magnitudePx: number | null; keys: string[]}

// Compare two token sets at every declared width interval and merge intervals whose differences
// read identically. A difference present at every width keeps no label, matching the
// width-independent report format.
function compareTokensAcrossIntervals(baseTokens: string[], otherTokens: string[]): IntervalDifference[] {
  const thresholds = tokenThresholds([baseTokens, otherTokens])
  if (thresholds.length === 0) {
    const difference = compareBranchBoxes(evaluateBranchBox(baseTokens), evaluateBranchBox(otherTokens))
    return difference == null ? [] : [{label: null, ...difference}]
  }
  const representatives = [thresholds[0]! - 1, ...thresholds]
  const perRepresentative = representatives.map(width =>
    compareBranchBoxes(evaluateBranchBox(baseTokens, width), evaluateBranchBox(otherTokens, width)))
  if (perRepresentative.every(difference => difference == null)) return []
  const uniform = perRepresentative.every(difference =>
    difference != null && difference.detail === perRepresentative[0]?.detail)
  if (uniform) return [{label: null, ...perRepresentative[0]!}]

  const labelFor = (startIndex: number, endIndex: number): string => {
    const from = startIndex === 0 ? null : representatives[startIndex]!
    const to = endIndex === representatives.length - 1 ? null : thresholds[endIndex]!
    if (from == null && to != null) return `below ${to}px`
    if (from != null && to == null) return `from ${from}px`
    return `${from}–${to! - 1}px`
  }
  const merged: IntervalDifference[] = []
  let runStart = 0
  for (let index = 1; index <= perRepresentative.length; index++) {
    const current = index < perRepresentative.length ? perRepresentative[index] : undefined
    const previous = perRepresentative[runStart]
    const same = index < perRepresentative.length
      && (current?.detail ?? null) === (previous?.detail ?? null)
    if (same) continue
    if (previous != null) {
      merged.push({label: labelFor(runStart, index - 1), ...previous})
    }
    runStart = index
  }
  return merged
}

function resolveCell(candidates: EdgeCandidate[]): number | null {
  const importantValues = new Set(candidates.filter(candidate => candidate.important).map(candidate => candidate.px))
  if (importantValues.size === 1) return [...importantValues][0]!
  if (importantValues.size > 1) return null
  const topGate = Math.max(...candidates.map(candidate => candidate.gateOrder))
  const gated = candidates.filter(candidate => candidate.gateOrder === topGate)
  const top = Math.max(...gated.map(candidate => candidate.specificity))
  const values = new Set(gated.filter(candidate => candidate.specificity === top).map(candidate => candidate.px))
  return values.size === 1 ? [...values][0]! : null
}

function compareBranchBoxes(
  base: BranchBox,
  other: BranchBox,
): {detail: string; magnitudePx: number | null; keys: string[]} | null {
  const shifts: string[] = []
  let magnitude = 0
  const conflicts: string[] = []
  const keys: string[] = []
  for (const edge of edgeNames) {
    let inset = 0
    let margin = 0
    for (const group of ['border', 'padding', 'margin'] as const) {
      const key = `${group}:${edge}`
      const baseRaw = base.cells.get(key)
      const otherRaw = other.cells.get(key)
      const baseCell = baseRaw === undefined ? 0 : baseRaw
      const otherCell = otherRaw === undefined ? 0 : otherRaw
      if (baseCell == null || otherCell == null) {
        // One side is an unresolved same-specificity conflict: no numeric claim, but the
        // disagreement itself is visible.
        const baseText = baseCell == null ? 'unresolved conflict' : `${trim(baseCell)}px`
        const otherText = otherCell == null ? 'unresolved conflict' : `${trim(otherCell)}px`
        if (baseText !== otherText) {
          conflicts.push(`${group}(${edge}) '${baseText}' vs '${otherText}'`)
          keys.push(key)
        }
        continue
      }
      if (otherCell !== baseCell) keys.push(key)
      if (group === 'margin') margin += otherCell - baseCell
      else inset += otherCell - baseCell
    }
    if (inset !== 0) {
      shifts.push(`${edge} inset ${signed(inset)}px`)
      magnitude = Math.max(magnitude, Math.abs(inset))
    }
    if (margin !== 0) {
      shifts.push(`${edge} margin ${signed(margin)}px`)
      magnitude = Math.max(magnitude, Math.abs(margin))
    }
  }
  shifts.push(...conflicts)
  const categorical: string[] = []
  // A categorical family whose two sides both normalize to pixels (h-7 vs h-4, text-sm vs
  // text-lg, opposite translate spellings) is decidable arithmetic: it ranks by its delta
  // instead of hiding behind a null magnitude.
  let quantifiedCategorical = false
  const families = new Set([...base.categorical.keys(), ...other.categorical.keys()])
  for (const family of [...families].sort()) {
    const from = base.categorical.get(family)
    const to = other.categorical.get(family)
    if (from !== to) {
      categorical.push(`${family} '${from ?? 'none'}' vs '${to ?? 'none'}'`)
      keys.push(family)
      const fromPx = categoricalPixels(from)
      const toPx = categoricalPixels(to)
      if (fromPx != null && toPx != null) {
        magnitude = Math.max(magnitude, Math.abs(toPx - fromPx))
        quantifiedCategorical = true
      }
    }
  }
  if (shifts.length === 0 && categorical.length === 0) return null
  const parts = [...shifts, ...categorical]
  return {
    detail: `state shifts layout: ${parts.join(', ')}`,
    magnitudePx: shifts.length > 0 || quantifiedCategorical ? magnitude : null,
    keys,
  }
}

function categoricalPixels(text: string | undefined): number | null {
  if (text == null) return null
  const match = text.match(/^(-?\d+(?:\.\d+)?)px$/)
  return match == null ? null : Number(match[1])
}

function signed(value: number): string {
  return value > 0 ? `+${trim(value)}` : `${trim(value)}`
}

function trim(value: number): string {
  return `${Number(value.toFixed(3))}`
}


// The structured report: everything the text report says, as data — for tooling that diffs scans
// across worktrees (a PR battery) instead of parsing prose. Finding files and instance anchor
// files are relativized against the scan root so two checkouts of the same tree produce
// comparable findings.
export type StateGeometryReportData = {
  findings: StateGeometryFinding[]
  coverage: number
  counts: {shift: number; motion: number; unclear: number; config: number}
}

export function stateGeometryReportData(
  audits: StateGeometryFileAudit[],
  instanceFindings: StateGeometryFinding[] = [],
  rootDirectory?: string,
): StateGeometryReportData {
  const prefix = rootDirectory == null ? null : rootDirectory.endsWith('/') ? rootDirectory : `${rootDirectory}/`
  const relativize = (text: string): string => prefix == null ? text : text.replaceAll(prefix, '')
  const findings = sortFindings([...audits.flatMap(audit => audit.findings), ...instanceFindings])
    .map(finding => ({
      ...finding,
      file: relativize(finding.file),
      detail: relativize(finding.detail),
      ...(finding.anchor == null ? {} : {anchor: {file: relativize(finding.anchor.file), line: finding.anchor.line}}),
    }))
  const tally = (severity: StateGeometryFinding['severity']): number =>
    findings.filter(finding => finding.severity === severity).length
  return {
    findings,
    coverage: audits.reduce((total, audit) => total + audit.coverage.length, 0),
    counts: {shift: tally('shift'), motion: tally('motion'), unclear: tally('unclear'), config: tally('config')},
  }
}

// Live shifts first, then unresolved, then paint-only motion, then configuration; largest
// movement on top within a tier.
function sortFindings(findings: StateGeometryFinding[]): StateGeometryFinding[] {
  const rank = (finding: StateGeometryFinding): number =>
    finding.severity === 'shift' ? 3 : finding.severity === 'unclear' ? 2 : finding.severity === 'motion' ? 1 : 0
  return [...findings].sort((left, right) =>
    rank(right) - rank(left) || (right.magnitudePx ?? -1) - (left.magnitudePx ?? -1))
}

export function formatStateGeometryReport(
  audits: StateGeometryFileAudit[],
  instanceFindings: StateGeometryFinding[] = [],
): string {
  const data = stateGeometryReportData(audits, instanceFindings)
  const kindText = (finding: StateGeometryFinding): string => {
    switch (finding.kind) {
      case 'branchGeometry': return 'state changes geometry'
      case 'variantGeometry': return 'state variant changes geometry'
      case 'instanceGeometry': return 'component instances disagree on geometry'
      case 'styleGeometry': return 'state changes style geometry'
      case 'childGeometry': return 'conditional children change geometry'
    }
  }
  const lines = data.findings.map(finding =>
    `[${finding.severity}] ${finding.file}:${finding.line} ${kindText(finding)}: ${finding.detail}`
    + `${finding.anchor == null ? '' : ` (vs ${finding.anchor.file}:${finding.anchor.line})`}`
    + ` (${finding.evidence})`)
  lines.push(
    `state geometry: ${data.findings.length} finding${data.findings.length === 1 ? '' : 's'} `
    + `(${data.counts.shift} shift, ${data.counts.motion} motion, ${data.counts.unclear} unclear, ${data.counts.config} config); `
    + `${data.coverage} expression${data.coverage === 1 ? '' : 's'} partly dynamic`)
  return lines.join('\n')
}

// Structured breakpoint report for the same tooling audience.
export type BreakpointReportData = {
  breakpoints: Array<{thresholdPx: number; variants: Array<{variant: string; count: number}>}>
  seams: number[]
}

export function breakpointReportData(usage: Map<number, BreakpointUsage>): BreakpointReportData {
  const thresholds = [...usage.values()].sort((left, right) => left.thresholdPx - right.thresholdPx)
  return {
    breakpoints: thresholds.map(entry => ({
      thresholdPx: entry.thresholdPx,
      variants: [...entry.variants.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([variant, count]) => ({variant, count})),
    })),
    seams: [...new Set(thresholds.flatMap(entry => [entry.thresholdPx - 1, entry.thresholdPx]))]
      .sort((left, right) => left - right),
  }
}
