// The spacing ownership scan, the first slice of the layout-consistency work. An element
// whose inline `style` sets a position offset (top, bottom, left, right, inset) or a
// margin is spaced by TypeScript values on that axis. Each finding is a second spacing
// system acting on spacing the inline style owns: an inline offset on an element with no
// CSS position (where the offset has no effect), a margin class on an owned axis, or a
// class setting the same offset property as the inline style. The scan reads syntax only
// — no type checker, no evaluation — and it checks intrinsic elements (lowercase tags),
// not component props. Constructs it cannot read (a props spread, a computed className,
// a spread inside the style object) are reported as unscannable rather than guessed, and
// an unscannable element gets that one finding instead of half-checked rules, matching
// the first-blocker policy the analyzer uses for unsupported functions.
//
// Class names are matched against Tailwind's spacing utilities by their exact utility
// root (`mt-4`, `-inset-y-2`, `md:mb-[13px]`, and the trailing-! important form). A
// custom class that reuses a utility root, e.g. `top-level-nav`, is a known false
// positive. Three rule boundaries came from running the scan over MJ Gallery and reading
// every warning site:
// - Offset conflicts are per property, not per axis. A class pinning one edge while the
//   inline style sets the opposite edge (`left-0` with inline `right`) is the standard
//   technique for sizing an absolute element by its edges — the two declarations
//   cooperate. Only the same property competes.
// - `relative` and `sticky` elements accept inline offsets cleanly: a sticky element's
//   `top` is its sticking threshold, and a relative element's offset is a visual nudge
//   that never moves siblings. The finding is reserved for elements with no CSS
//   position, where the browser ignores the offset entirely.
// - Auto margins (`m-auto`, `mt-auto`) are alignment, not a spacing amount, so they do
//   not count as a competing spacing system.
import * as ts from 'typescript'
import {formatDiagnosticPrefix, type DiagnosticLevel} from './typescript/diagnostics.ts'

export type SpacingAxis = 'vertical' | 'horizontal'

export type OffsetProperty = 'top' | 'bottom' | 'left' | 'right'

export type SpacingFinding = {
  // 1-based, pointing at the element's opening tag.
  line: number
  column: number
  detail: SpacingFindingDetail
}

export type SpacingFindingDetail =
  // An inline position offset on an element with no CSS position. The browser applies
  // top, bottom, left, and right only to positioned elements, so the computed offset is
  // dead. When an explicit `static` class states the position, the class is named.
  | {kind: 'offsetWithoutPosition'; styleProperty: string; positionClass: string | null}
  // A margin class on an axis the inline style already spaces. Margins also move
  // absolutely positioned boxes, so both spacing systems apply at runtime.
  | {kind: 'marginClassOnOwnedAxis'; axis: SpacingAxis; styleProperty: string; className: string}
  // A class setting the same offset property the inline style sets (`top-0` against
  // inline top, or `inset-0`, which contains it). One of the two silently wins.
  | {kind: 'offsetClassOnOwnedProperty'; property: OffsetProperty; styleProperty: string; className: string}
  | {kind: 'unscannable'; cause: UnscannableCause}

export type UnscannableCause =
  // A props spread may add className or style, so no class or positioning rule can run.
  | 'spreadAttributes'
  // A spread or computed property name inside the style object hides spacing properties.
  | 'opaqueStyleMember'
  // The className value is computed, so the class list is invisible to the scan.
  | 'computedClassName'
  // The style position value is computed, so the positioning rule cannot run.
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

// How an inline style property spaces the element: a position offset carries the exact
// edge properties it sets and needs the element positioned, while a margin works on
// unpositioned elements and needs no positioning.
type OwnedSpacing =
  | {mechanism: 'positionOffset'; styleProperty: string; properties: OffsetProperty[]}
  | {mechanism: 'margin'; styleProperty: string; axis: SpacingAxis | 'both'}

// out-of-flow: absolute or fixed. positioned-in-flow: relative or sticky, where inline
// offsets are meaningful and flow-compatible. none: explicitly static or no position
// signal at all — the browser ignores offsets either way.
type PositionStatus = 'outOfFlow' | 'positionedInFlow' | 'none'

type StyleScan = {
  owned: OwnedSpacing[]
  // null: the style object has no position property, so classes decide positioning.
  positioned: PositionStatus | 'computed' | null
  hasOpaqueMember: boolean
}

// Returns null when the element claims no spacing through a literal style object — such
// an element is outside the scan entirely, so a plain `mt-4` list item or a
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

  const ownedOffsets = styleScan.owned.filter(owned => owned.mechanism === 'positionOffset')

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
  if (styleScan.positioned === 'computed' && ownedOffsets.length > 0) {
    add({kind: 'unscannable', cause: 'computedPosition'})
    return found
  }

  const tokens = (classTokens ?? []).flatMap(token => {
    const classified = classifyToken(token)
    return classified == null ? [] : [classified]
  })

  if (ownedOffsets.length > 0) {
    const status = styleScan.positioned === 'computed' || styleScan.positioned == null
      ? positionStatusFromClasses(tokens)
      : styleScan.positioned
    if (status === 'none') {
      const staticClass = tokens.find(token =>
        token.kind === 'position' && token.status === 'none' && !token.variantPrefixed)
      add({
        kind: 'offsetWithoutPosition',
        styleProperty: ownedOffsets[0]!.styleProperty,
        positionClass: styleScan.positioned == null && staticClass?.kind === 'position' ? staticClass.token : null,
      })
    }
  }

  for (const token of tokens) {
    if (token.kind === 'position') continue
    if (token.kind === 'margin') {
      const owned = styleScan.owned.find(candidate => axesOverlap(token.axis, ownedAxes(candidate)))
      if (owned == null) continue
      add({
        kind: 'marginClassOnOwnedAxis',
        axis: firstSharedAxis(token.axis, ownedAxes(owned)),
        styleProperty: owned.styleProperty,
        className: token.token,
      })
      continue
    }
    for (const owned of ownedOffsets) {
      const shared = token.properties.find(property => owned.properties.includes(property))
      if (shared == null) continue
      add({kind: 'offsetClassOnOwnedProperty', property: shared, styleProperty: owned.styleProperty, className: token.token})
      break
    }
  }

  return found
}

function ownedAxes(owned: OwnedSpacing): SpacingAxis | 'both' {
  if (owned.mechanism === 'margin') return owned.axis
  const vertical = owned.properties.some(property => property === 'top' || property === 'bottom')
  const horizontal = owned.properties.some(property => property === 'left' || property === 'right')
  return vertical && horizontal ? 'both' : vertical ? 'vertical' : 'horizontal'
}

function axesOverlap(left: SpacingAxis | 'both', right: SpacingAxis | 'both'): boolean {
  return left === 'both' || right === 'both' || left === right
}

function firstSharedAxis(left: SpacingAxis | 'both', right: SpacingAxis | 'both'): SpacingAxis {
  if (left !== 'both') return left
  if (right !== 'both') return right
  return 'vertical'
}

// The class-token positioning signal: `absolute`/`fixed` beat `relative`/`sticky`, which
// beat an explicit `static`, because the scan cannot know which class the stylesheet
// orders last and the lenient reading avoids false findings. Only unprefixed tokens
// count — a variant-prefixed `md:absolute` leaves the element unpositioned at the other
// breakpoints.
function positionStatusFromClasses(tokens: ClassToken[]): PositionStatus {
  let status: PositionStatus = 'none'
  for (const token of tokens) {
    if (token.kind !== 'position' || token.variantPrefixed) continue
    if (token.status === 'outOfFlow') return 'outOfFlow'
    if (token.status === 'positionedInFlow') status = 'positionedInFlow'
  }
  return status
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
    const owned = ownedSpacingForProperty(name)
    if (owned != null) scan.owned.push(owned)
  }
  return scan
}

function positionValue(member: ts.PropertyAssignment | ts.ShorthandPropertyAssignment): PositionStatus | 'computed' {
  if (!ts.isPropertyAssignment(member)) return 'computed'
  const value = member.initializer
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) return 'computed'
  switch (value.text) {
    case 'absolute':
    case 'fixed': return 'outOfFlow'
    case 'relative':
    case 'sticky':
    case '-webkit-sticky': return 'positionedInFlow'
    case 'static': return 'none'
    // 'inherit' and friends depend on the surrounding tree, which the scan cannot see.
    default: return 'computed'
  }
}

function ownedSpacingForProperty(name: string): OwnedSpacing | null {
  switch (name) {
    case 'top':
    case 'bottom':
    case 'left':
    case 'right':
      return {mechanism: 'positionOffset', styleProperty: name, properties: [name]}
    case 'inset':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['top', 'bottom', 'left', 'right']}
    // Logical inset and margin properties map to their physical horizontal-writing-mode,
    // left-to-right equivalents; the scan does not model writing modes.
    case 'insetBlock':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['top', 'bottom']}
    case 'insetBlockStart':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['top']}
    case 'insetBlockEnd':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['bottom']}
    case 'insetInline':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['left', 'right']}
    case 'insetInlineStart':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['left']}
    case 'insetInlineEnd':
      return {mechanism: 'positionOffset', styleProperty: name, properties: ['right']}
    case 'marginTop':
    case 'marginBottom':
    case 'marginBlock':
    case 'marginBlockStart':
    case 'marginBlockEnd':
      return {mechanism: 'margin', styleProperty: name, axis: 'vertical'}
    case 'marginLeft':
    case 'marginRight':
    case 'marginInline':
    case 'marginInlineStart':
    case 'marginInlineEnd':
      return {mechanism: 'margin', styleProperty: name, axis: 'horizontal'}
    case 'margin':
      return {mechanism: 'margin', styleProperty: name, axis: 'both'}
    default:
      return null
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
  | {kind: 'position'; status: PositionStatus; variantPrefixed: boolean; token: string}
  | {kind: 'margin'; axis: SpacingAxis | 'both'; token: string}
  | {kind: 'offset'; properties: OffsetProperty[]; token: string}

// Variants that style a different box than the element itself, so their spacing cannot
// conflict with the element's inline style.
const pseudoElementVariants = new Set([
  'before', 'after', 'placeholder', 'selection', 'marker', 'backdrop', 'file',
  'first-letter', 'first-line',
])

// Classifies one class token against Tailwind's positioning and spacing utilities.
// Variant prefixes (`md:`, `hover:`, `last:`) are kept for margins and offsets — a
// margin applied at any breakpoint or structural position is still a second spacing
// system on the same element — but pseudo-element variants (`before:mt-2`) target a
// different box entirely and never conflict. Both important spellings are handled:
// Tailwind v3's leading `!mt-2` and v4's trailing `mt-2!`.
function classifyToken(rawToken: string): ClassToken | null {
  const {utility: unprefixed, variants} = splitVariants(rawToken)
  // A pseudo-element variant styles a different box, and a fully arbitrary variant like
  // `[&>*]:mt-2` usually targets other elements through a selector; neither can be
  // checked against this element's inline style.
  if (variants.some(variant => pseudoElementVariants.has(variant) || variant.startsWith('['))) return null
  const variantPrefixed = variants.length > 0
  let utility = unprefixed
  if (utility.startsWith('!')) utility = utility.slice(1)
  if (utility.endsWith('!')) utility = utility.slice(0, -1)
  switch (utility) {
    case 'absolute':
    case 'fixed':
      return {kind: 'position', status: 'outOfFlow', variantPrefixed, token: rawToken}
    case 'relative':
    case 'sticky':
      return {kind: 'position', status: 'positionedInFlow', variantPrefixed, token: rawToken}
    case 'static':
      return {kind: 'position', status: 'none', variantPrefixed, token: rawToken}
    default: break
  }
  // A leading minus only negates the value; the utility root stays the same.
  if (utility.startsWith('-')) utility = utility.slice(1)
  const marginAxis = marginUtilityAxis(utility)
  if (marginAxis != null) return {kind: 'margin', axis: marginAxis, token: rawToken}
  const offsetProperties = offsetUtilityProperties(utility)
  if (offsetProperties != null) return {kind: 'offset', properties: offsetProperties, token: rawToken}
  return null
}

// The variant chain splits at colons outside square brackets: `md:hover:mt-4` has
// variants md and hover with utility `mt-4`, and an arbitrary variant like `[&>*]:mt-2`
// keeps its bracketed segment intact.
function splitVariants(token: string): {utility: string; variants: string[]} {
  const segments: string[] = []
  let bracketDepth = 0
  let segmentStart = 0
  for (let index = 0; index < token.length; index++) {
    const character = token[index]!
    if (character === '[') bracketDepth++
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (character === ':' && bracketDepth === 0) {
      segments.push(token.slice(segmentStart, index))
      segmentStart = index + 1
    }
  }
  return {utility: token.slice(segmentStart), variants: segments}
}

// Auto margins are alignment (centering in an absolute context, pushing within a flex
// row), not a spacing amount, so they are not a competing spacing system.
function marginUtilityAxis(utility: string): SpacingAxis | 'both' | null {
  const root = utilityRoot(utility)
  if (root == null || utilityValue(utility) === 'auto') return null
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

function offsetUtilityProperties(utility: string): OffsetProperty[] | null {
  if (hasUtilityRoot(utility, 'inset-y')) return ['top', 'bottom']
  if (hasUtilityRoot(utility, 'inset-x')) return ['left', 'right']
  if (hasUtilityRoot(utility, 'inset')) return ['top', 'bottom', 'left', 'right']
  const root = utilityRoot(utility)
  if (root == null) return null
  switch (root) {
    case 'top':
    case 'bottom':
    case 'left':
    case 'right': return [root]
    // Logical start/end map to left/right; the scan does not model writing modes.
    case 'start': return ['left']
    case 'end': return ['right']
    default: return null
  }
}

// The utility root is the segment before the first dash, and a utility always carries a
// value after that dash: `mt-4` has root `mt` and value `4`, while a bare `me` or a
// custom class named `margin` matches nothing.
function utilityRoot(utility: string): string | null {
  const dash = utility.indexOf('-')
  if (dash <= 0 || dash === utility.length - 1) return null
  return utility.slice(0, dash)
}

function utilityValue(utility: string): string | null {
  const dash = utility.indexOf('-')
  if (dash <= 0 || dash === utility.length - 1) return null
  return utility.slice(dash + 1)
}

function hasUtilityRoot(utility: string, root: string): boolean {
  return utility.startsWith(`${root}-`) && utility.length > root.length + 1
}

export function spacingFindingLevel(detail: SpacingFindingDetail): DiagnosticLevel {
  switch (detail.kind) {
    case 'offsetWithoutPosition':
    case 'marginClassOnOwnedAxis':
    case 'offsetClassOnOwnedProperty': return 'warning'
    case 'unscannable': return 'note'
  }
}

export const spacingPreamble = `Spacing ownership scan. An element whose inline style sets top, bottom, left, right, inset, or a margin is spaced by TypeScript values on that axis. Each finding is a second spacing system acting on spacing the inline style owns, or a construct the scan cannot read, reported as unscannable rather than guessed. The scan reads syntax only: it does not type-check, it checks intrinsic elements (lowercase tags) rather than component props, and it matches class names against Tailwind's spacing utilities.`

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
    case 'offsetWithoutPosition':
      return `${prefix('spacing-no-position')}inline style sets ${detail.styleProperty} but the element is ${detail.positionClass == null ? 'not positioned (no absolute, fixed, relative, or sticky)' : `'${detail.positionClass}'`}, so the offset has no effect`
    case 'marginClassOnOwnedAxis':
      return `${prefix('spacing-mixed-margin')}class '${detail.className}' adds a ${detail.axis} margin to an element whose inline style already sets ${detail.styleProperty}; two spacing systems move the element on the same axis`
    case 'offsetClassOnOwnedProperty':
      return `${prefix('spacing-mixed-offset')}class '${detail.className}' and the inline style both set ${detail.property}; one of the two silently wins`
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
      return 'the position style value is computed, so whether the element is positioned cannot be checked'
  }
}
