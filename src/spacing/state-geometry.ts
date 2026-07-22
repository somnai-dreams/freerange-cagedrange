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
  kind: 'branchGeometry' | 'variantGeometry'
  // branchGeometry: geometry token sets of two extracted branches differ.
  // variantGeometry: a state-variant token adds or changes geometry with no matching base token.
  detail: string
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
}

const classCombinerNames = new Set(['cn', 'clsx', 'cx', 'classnames', 'twmerge', 'twjoin'])
const stateVariantPattern = /^(hover|focus|focus-visible|focus-within|active|visited|disabled|checked|open|group-[\w[\]=-]+|peer-[\w[\]=-]+|data-\[[^\]]+\]|aria-\[[^\]]+\])$/
const branchLimit = 16

export function auditStateGeometrySource(file: string, source: string): StateGeometryFileAudit {
  return auditStateGeometryFile(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX))
}

export function auditStateGeometryFile(sourceFile: ts.SourceFile): StateGeometryFileAudit {
  const audit: StateGeometryFileAudit = {file: sourceFile.fileName, findings: [], coverage: []}
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)
      && (node.name.text === 'className' || node.name.text === 'class')) {
      auditClassAttribute(node, sourceFile, audit)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return audit
}

function auditClassAttribute(
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  audit: StateGeometryFileAudit,
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
  const extraction = extractBranches(expression)
  if (!extraction.complete) {
    audit.coverage.push({file: audit.file, line, reason: extraction.overflow ? 'branchFanOut' : 'dynamicClassPart'})
  }
  const branches = extraction.branches.slice(0, branchLimit)

  // Findings still come from the branches that were extracted: a geometry delta between two
  // literal branches is real regardless of any dynamic remainder.
  const geometryKeys = branches.map(branch => baseGeometryKey(branch))
  for (let index = 1; index < geometryKeys.length; index++) {
    if (geometryKeys[index] !== geometryKeys[0]) {
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'branchGeometry',
        detail: `branches disagree on geometry: [${geometryKeys[0] === '' ? 'none' : geometryKeys[0]!}] vs [${geometryKeys[index] === '' ? 'none' : geometryKeys[index]!}]`,
      })
      break
    }
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
      audit.findings.push({
        file: audit.file,
        line,
        kind: 'variantGeometry',
        detail: base == null
          ? `'${token}' adds ${parsed.family} on a state with no base reservation`
          : `'${token}' changes ${parsed.family} from the base '${base}' on a state`,
      })
    }
  }
}

type BranchExtraction = {branches: string[][]; complete: boolean; overflow: boolean}

function extractBranches(expression: ts.Expression): BranchExtraction {
  if (ts.isParenthesizedExpression(expression)) return extractBranches(expression.expression)
  if (ts.isStringLiteralLike(expression)) return single(expression.text)
  if (ts.isConditionalExpression(expression)) {
    return unionOf([extractBranches(expression.whenTrue), extractBranches(expression.whenFalse)])
  }
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return unionOf([extractBranches(expression.right), single('')])
    }
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return unionOf([extractBranches(expression.left), extractBranches(expression.right)])
    }
    if (operator === ts.SyntaxKind.PlusToken) {
      return crossProduct([extractBranches(expression.left), extractBranches(expression.right)])
    }
    return dynamic()
  }
  if (ts.isTemplateExpression(expression)) {
    const parts: BranchExtraction[] = [single(expression.head.text)]
    for (const span of expression.templateSpans) {
      parts.push(extractBranches(span.expression))
      parts.push(single(span.literal.text))
    }
    return crossProduct(parts)
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && classCombinerNames.has(expression.expression.text.toLowerCase())) {
    return crossProduct(expression.arguments.map(argument => extractBranches(argument)))
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const parts: BranchExtraction[] = []
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))) {
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

function baseGeometryKey(tokens: string[]): string {
  const families = new Map<string, string>()
  for (const token of tokens) {
    const parsed = classifyToken(token)
    if (parsed.kind === 'geometry' && parsed.variants.every(variant => !stateVariantPattern.test(variant))) {
      families.set(`${parsed.variants.join(':')}${parsed.variants.length > 0 ? ':' : ''}${parsed.family}`, parsed.value)
    }
  }
  return [...families.entries()].map(([family, value]) => `${family}=${value}`).sort().join(' ')
}

type TokenClassification = {
  kind: 'geometry' | 'paint' | 'unknown'
  family: string
  value: string
  variants: string[]
}

const displayUtilities = new Set(['block', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'flex', 'grid', 'hidden', 'contents', 'table'])
const positionUtilities = new Set(['absolute', 'relative', 'fixed', 'sticky', 'static'])
const fontSizeScale = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'])
const paintRoots = new Set(['bg', 'rounded', 'ring', 'outline', 'shadow', 'opacity', 'fill', 'stroke', 'decoration', 'divide', 'accent', 'caret', 'from', 'via', 'to'])
const spacingRoots = new Set(['p', 'px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe', 'm', 'mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me', 'gap', 'gap-x', 'gap-y', 'space-x', 'space-y', 'w', 'h', 'size', 'min-w', 'min-h', 'max-w', 'max-h', 'inset', 'inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end', 'leading', 'basis', 'indent', 'translate-x', 'translate-y'])

export function classifyToken(rawToken: string): TokenClassification {
  const segments = rawToken.split(':')
  const utility = segments[segments.length - 1]!
  const variants = segments.slice(0, -1)
  const negative = utility.startsWith('-')
  const bare = negative ? utility.slice(1) : utility

  if (displayUtilities.has(bare)) return {kind: 'geometry', family: 'display', value: bare, variants}
  if (positionUtilities.has(bare)) return {kind: 'geometry', family: 'position', value: bare, variants}
  if (bare === 'grow' || bare === 'shrink' || bare === 'flex-1' || bare === 'flex-auto' || bare === 'flex-none' || bare === 'flex-initial') {
    return {kind: 'geometry', family: 'flex', value: bare, variants}
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
      return {kind: 'geometry', family: `border-width${edge === '' ? '' : `-${edge}`}`, value: remainder === '' ? '1' : remainder, variants}
    }
    if (/^(solid|dashed|dotted|double|none|hidden)$/.test(remainder)) {
      return {kind: 'paint', family: 'border-style', value: remainder, variants}
    }
    return {kind: 'paint', family: 'border-color', value: remainder, variants}
  }
  if (root === 'text') {
    if (fontSizeScale.has(value) || /^\[\d+(px|rem|em)\]$/.test(value)) {
      return {kind: 'geometry', family: 'font-size', value, variants}
    }
    return {kind: 'paint', family: 'text-color', value, variants}
  }
  if (spacingRoots.has(root) || spacingRoots.has(`${root}-${value.split('-')[0] ?? ''}`)) {
    const composite = spacingRoots.has(`${root}-${value.split('-')[0] ?? ''}`) ? `${root}-${value.split('-')[0]}` : root
    const amount = composite === root ? value : value.split('-').slice(1).join('-')
    return {kind: 'geometry', family: `${negative ? '-' : ''}${composite}`, value: amount, variants}
  }
  if (paintRoots.has(root)) return {kind: 'paint', family: root, value, variants}
  return {kind: 'unknown', family: root, value, variants}
}

export function formatStateGeometryReport(audits: StateGeometryFileAudit[]): string {
  const lines: string[] = []
  let findings = 0
  let coverage = 0
  for (const audit of audits) {
    for (const finding of audit.findings) {
      findings++
      lines.push(`${finding.file}:${finding.line} ${finding.kind === 'branchGeometry' ? 'state changes geometry' : 'state variant changes geometry'}: ${finding.detail}`)
    }
    coverage += audit.coverage.length
  }
  lines.push(`state geometry: ${findings} finding${findings === 1 ? '' : 's'}; ${coverage} expression${coverage === 1 ? '' : 's'} partly dynamic`)
  return lines.join('\n')
}
