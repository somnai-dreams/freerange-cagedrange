// The spacing ownership scan, the first slice of the layout-consistency work. An element
// whose inline `style` sets a position offset (top, bottom, left, right, inset) or a
// margin is spaced by TypeScript values on that axis. Each finding is a second spacing
// system acting on an axis the inline style owns: an inline offset on an element still in
// normal document flow, a margin class on an owned axis, or an offset class that competes
// with the inline offset. The scan reads syntax only — no type checker, no evaluation —
// and it checks intrinsic elements (lowercase tags), not component props. Constructs it
// cannot read (a props spread, a computed className, a spread inside the style object)
// are reported as unscannable rather than guessed, and an unscannable element gets that
// one finding instead of half-checked rules, matching the first-blocker policy the
// analyzer uses for unsupported functions.
//
// Class names are matched against Tailwind's spacing utilities by their exact utility
// root (`mt-4`, `-inset-y-2`, `md:mb-[13px]`). A custom class that reuses a utility root,
// e.g. `top-level-nav`, is a known false positive.
import * as ts from 'typescript'
import {formatDiagnosticPrefix, type DiagnosticLevel} from './typescript/diagnostics.ts'

export type SpacingAxis = 'vertical' | 'horizontal'

export type SpacingFinding = {
  // 1-based, pointing at the element's opening tag.
  line: number
  column: number
  detail: SpacingFindingDetail
}

export type SpacingFindingDetail =
  // An inline position offset on an element that is not absolutely or fixed positioned,
  // so document flow also decides where the element sits. When a position class puts the
  // element in flow explicitly (`relative`, `static`, `sticky`), the class is named.
  | {kind: 'inFlowPositionOffset'; styleProperty: string; positionClass: string | null}
  // A margin class on an axis the inline style already spaces. Margins also move
  // absolutely positioned boxes, so both spacing systems apply at runtime.
  | {kind: 'marginClassOnOwnedAxis'; axis: SpacingAxis; styleProperty: string; className: string}
  // An offset class (`top-0`, `inset-y-2`) on an axis the inline style also sets. The
  // class and the inline declaration compete, and one of the two silently wins.
  | {kind: 'offsetClassOnOwnedAxis'; axis: SpacingAxis; styleProperty: string; className: string}
  | {kind: 'unscannable'; cause: UnscannableCause}

export type UnscannableCause =
  // A props spread may add className or style, so no class or positioning rule can run.
  | 'spreadAttributes'
  // A spread or computed property name inside the style object hides spacing properties.
  | 'opaqueStyleMember'
  // The className value is computed, so the class list is invisible to the scan.
  | 'computedClassName'
  // The style position value is computed, so absolute positioning cannot be confirmed.
  | 'computedPosition'

export type SpacingFileScan = {
  // Intrinsic elements whose inline style claims at least one spacing axis — the
  // denominator the summary line reports.
  inlineSpacedElements: number
  findings: SpacingFinding[]
}

// A scanned file paired with the path its finding lines should print.
export type SpacingPathScan = {
  file: string
  scan: SpacingFileScan
}

// Library entry mirroring auditSource: structured spacing findings for one file's source.
// The script kind (TS or TSX) follows the file extension.
export function scanSpacingSource(file: string, source: string): SpacingFileScan {
  return scanSpacing(ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, false))
}

export function scanSpacing(sourceFile: ts.SourceFile): SpacingFileScan {
  const findings: SpacingFinding[] = []
  let inlineSpacedElements = 0

  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName)
      && isIntrinsicTagName(node.tagName.text)) {
      const elementFindings = scanElement(node, sourceFile)
      if (elementFindings != null) {
        inlineSpacedElements++
        findings.push(...elementFindings)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  findings.sort((left, right) => left.line - right.line || left.column - right.column)
  return {inlineSpacedElements, findings}
}

function isIntrinsicTagName(tagName: string): boolean {
  const first = tagName.charAt(0)
  return first !== '' && first === first.toLowerCase()
}

// How an inline style property spaces the element: a position offset needs the element
// out of document flow, while a margin works in flow and needs no positioning.
type OwnedAxis = {
  axis: SpacingAxis
  styleProperty: string
  mechanism: 'positionOffset' | 'margin'
}

type StyleScan = {
  owned: OwnedAxis[]
  // null: the style object has no position property, so classes decide positioning.
  positioned: boolean | 'computed' | null
  hasOpaqueMember: boolean
}

// Returns null when the element claims no spacing axis through a literal style object —
// such an element is outside the scan entirely, so a plain `mt-4` list item or a
// `style={styles}` reference is never reported.
function scanElement(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): SpacingFinding[] | null {
  let styleScan: StyleScan | null = null
  let classTokens: string[] | 'computed' | null = null
  let hasSpreadAttribute = false

  for (const attribute of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      hasSpreadAttribute = true
      continue
    }
    if (!ts.isIdentifier(attribute.name)) continue
    const name = attribute.name.text
    if (name === 'style') styleScan = scanStyleAttribute(attribute)
    else if (name === 'className' || name === 'class') classTokens = classAttributeTokens(attribute)
  }

  if (styleScan == null || styleScan.owned.length === 0) return null

  const {line, character} = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
  const location = {line: line + 1, column: character + 1}
  const found: SpacingFinding[] = []
  const add = (detail: SpacingFindingDetail): void => {
    found.push({...location, detail})
  }

  const offsetOwned = styleScan.owned.filter(owned => owned.mechanism === 'positionOffset')

  // One unscannable cause per element, checked in the order that hides the most: a props
  // spread can change anything, an opaque style member hides spacing properties, a
  // computed className hides the class list, and a computed position value hides only
  // the positioning rule.
  if (hasSpreadAttribute) {
    add({kind: 'unscannable', cause: 'spreadAttributes'})
    return found
  }
  if (styleScan.hasOpaqueMember) {
    add({kind: 'unscannable', cause: 'opaqueStyleMember'})
    return found
  }
  if (classTokens === 'computed') {
    add({kind: 'unscannable', cause: 'computedClassName'})
    return found
  }
  if (styleScan.positioned === 'computed' && offsetOwned.length > 0) {
    add({kind: 'unscannable', cause: 'computedPosition'})
    return found
  }

  const tokens = (classTokens ?? []).map(classifyToken)

  if (offsetOwned.length > 0) {
    const positionedByStyle = styleScan.positioned === true || styleScan.positioned === false
      ? styleScan.positioned
      : null
    const positioned = positionedByStyle
      ?? tokens.some(token => token?.kind === 'position' && token.positioned && !token.variantPrefixed)
    if (!positioned) {
      const inFlowClass = positionedByStyle == null
        ? tokens.find(token => token?.kind === 'position' && !token.positioned && !token.variantPrefixed)
        : null
      add({
        kind: 'inFlowPositionOffset',
        styleProperty: offsetOwned[0]!.styleProperty,
        positionClass: inFlowClass?.kind === 'position' ? inFlowClass.token : null,
      })
    }
  }

  for (const token of tokens) {
    if (token == null || token.kind === 'position') continue
    const candidates = token.kind === 'margin' ? styleScan.owned : offsetOwned
    const owned = candidates.find(candidate => token.axis === 'both' || token.axis === candidate.axis)
    if (owned == null) continue
    add(token.kind === 'margin'
      ? {kind: 'marginClassOnOwnedAxis', axis: owned.axis, styleProperty: owned.styleProperty, className: token.token}
      : {kind: 'offsetClassOnOwnedAxis', axis: owned.axis, styleProperty: owned.styleProperty, className: token.token})
  }

  return found
}

function scanStyleAttribute(attribute: ts.JsxAttribute): StyleScan | null {
  const initializer = attribute.initializer
  if (initializer == null || !ts.isJsxExpression(initializer)) return null
  const expression = initializer.expression
  if (expression == null || !ts.isObjectLiteralExpression(expression)) return null

  const scan: StyleScan = {owned: [], positioned: null, hasOpaqueMember: false}
  for (const member of expression.properties) {
    if (ts.isSpreadAssignment(member)) {
      scan.hasOpaqueMember = true
      continue
    }
    if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
      // A method or accessor member; JSX style objects hold plain values, so treat the
      // member as unreadable rather than model it.
      scan.hasOpaqueMember = true
      continue
    }
    if (ts.isComputedPropertyName(member.name)) {
      // A computed property name can spell any spacing property.
      scan.hasOpaqueMember = true
      continue
    }
    if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) {
      // A numeric or bigint property name cannot spell a spacing property.
      continue
    }
    const name = member.name.text
    if (name === 'position') {
      scan.positioned = positionValue(member)
      continue
    }
    scan.owned.push(...ownedAxesForProperty(name))
  }
  return scan
}

function positionValue(member: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): boolean | 'computed' {
  if (!ts.isPropertyAssignment(member)) return 'computed'
  const value = member.initializer
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    return value.text === 'absolute' || value.text === 'fixed'
  }
  return 'computed'
}

function ownedAxesForProperty(name: string): OwnedAxis[] {
  switch (name) {
    case 'top':
    case 'bottom':
      return [{axis: 'vertical', styleProperty: name, mechanism: 'positionOffset'}]
    case 'left':
    case 'right':
      return [{axis: 'horizontal', styleProperty: name, mechanism: 'positionOffset'}]
    case 'inset':
      return [
        {axis: 'vertical', styleProperty: name, mechanism: 'positionOffset'},
        {axis: 'horizontal', styleProperty: name, mechanism: 'positionOffset'},
      ]
    case 'insetBlock':
    case 'insetBlockStart':
    case 'insetBlockEnd':
      return [{axis: 'vertical', styleProperty: name, mechanism: 'positionOffset'}]
    case 'insetInline':
    case 'insetInlineStart':
    case 'insetInlineEnd':
      return [{axis: 'horizontal', styleProperty: name, mechanism: 'positionOffset'}]
    case 'marginTop':
    case 'marginBottom':
    case 'marginBlock':
    case 'marginBlockStart':
    case 'marginBlockEnd':
      return [{axis: 'vertical', styleProperty: name, mechanism: 'margin'}]
    case 'marginLeft':
    case 'marginRight':
    case 'marginInline':
    case 'marginInlineStart':
    case 'marginInlineEnd':
      return [{axis: 'horizontal', styleProperty: name, mechanism: 'margin'}]
    case 'margin':
      return [
        {axis: 'vertical', styleProperty: name, mechanism: 'margin'},
        {axis: 'horizontal', styleProperty: name, mechanism: 'margin'},
      ]
    default:
      return []
  }
}

function classAttributeTokens(attribute: ts.JsxAttribute): string[] | 'computed' {
  const initializer = attribute.initializer
  // A bare `className` attribute carries no classes.
  if (initializer == null) return []
  if (ts.isStringLiteral(initializer)) return splitClassTokens(initializer.text)
  if (ts.isJsxExpression(initializer)) {
    const expression = initializer.expression
    if (expression != null && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
      return splitClassTokens(expression.text)
    }
  }
  return 'computed'
}

function splitClassTokens(text: string): string[] {
  return text.split(/\s+/).filter(token => token !== '')
}

type ClassToken =
  | {kind: 'position'; positioned: boolean; variantPrefixed: boolean; token: string}
  | {kind: 'margin'; axis: SpacingAxis | 'both'; token: string}
  | {kind: 'offset'; axis: SpacingAxis | 'both'; token: string}

// Classifies one class token against Tailwind's positioning and spacing utilities.
// Variant prefixes (`md:`, `hover:`) are stripped for margins and offsets — a margin
// applied at any breakpoint is still a second spacing system — but a variant-prefixed
// `md:absolute` does not satisfy positioning, because the element stays in flow at the
// other breakpoints.
function classifyToken(rawToken: string): ClassToken | null {
  const unprefixed = stripVariantPrefixes(rawToken)
  const variantPrefixed = unprefixed !== rawToken
  let utility = unprefixed
  if (utility.startsWith('!')) utility = utility.slice(1)
  if (utility === 'absolute' || utility === 'fixed') {
    return {kind: 'position', positioned: true, variantPrefixed, token: rawToken}
  }
  if (utility === 'relative' || utility === 'static' || utility === 'sticky') {
    return {kind: 'position', positioned: false, variantPrefixed, token: rawToken}
  }
  // A leading minus only negates the value; the utility root stays the same.
  if (utility.startsWith('-')) utility = utility.slice(1)
  const marginAxis = marginUtilityAxis(utility)
  if (marginAxis != null) return {kind: 'margin', axis: marginAxis, token: rawToken}
  const offsetAxis = offsetUtilityAxis(utility)
  if (offsetAxis != null) return {kind: 'offset', axis: offsetAxis, token: rawToken}
  return null
}

// The variant chain ends at the last colon outside square brackets: `md:hover:mt-4`
// becomes `mt-4`, and an arbitrary variant like `[&>*]:mt-2` keeps its final segment.
function stripVariantPrefixes(token: string): string {
  let bracketDepth = 0
  let lastColon = -1
  for (let index = 0; index < token.length; index++) {
    const character = token[index]!
    if (character === '[') bracketDepth++
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (character === ':' && bracketDepth === 0) lastColon = index
  }
  return lastColon === -1 ? token : token.slice(lastColon + 1)
}

function marginUtilityAxis(utility: string): SpacingAxis | 'both' | null {
  const root = utilityRoot(utility)
  if (root == null) return null
  switch (root) {
    case 'm': return 'both'
    case 'mt':
    case 'mb':
    case 'my': return 'vertical'
    case 'ml':
    case 'mr':
    case 'mx':
    case 'ms':
    case 'me': return 'horizontal'
    default: return null
  }
}

function offsetUtilityAxis(utility: string): SpacingAxis | 'both' | null {
  if (hasUtilityRoot(utility, 'inset-y')) return 'vertical'
  if (hasUtilityRoot(utility, 'inset-x')) return 'horizontal'
  if (hasUtilityRoot(utility, 'inset')) return 'both'
  const root = utilityRoot(utility)
  if (root == null) return null
  switch (root) {
    case 'top':
    case 'bottom': return 'vertical'
    case 'left':
    case 'right':
    case 'start':
    case 'end': return 'horizontal'
    default: return null
  }
}

// The utility root is the segment before the first dash, and a utility always carries a
// value after that dash: `mt-4` has root `mt`, while a bare `me` or a custom class named
// `margin` matches nothing.
function utilityRoot(utility: string): string | null {
  const dash = utility.indexOf('-')
  if (dash <= 0 || dash === utility.length - 1) return null
  return utility.slice(0, dash)
}

function hasUtilityRoot(utility: string, root: string): boolean {
  return utility.startsWith(`${root}-`) && utility.length > root.length + 1
}

export function spacingFindingLevel(detail: SpacingFindingDetail): DiagnosticLevel {
  switch (detail.kind) {
    case 'inFlowPositionOffset':
    case 'marginClassOnOwnedAxis':
    case 'offsetClassOnOwnedAxis': return 'warning'
    case 'unscannable': return 'note'
  }
}

export const spacingPreamble = `Spacing ownership scan. An element whose inline style sets top, bottom, left, right, inset, or a margin is spaced by TypeScript values on that axis. Each finding is a second spacing system acting on an owned axis, or a construct the scan cannot read, reported as unscannable rather than guessed. The scan reads syntax only: it does not type-check, it checks intrinsic elements (lowercase tags) rather than component props, and it matches class names against Tailwind's spacing utilities.`

export function formatSpacingReport(scans: SpacingPathScan[], pretty: boolean): string {
  const lines: string[] = [spacingPreamble, '']
  let elements = 0
  let warnings = 0
  let notes = 0
  const sorted = [...scans].sort((left, right) => left.file.localeCompare(right.file))
  for (const {file, scan} of sorted) {
    elements += scan.inlineSpacedElements
    for (const finding of scan.findings) {
      const level = spacingFindingLevel(finding.detail)
      if (level === 'warning') warnings++
      else notes++
      lines.push(formatSpacingFinding(file, finding, pretty))
    }
  }
  const findingCount = warnings + notes
  if (findingCount === 0) lines.push('No spacing findings.')
  lines.push(
    '',
    `spacing: ${elements} element${elements === 1 ? '' : 's'} spaced by inline styles across ${sorted.length} scanned file${sorted.length === 1 ? '' : 's'}; ${findingCount} finding${findingCount === 1 ? '' : 's'} (${warnings} warning${warnings === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}).`,
  )
  return lines.join('\n')
}

function formatSpacingFinding(file: string, finding: SpacingFinding, pretty: boolean): string {
  const detail = finding.detail
  const level = spacingFindingLevel(detail)
  const prefix = (rule: string): string =>
    formatDiagnosticPrefix({file, line: finding.line, column: finding.column}, level, rule, pretty)
  switch (detail.kind) {
    case 'inFlowPositionOffset':
      return `${prefix('spacing-in-flow')}inline style sets ${detail.styleProperty} but the element is ${detail.positionClass == null ? 'not absolutely positioned' : `'${detail.positionClass}'`}; document flow and the inline offset both decide where the element sits`
    case 'marginClassOnOwnedAxis':
      return `${prefix('spacing-mixed-margin')}class '${detail.className}' adds a ${detail.axis} margin to an element whose inline style already sets ${detail.styleProperty}; two spacing systems move the element on the same axis`
    case 'offsetClassOnOwnedAxis':
      return `${prefix('spacing-mixed-offset')}class '${detail.className}' and inline ${detail.styleProperty} both set a ${detail.axis} position offset; one of the two silently wins`
    case 'unscannable':
      return `${prefix('spacing-unscannable')}${unscannableMessage(detail.cause)}`
  }
}

function unscannableMessage(cause: UnscannableCause): string {
  switch (cause) {
    case 'spreadAttributes':
      return 'a props spread may add className or style, so the element\'s spacing cannot be checked'
    case 'opaqueStyleMember':
      return 'the style object contains a spread or computed property name, so the element\'s spacing cannot be checked'
    case 'computedClassName':
      return 'className is computed, so class-based spacing cannot be checked'
    case 'computedPosition':
      return 'the position style value is computed, so whether the element is absolutely positioned cannot be checked'
  }
}
