import * as ts from 'typescript'

// State-variant geometry scan: across the branches of one conditional className expression, only
// paint may vary — geometry must be invariant or explicitly reserved. A conditional border width,
// padding, size, display, or font-size means selecting that state moves layout; the fix is
// reserving the geometry (border-transparent) or meaning the shift. The scan reads syntax only,
// like the spacing scan: findings are advisory, dynamic parts become coverage rather than guesses,
// and it never type-checks and never fails the command.

export type StateGeometryFinding = {
  file: string
  line: number
  kind: 'branchGeometry' | 'variantGeometry' | 'instanceGeometry'
  // branchGeometry: two extracted branches evaluate to different local box geometry.
  // variantGeometry: a state-variant token adds or changes geometry with no matching base token.
  // instanceGeometry: two call sites of the same component evaluate to different effective boxes.
  detail: string
  // Largest per-edge pixel delta when the difference is quantifiable, null for categorical
  // changes (display, position, symbolic sizes). Reports rank by magnitude.
  magnitudePx: number | null
  // Two-axis severity. 'shift': the discriminant can change while the element is mounted (state or
  // pseudo-state), so the geometry difference is visible motion — or a call site overrides the
  // component template's own geometry. 'motion': the discriminant is (or may be) live, but every
  // differing family is a transform — translate, scale, rotate move pixels on screen without
  // reflowing neighbors, so nothing is displaced; slide-reveals and hover nudges land here.
  // 'config': provably immobile — every call site fixes the discriminant with a literal, or the
  // instance difference lies in caller-owned families the template never declared. 'unclear': the
  // bounded analysis cannot decide.
  severity: 'shift' | 'motion' | 'unclear' | 'config'
  evidence: string
}

export type StateGeometryCoverage = {
  file: string
  line: number
  reason: 'dynamicClassPart' | 'branchFanOut'
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

export type ComponentRegistry = Map<string, ComponentTemplate | 'ambiguous'>

export type ComponentInstance = {
  component: string
  file: string
  line: number
  tokens: string[]
}

const holeToken = '\u0000className'

// Which props of which components are only ever fed literals: `orientation="vertical"` at every
// call site means no mounted element can transition between the branches that prop selects.
export type PropLiteralIndex = Map<string, Map<string, 'literalOnly' | 'nonLiteral'>>

export function collectPropLiterals(sourceFile: ts.SourceFile, index: PropLiteralIndex): void {
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
          const literal = jsxAttributeIsLiteral(property)
          const previous = props.get(property.name.text)
          props.set(property.name.text, literal && previous !== 'nonLiteral' ? 'literalOnly' : 'nonLiteral')
        } else {
          // A spread can feed any prop anything.
          for (const key of props.keys()) props.set(key, 'nonLiteral')
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
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  propIndex: PropLiteralIndex | undefined,
): {mobility: Mobility; evidence: string} {
  if (conditions.length === 0) return {mobility: 'immobile', evidence: 'no conditions'}
  let sawUnknown = false
  let mobileEvidence: string | null = null
  let immobileEvidence: string | null = null
  const enclosing = enclosingComponent(attribute)
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
        if (usage === 'literalOnly' && !spread) {
          immobileEvidence = `every call site fixes '${name}' with a literal`
          continue
        }
        sawUnknown = true
        continue
      }
      sawUnknown = true
    }
  }
  if (mobileEvidence != null) return {mobility: 'mobile', evidence: mobileEvidence}
  if (sawUnknown) return {mobility: 'unknown', evidence: 'the discriminant could not be resolved'}
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
const tailwindScreens: Record<string, number> = {sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536}

// A responsive variant gates a token to a width interval: min-style (sm, md, min-[Npx]) applies
// at and above the threshold, max-style below it — Tailwind's max-md is width < 768px.
export function responsiveGate(variant: string): {kind: 'min' | 'max'; px: number} | null {
  const bare = variant.startsWith('max-') ? variant.slice(4) : variant
  const screen = tailwindScreens[bare]
  if (screen != null) return {kind: variant.startsWith('max-') ? 'max' : 'min', px: screen}
  const arbitrary = /^(min|max)-\[(\d+(?:\.\d+)?)px\]$/.exec(variant)
  if (arbitrary != null) return {kind: arbitrary[1] as 'min' | 'max', px: Number(arbitrary[2])}
  return null
}

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
      const bare = segment.startsWith('max-') ? segment.slice(4) : segment
      const screen = tailwindScreens[bare]
      if (screen != null) {
        record(screen, segment)
        continue
      }
      const arbitrary = /^(?:min|max)-\[(\d+(?:\.\d+)?)px\]$/.exec(segment)
      if (arbitrary != null) record(Number(arbitrary[1]), segment)
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
    registry.set(name, registry.has(name) ? 'ambiguous' : template)
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
// first, so one divergent call site is one finding.
export function compareComponentInstances(
  instances: ComponentInstance[],
  registry?: ComponentRegistry,
): StateGeometryFinding[] {
  const byComponent = new Map<string, ComponentInstance[]>()
  for (const instance of instances) {
    const list = byComponent.get(instance.component)
    if (list == null) byComponent.set(instance.component, [instance])
    else list.push(instance)
  }
  const findings: StateGeometryFinding[] = []
  for (const [component, list] of byComponent) {
    const template = registry?.get(component)
    const ownGeometry = template != null && template !== 'ambiguous' ? template.ownGeometry : new Set<string>()
    for (let index = 1; index < list.length; index++) {
      for (const difference of compareTokensAcrossIntervals(list[0]!.tokens, list[index]!.tokens)) {
        const overridesTemplate = difference.keys.some(key => ownGeometry.has(key))
        findings.push({
          file: list[index]!.file,
          line: list[index]!.line,
          kind: 'instanceGeometry',
          severity: overridesTemplate ? 'shift' : 'config',
          evidence: overridesTemplate
            ? 'a call site overrides geometry the component itself declares'
            : 'the difference is caller-owned sizing the template never declares',
          magnitudePx: difference.magnitudePx,
          detail: `<${component}> instances disagree${difference.label == null ? '' : ` ${difference.label}`} `
            + `(vs ${list[0]!.file}:${list[0]!.line}): `
            + difference.detail.replace('state shifts layout: ', ''),
        })
      }
    }
  }
  return findings
}

const classCombinerNames = new Set(['cn', 'clsx', 'cx', 'classnames', 'twmerge', 'twjoin'])
const stateVariantPattern = /^(hover|focus|focus-visible|focus-within|active|visited|disabled|checked|open|group-[\w[\]=-]+|peer-[\w[\]=-]+|data-\[[^\]]+\]|aria-\[[^\]]+\])$/
const branchLimit = 16

export function auditStateGeometrySource(file: string, source: string): StateGeometryFileAudit {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const registry: ComponentRegistry = new Map()
  collectComponentTemplates(sourceFile, registry)
  const propIndex: PropLiteralIndex = new Map()
  collectPropLiterals(sourceFile, propIndex)
  const audit = auditStateGeometryFile(sourceFile, registry, propIndex)
  audit.findings.push(...compareComponentInstances(audit.instances, registry))
  return audit
}

export function auditStateGeometryFile(
  sourceFile: ts.SourceFile,
  registry?: ComponentRegistry,
  propIndex?: PropLiteralIndex,
): StateGeometryFileAudit {
  const audit: StateGeometryFileAudit = {file: sourceFile.fileName, findings: [], coverage: [], instances: []}
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)
      && (node.name.text === 'className' || node.name.text === 'class')) {
      auditClassAttribute(node, sourceFile, audit, propIndex)
    }
    if (registry != null && (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node))
      && ts.isIdentifier(node.tagName)) {
      const template = registry.get(node.tagName.text)
      if (template != null && template !== 'ambiguous') {
        collectInstance(node, node.tagName.text, template, sourceFile, audit)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return audit
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
  audit.instances.push({component, file: audit.file, line, tokens: effective})
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
  propIndex?: PropLiteralIndex,
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
    for (const difference of differences) {
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'branchGeometry',
        // A transform-only difference is bounded to paint motion whatever the discriminant turns
        // out to be, so it outranks nothing but config even when mobility is unresolved.
        severity: transformOnlyFamilies(difference.keys)
          ? mobility === 'immobile' ? 'config' : 'motion'
          : mobility === 'mobile' ? 'shift' : mobility === 'immobile' ? 'config' : 'unclear',
        evidence,
        magnitudePx: difference.magnitudePx,
        detail: difference.label == null
          ? difference.detail
          : difference.detail.replace('state shifts layout: ', `state shifts layout ${difference.label}: `),
      })
    }
    break
  }

  for (const branch of branches) {
    const baseFamilies = new Map<string, string>()
    for (const token of branch) {
      const parsed = classifyToken(token)
      if (parsed.variants.length === 0 && parsed.kind === 'geometry') baseFamilies.set(parsed.family, parsed.value)
    }
    const reported = new Set<string>()
    for (const token of branch) {
      const parsed = classifyToken(token)
      if (parsed.kind !== 'geometry') continue
      const stateVariants = parsed.variants.filter(variant => stateVariantPattern.test(variant))
      if (stateVariants.length === 0) continue
      if (baseFamilies.get(parsed.family) === parsed.value) continue
      const key = `${audit.file}:${token}`
      if (reported.has(key)) continue
      reported.add(key)
      const base = baseFamilies.get(parsed.family)
      const variantPx = pixelsOf(parsed.family, parsed.value)
      const basePx = base == null ? 0 : pixelsOf(parsed.family, base)
      const magnitudePx = variantPx != null && basePx != null ? Math.abs(variantPx - basePx) : null
      if (magnitudePx === 0) continue
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'variantGeometry',
        severity: transformOnlyFamilies([parsed.family]) ? 'motion' : 'shift',
        evidence: 'pseudo-state variants transition on mounted elements',
        magnitudePx,
        detail: base == null
          ? `'${token}' adds ${parsed.family}${variantPx == null ? '' : ` (+${trim(variantPx)}px)`} on a state with no base reservation`
          : `'${token}' changes ${parsed.family} from the base '${base}' on a state`,
      })
    }
  }
}

// Transform families move pixels on screen without entering layout: neighbors never reflow, so a
// difference confined to them is motion, not displacement. Negative-value spellings keep the
// leading dash in the family name.
const transformFamilyPattern = /^-?(translate(-[xyz])?|scale(-[xy])?|rotate(-[xyz])?|skew(-[xy])?)$/

function transformOnlyFamilies(families: Iterable<string>): boolean {
  let any = false
  for (const family of families) {
    any = true
    if (!transformFamilyPattern.test(family)) return false
  }
  return any
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

const edgeNames = ['left', 'right', 'top', 'bottom'] as const

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
      const key = `${parsed.variants.join(':')}:${parsed.family}`
      const normalized = pixelsOf(parsed.family, parsed.value)
      box.categorical.set(key, normalized == null ? parsed.value : `${trim(normalized)}px`)
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
    const key = `${parsed.variants.join(':')}${parsed.variants.length > 0 ? ':' : ''}${parsed.family}`
    const normalized = pixelsOf(parsed.family, parsed.value)
    box.categorical.set(key, normalized == null ? parsed.value : `${trim(normalized)}px`)
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
  const families = new Set([...base.categorical.keys(), ...other.categorical.keys()])
  for (const family of [...families].sort()) {
    const from = base.categorical.get(family)
    const to = other.categorical.get(family)
    if (from !== to) {
      categorical.push(`${family} '${from ?? 'none'}' vs '${to ?? 'none'}'`)
      keys.push(family)
    }
  }
  if (shifts.length === 0 && categorical.length === 0) return null
  const parts = [...shifts, ...categorical]
  return {
    detail: `state shifts layout: ${parts.join(', ')}`,
    magnitudePx: shifts.length > 0 ? magnitude : null,
    keys,
  }
}

type EdgeSpread = {
  group: 'border' | 'padding' | 'margin'
  edges: readonly (typeof edgeNames)[number][]
  negative: boolean
}

function edgeSpread(family: string): EdgeSpread | null {
  const negative = family.startsWith('-')
  const bare = negative ? family.slice(1) : family
  const insetMap: Record<string, readonly (typeof edgeNames)[number][]> = {
    'border-width': edgeNames, 'border-width-x': ['left', 'right'], 'border-width-y': ['top', 'bottom'],
    'border-width-l': ['left'], 'border-width-r': ['right'], 'border-width-t': ['top'], 'border-width-b': ['bottom'],
    'border-width-s': ['left'], 'border-width-e': ['right'],
    p: edgeNames, px: ['left', 'right'], py: ['top', 'bottom'],
    pl: ['left'], pr: ['right'], pt: ['top'], pb: ['bottom'], ps: ['left'], pe: ['right'],
  }
  const marginMap: Record<string, readonly (typeof edgeNames)[number][]> = {
    m: edgeNames, mx: ['left', 'right'], my: ['top', 'bottom'],
    ml: ['left'], mr: ['right'], mt: ['top'], mb: ['bottom'], ms: ['left'], me: ['right'],
  }
  const inset = insetMap[bare]
  if (inset != null) {
    return {group: bare.startsWith('border') ? 'border' : 'padding', edges: inset, negative}
  }
  const margin = marginMap[bare]
  if (margin != null) return {group: 'margin', edges: margin, negative}
  return null
}

// Tailwind's default numeric scale is 4px per step; border widths default to 1px. Values outside
// the modeled forms return null and stay categorical rather than being guessed.
function pixelsOf(family: string, value: string): number | null {
  const bareFamily = family.startsWith('-') ? family.slice(1) : family
  if (bareFamily.startsWith('border-width')) {
    if (value === '' || value === '1') return value === '' ? 1 : 1
    if (/^\d+$/.test(value)) return Number(value)
    const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
    return arbitrary == null ? null : Number(arbitrary[1])
  }
  if (value === 'px') return 1
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 4
  const arbitraryPx = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
  if (arbitraryPx != null) return Number(arbitraryPx[1])
  const arbitraryRem = /^\[(\d+(?:\.\d+)?)rem\]$/.exec(value)
  if (arbitraryRem != null) return Number(arbitraryRem[1]) * 16
  return null
}

function signed(value: number): string {
  return value > 0 ? `+${trim(value)}` : `${trim(value)}`
}

function trim(value: number): string {
  return `${Number(value.toFixed(3))}`
}

type TokenClassification = {
  kind: 'geometry' | 'paint' | 'unknown'
  family: string
  value: string
  variants: string[]
  important: boolean
}

const displayUtilities = new Set(['block', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'flex', 'grid', 'hidden', 'contents', 'table'])
const positionUtilities = new Set(['absolute', 'relative', 'fixed', 'sticky', 'static'])
const fontSizeScale = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'])
const paintRoots = new Set(['bg', 'rounded', 'ring', 'outline', 'shadow', 'opacity', 'fill', 'stroke', 'decoration', 'divide', 'accent', 'caret', 'from', 'via', 'to'])
const spacingRoots = new Set(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'gap', 'gap-x', 'gap-y', 'space-x', 'space-y', 'w', 'h', 'size', 'min-w', 'min-h', 'max-w', 'max-h', 'inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end', 'leading', 'basis', 'indent', 'translate-x', 'translate-y'])

export function classifyToken(rawToken: string): TokenClassification {
  if (rawToken === holeToken) return {kind: 'unknown', family: 'className-hole', value: '', variants: [], important: false}
  const segments = rawToken.split(':')
  let utility = segments[segments.length - 1]!
  const variants = segments.slice(0, -1)
  let important = false
  if (utility.endsWith('!')) {
    important = true
    utility = utility.slice(0, -1)
  } else if (utility.startsWith('!')) {
    important = true
    utility = utility.slice(1)
  }
  const negative = utility.startsWith('-')
  const bare = negative ? utility.slice(1) : utility

  if (displayUtilities.has(bare)) return {kind: 'geometry', family: 'display', value: bare, variants, important}
  if (positionUtilities.has(bare)) return {kind: 'geometry', family: 'position', value: bare, variants, important}
  if (bare === 'grow' || bare === 'shrink' || bare === 'flex-1' || bare === 'flex-auto' || bare === 'flex-none' || bare === 'flex-initial') {
    return {kind: 'geometry', family: 'flex', value: bare, variants, important}
  }

  const dash = bare.indexOf('-')
  const root = dash === -1 ? bare : bare.slice(0, dash)
  const value = dash === -1 ? '' : bare.slice(dash + 1)

  if (root === 'border') {
    // 'border', 'border-2', 'border-t', 'border-t-2', 'border-[3px]' are widths (geometry);
    // 'border-transparent', 'border-red-500/50', 'border-t-light-100' are colors (paint);
    // 'border-solid'/'border-dashed' are style (paint: no layout effect once width is set).
    const parts = value === '' ? [] : value.split('-')
    const edge = parts.length > 0 && /^(t|r|b|l|x|y|s|e)$/.test(parts[0]!) ? parts.shift()! : ''
    const remainder = parts.join('-')
    if (remainder === '' || /^\d+$/.test(remainder) || /^\[\d+(px|rem|em)\]$/.test(remainder)) {
      return {kind: 'geometry', family: `border-width${edge === '' ? '' : `-${edge}`}`, value: remainder === '' ? '1' : remainder, variants, important}
    }
    if (/^(solid|dashed|dotted|double|none|hidden)$/.test(remainder)) {
      return {kind: 'paint', family: 'border-style', value: remainder, variants, important}
    }
    return {kind: 'paint', family: 'border-color', value: remainder, variants, important}
  }
  if (root === 'text') {
    if (fontSizeScale.has(value) || /^\[\d+(px|rem|em)\]$/.test(value)) {
      return {kind: 'geometry', family: 'font-size', value, variants, important}
    }
    return {kind: 'paint', family: 'text-color', value, variants, important}
  }
  if (spacingRoots.has(root) || spacingRoots.has(`${root}-${value.split('-')[0] ?? ''}`)) {
    const composite = spacingRoots.has(`${root}-${value.split('-')[0] ?? ''}`) ? `${root}-${value.split('-')[0]}` : root
    const amount = composite === root ? value : value.split('-').slice(1).join('-')
    return {kind: 'geometry', family: `${negative ? '-' : ''}${composite}`, value: amount, variants, important}
  }
  if (paintRoots.has(root)) return {kind: 'paint', family: root, value, variants, important}
  return {kind: 'unknown', family: root, value, variants, important}
}

export function formatStateGeometryReport(
  audits: StateGeometryFileAudit[],
  instanceFindings: StateGeometryFinding[] = [],
): string {
  const all = [...audits.flatMap(audit => audit.findings), ...instanceFindings]
  // Live shifts first, then unresolved, then paint-only motion, then configuration; largest
  // movement on top within a tier.
  const rank = (finding: StateGeometryFinding): number =>
    finding.severity === 'shift' ? 3 : finding.severity === 'unclear' ? 2 : finding.severity === 'motion' ? 1 : 0
  all.sort((left, right) => rank(right) - rank(left) || (right.magnitudePx ?? -1) - (left.magnitudePx ?? -1))
  const kindText = (finding: StateGeometryFinding): string =>
    finding.kind === 'branchGeometry'
      ? 'state changes geometry'
      : finding.kind === 'variantGeometry'
        ? 'state variant changes geometry'
        : 'component instances disagree on geometry'
  const lines = all.map(finding =>
    `[${finding.severity}] ${finding.file}:${finding.line} ${kindText(finding)}: ${finding.detail} (${finding.evidence})`)
  const coverage = audits.reduce((total, audit) => total + audit.coverage.length, 0)
  const tally = (severity: StateGeometryFinding['severity']): number =>
    all.filter(finding => finding.severity === severity).length
  lines.push(
    `state geometry: ${all.length} finding${all.length === 1 ? '' : 's'} `
    + `(${tally('shift')} shift, ${tally('motion')} motion, ${tally('unclear')} unclear, ${tally('config')} config); `
    + `${coverage} expression${coverage === 1 ? '' : 's'} partly dynamic`)
  return lines.join('\n')
}
