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
  // The className value is computed and nothing in it is statically visible.
  | 'computedClassName'
  // Some className parts are computed. The visible classes were checked; the rest were
  // not, and the element cannot be proven unpositioned.
  | 'partialClassName'
  // The style position value is computed, so the positioning rule cannot run.
  | 'computedPosition'

// One spacing amount the project uses — a margin, padding, or gap from a class utility
// or a literal inline style property. The report aggregates these across the project
// into a distribution, so the odd value (a 13px margin in a 4px-grid codebase, one
// mb-2.5 among mb-2s) stands out with its location. Position offsets are coordinates,
// not rhythm, and stay out of the distribution.
export type SpacingValueKind = 'margin' | 'padding' | 'gap'

export type SpacingAmount =
  // An amount on the pixel scale: Tailwind numeric utilities at 4px a step (mb-2.5 is
  // 10), the px keyword, and arbitrary px or rem values ([13px]; rem at 16px a rem).
  // Inline style numbers are px, matching React's styling rule.
  | {form: 'pixels'; pixels: number}
  // An inline style value that is a name, e.g. marginRight: PILL_SPACING. The value is
  // not knowable statically, but the name is its own context in the distribution.
  | {form: 'named'; name: string}
  // A class value off the pixel scale (gap-[10%], m-[var(--gutter)]), kept as written.
  | {form: 'keyword'; text: string}
  // An inline style value that is a larger expression.
  | {form: 'computed'}

export type SpacingValueSite = {
  // 1-based, pointing at the element's opening tag.
  line: number
  column: number
  axis: SpacingAxis | 'both'
  kind: SpacingValueKind
  amount: SpacingAmount
  // The class token or style property as written, for display.
  source: string
}

export type SpacingFileScan = {
  // Intrinsic elements whose inline style claims at least one spacing axis — the
  // denominator the summary line reports.
  inlineSpacedElements: number
  findings: SpacingFinding[]
  // Every margin, padding, and gap amount on the file's intrinsic elements, whether or
  // not the element participates in any ownership finding.
  values: SpacingValueSite[]
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
  const values: SpacingValueSite[] = []
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
      values.push(...collectElementValues(node, sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  findings.sort((left, right) => left.line - right.line || left.column - right.column)
  return {inlineSpacedElements, findings, values}
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
  let classes: ExtractedClasses = {tokens: [], complete: true}
  let hasSpreadAttribute = false

  for (const attribute of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      hasSpreadAttribute = true
      continue
    }
    if (!ts.isIdentifier(attribute.name)) continue
    const name = attribute.name.text
    if (name === 'style') styleScan = scanStyleAttribute(attribute)
    else if (name === 'className' || name === 'class') classes = classAttributeTokens(attribute)
  }

  if (styleScan == null || styleScan.owned.length === 0) return null

  const {line, character} = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
  const location = {line: line + 1, column: character + 1}
  const found: SpacingFinding[] = []
  const add = (detail: SpacingFindingDetail): void => {
    found.push({...location, detail})
  }

  const ownedOffsets = styleScan.owned.filter(owned => owned.mechanism === 'positionOffset')

  // Element-wide unknowns block every check: a props spread can change anything, and an
  // opaque style member hides which spacing the element even owns. A partly computed
  // className, by contrast, only narrows the checks — the visible classes are checked
  // below, and an honesty note prints after them.
  if (hasSpreadAttribute) {
    add({kind: 'unscannable', cause: 'spreadAttributes'})
    return found
  }
  if (styleScan.hasOpaqueMember) {
    add({kind: 'unscannable', cause: 'opaqueStyleMember'})
    return found
  }

  const tokens = classes.tokens.flatMap(token => {
    const classified = classifyToken(token)
    return classified == null ? [] : [classified]
  })

  if (ownedOffsets.length > 0) {
    if (styleScan.positioned === 'computed') {
      add({kind: 'unscannable', cause: 'computedPosition'})
    } else {
      const status = styleScan.positioned ?? positionStatusFromClasses(tokens)
      // Proving the offset dead needs the full class list: with parts of the className
      // unseen, a positioning class may be hiding there, so the check stands down and
      // the partial note below covers the element.
      if (status === 'none' && (styleScan.positioned != null || classes.complete)) {
        const staticClass = tokens.find(token =>
          token.kind === 'position' && token.status === 'none' && !token.variantPrefixed)
        add({
          kind: 'offsetWithoutPosition',
          styleProperty: ownedOffsets[0]!.styleProperty,
          positionClass: styleScan.positioned == null && staticClass?.kind === 'position' ? staticClass.token : null,
        })
      }
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

  // The honesty note prints after the findings: the checks above covered the visible
  // classes, and this line marks that unseen ones exist.
  if (!classes.complete) {
    add({kind: 'unscannable', cause: classes.tokens.length > 0 ? 'partialClassName' : 'computedClassName'})
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

function styleObjectLiteral(attribute: ts.JsxAttribute): ts.ObjectLiteralExpression | null {
  const initializer = attribute.initializer
  if (initializer == null || !ts.isJsxExpression(initializer)) return null
  const expression = initializer.expression
  if (expression == null || !ts.isObjectLiteralExpression(expression)) return null
  return expression
}

function scanStyleAttribute(attribute: ts.JsxAttribute): StyleScan | null {
  const expression = styleObjectLiteral(attribute)
  if (expression == null) return null

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

// The class tokens statically visible in a className value, and whether that is all of
// them. A plain string is complete; a cn(...) call or template with dynamic parts
// yields the tokens the scan can see, with complete false so the checks that need the
// full list (proving an element unpositioned) know to stand down.
type ExtractedClasses = {tokens: string[]; complete: boolean}

function classAttributeTokens(attribute: ts.JsxAttribute): ExtractedClasses {
  const initializer = attribute.initializer
  // A bare `className` attribute carries no classes.
  if (initializer == null) return {tokens: [], complete: true}
  if (ts.isStringLiteral(initializer)) return {tokens: splitClassTokens(initializer.text), complete: true}
  if (ts.isJsxExpression(initializer)) {
    const expression = initializer.expression
    if (expression == null) return {tokens: [], complete: false}
    const extracted = extractClassExpression(expression)
    // Branches repeating a token (cond ? 'absolute mt-2' : 'absolute mt-4') fold it.
    return {tokens: [...new Set(extracted.tokens)], complete: extracted.complete}
  }
  return {tokens: [], complete: false}
}

function splitClassTokens(text: string): string[] {
  return text.split(/\s+/).filter(token => token !== '')
}

// Class-combining helpers that join their arguments with spaces, matched by lowercased
// name so a project wrapper like CN(...) counts. Their semantics differ in merging
// (twMerge drops earlier conflicting utilities), but every token the scan extracts was
// written by the author, which is what the vocabulary and the conflict checks report on.
const classCombinerNames = new Set(['cn', 'clsx', 'cx', 'classnames', 'twmerge', 'twjoin'])

// Extracts the statically visible class tokens from a className expression. Alternatives
// (ternaries, &&, ||) contribute the tokens of every branch: a conditional margin is
// still a spacing system on the element, the same reading variant prefixes get. Unknown
// parts (identifiers, prop passthroughs, unrecognized calls) contribute nothing and
// clear the complete flag.
function extractClassExpression(expression: ts.Expression): ExtractedClasses {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return {tokens: splitClassTokens(expression.text), complete: true}
  }
  if (ts.isParenthesizedExpression(expression)) return extractClassExpression(expression.expression)
  if (ts.isTemplateExpression(expression)) return extractFromPieces(templatePieces(expression))
  if (ts.isConditionalExpression(expression)) {
    return unionExtracted(extractClassExpression(expression.whenTrue), extractClassExpression(expression.whenFalse))
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return extractFromPieces(concatPieces(expression))
      // The left of && is a condition; the value is either falsy (no classes) or the
      // right side, so the right side's tokens and completeness carry over.
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return extractClassExpression(expression.right)
      case ts.SyntaxKind.BarBarToken:
      case ts.SyntaxKind.QuestionQuestionToken:
        return unionExtracted(extractClassExpression(expression.left), extractClassExpression(expression.right))
      default:
        return {tokens: [], complete: false}
    }
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && classCombinerNames.has(expression.expression.text.toLowerCase())) {
    let combined: ExtractedClasses = {tokens: [], complete: true}
    for (const argument of expression.arguments) {
      combined = unionExtracted(combined, extractCombinerArgument(argument))
    }
    return combined
  }
  return {tokens: [], complete: false}
}

// One argument of a cn(...)-style call. Arguments are joined with spaces, so tokens
// never fuse across them. Objects contribute their keys (clsx includes a key when its
// value is truthy), arrays flatten, and literal non-strings (false, null, undefined)
// contribute nothing while staying complete.
function extractCombinerArgument(argument: ts.Expression): ExtractedClasses {
  if (ts.isSpreadElement(argument)) return {tokens: [], complete: false}
  if (ts.isObjectLiteralExpression(argument)) {
    let combined: ExtractedClasses = {tokens: [], complete: true}
    for (const member of argument.properties) {
      if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
        combined = {tokens: combined.tokens, complete: false}
        continue
      }
      const name = member.name
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        combined = unionExtracted(combined, {tokens: splitClassTokens(name.text), complete: true})
      } else if (ts.isComputedPropertyName(name)) {
        combined = unionExtracted(combined, extractClassExpression(name.expression))
      }
    }
    return combined
  }
  if (ts.isArrayLiteralExpression(argument)) {
    let combined: ExtractedClasses = {tokens: [], complete: true}
    for (const element of argument.elements) {
      combined = unionExtracted(combined, extractCombinerArgument(element))
    }
    return combined
  }
  if (argument.kind === ts.SyntaxKind.TrueKeyword
    || argument.kind === ts.SyntaxKind.FalseKeyword
    || argument.kind === ts.SyntaxKind.NullKeyword
    || ts.isNumericLiteral(argument)
    || (ts.isIdentifier(argument) && argument.text === 'undefined')) {
    return {tokens: [], complete: true}
  }
  return extractClassExpression(argument)
}

function unionExtracted(left: ExtractedClasses, right: ExtractedClasses): ExtractedClasses {
  return {tokens: [...left.tokens, ...right.tokens], complete: left.complete && right.complete}
}

// String concatenation can split a token across parts: `mt-${size}` builds a class the
// scan cannot name. The pieces model keeps literal text and embedded expressions in
// order so the tokenizer can drop anything touching a boundary without whitespace.
type ConcatPiece = {kind: 'text'; text: string} | {kind: 'expression'; extracted: ExtractedClasses}

function templatePieces(template: ts.TemplateExpression): ConcatPiece[] {
  const pieces: ConcatPiece[] = [{kind: 'text', text: template.head.text}]
  for (const span of template.templateSpans) {
    pieces.push({kind: 'expression', extracted: extractClassExpression(span.expression)})
    pieces.push({kind: 'text', text: span.literal.text})
  }
  return pieces
}

function concatPieces(expression: ts.Expression): ConcatPiece[] {
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...concatPieces(expression.left), ...concatPieces(expression.right)]
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [{kind: 'text', text: expression.text}]
  }
  if (ts.isTemplateExpression(expression)) return templatePieces(expression)
  return [{kind: 'expression', extracted: extractClassExpression(expression)}]
}

// Tokens must be whitespace-delimited within the concatenated string. A token touching
// an expression boundary without whitespace is dynamic construction — `mt-${size}`, or
// 'pt-' + value — so the fragment and the expression's boundary token are dropped and
// the result marked incomplete, never guessed.
function extractFromPieces(rawPieces: ConcatPiece[]): ExtractedClasses {
  // Adjacent literal texts concatenate ('mt-' + '2' is mt-2), and empty texts between
  // expressions hide that the expressions fuse; merging and dropping first makes every
  // remaining boundary a real text-expression edge.
  const pieces: ConcatPiece[] = []
  for (const piece of rawPieces) {
    const last = pieces.at(-1)
    if (piece.kind === 'text' && last?.kind === 'text') {
      pieces[pieces.length - 1] = {kind: 'text', text: last.text + piece.text}
    } else if (piece.kind !== 'text' || piece.text !== '') {
      pieces.push(piece)
    }
  }

  const tokens: string[] = []
  let complete = true
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!
    const previous = index > 0 ? pieces[index - 1]! : null
    const next = index + 1 < pieces.length ? pieces[index + 1]! : null
    if (piece.kind === 'text') {
      const fusedLeft = previous != null && /^\S/.test(piece.text)
      const fusedRight = next != null && /\S$/.test(piece.text)
      const parts = splitClassTokens(piece.text)
      const kept = parts.slice(fusedLeft ? 1 : 0, fusedRight ? Math.max(parts.length - 1, fusedLeft ? 1 : 0) : parts.length)
      if (fusedLeft || fusedRight) complete = false
      tokens.push(...kept)
    } else {
      if (!piece.extracted.complete) complete = false
      let kept = piece.extracted.tokens
      const previousFuses = previous != null && (previous.kind === 'expression' || /\S$/.test(previous.text))
      const nextFuses = next != null && (next.kind === 'expression' || /^\S/.test(next.text))
      if (previousFuses && kept.length > 0) {
        kept = kept.slice(1)
        complete = false
      }
      if (nextFuses && kept.length > 0) {
        kept = kept.slice(0, -1)
        complete = false
      }
      tokens.push(...kept)
    }
  }
  return {tokens, complete}
}

// The distribution collects every margin, padding, and gap amount on the element —
// classes and literal inline styles alike — independent of the ownership rules. Variant
// prefixes are kept: a `md:mt-4` or `before:gap-2` amount is part of the design's
// spacing vocabulary even though it applies conditionally or to another box.
function collectElementValues(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): SpacingValueSite[] {
  const {line, character} = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
  const location = {line: line + 1, column: character + 1}
  const values: SpacingValueSite[] = []

  for (const attribute of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute) || !ts.isIdentifier(attribute.name)) continue
    const name = attribute.name.text
    if (name === 'className' || name === 'class') {
      for (const token of classAttributeTokens(attribute).tokens) {
        const value = classValueToken(token)
        if (value != null) values.push({...location, ...value, source: token})
      }
    } else if (name === 'style') {
      const expression = styleObjectLiteral(attribute)
      if (expression == null) continue
      for (const member of expression.properties) {
        if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) continue
        if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) continue
        const property = inlineValueProperty(member.name.text)
        if (property == null) continue
        const amount = ts.isPropertyAssignment(member)
          ? inlineAmount(member.initializer, sourceFile)
          : {form: 'named' as const, name: member.name.text}
        if (amount == null) continue
        values.push({...location, ...property, amount, source: member.name.text})
      }
    }
  }
  return values
}

// A margin, padding, or gap utility with its amount; null for everything else,
// including auto margins (alignment, not an amount).
function classValueToken(rawToken: string): {axis: SpacingAxis | 'both'; kind: SpacingValueKind; amount: SpacingAmount} | null {
  let utility = splitVariants(rawToken).utility
  if (utility.startsWith('!')) utility = utility.slice(1)
  if (utility.endsWith('!')) utility = utility.slice(0, -1)
  let negative = false
  if (utility.startsWith('-')) {
    negative = true
    utility = utility.slice(1)
  }

  const parsed = parseSpacingUtility(utility)
  if (parsed == null) return null
  return {axis: parsed.axis, kind: parsed.kind, amount: classAmount(parsed.value, negative)}
}

function parseSpacingUtility(utility: string): {axis: SpacingAxis | 'both'; kind: SpacingValueKind; value: string} | null {
  if (hasUtilityRoot(utility, 'gap-x')) return {axis: 'horizontal', kind: 'gap', value: utility.slice(6)}
  if (hasUtilityRoot(utility, 'gap-y')) return {axis: 'vertical', kind: 'gap', value: utility.slice(6)}
  if (hasUtilityRoot(utility, 'space-x')) return {axis: 'horizontal', kind: 'gap', value: utility.slice(8)}
  if (hasUtilityRoot(utility, 'space-y')) return {axis: 'vertical', kind: 'gap', value: utility.slice(8)}
  const root = utilityRoot(utility)
  if (root == null) return null
  const value = utilityValue(utility)
  if (value == null) return null
  switch (root) {
    case 'gap': return {axis: 'both', kind: 'gap', value}
    case 'p': return {axis: 'both', kind: 'padding', value}
    case 'pt':
    case 'pb':
    case 'py': return {axis: 'vertical', kind: 'padding', value}
    case 'pl':
    case 'pr':
    case 'px':
    case 'ps':
    case 'pe': return {axis: 'horizontal', kind: 'padding', value}
    default: {
      const marginAxis = marginUtilityAxis(utility)
      if (marginAxis == null) return null
      return {axis: marginAxis, kind: 'margin', value}
    }
  }
}

// Tailwind's default scale is 4px a step (0.25rem), so mt-2.5 is 10px; `px` is one
// pixel; arbitrary values parse when written in px or rem (at 16px a rem). Everything
// else — fractions, full, var() — is kept as written.
function classAmount(value: string, negative: boolean): SpacingAmount {
  const sign = negative ? -1 : 1
  if (/^\d+(\.\d+)?$/.test(value)) return {form: 'pixels', pixels: sign * Number(value) * 4}
  if (value === 'px') return {form: 'pixels', pixels: sign}
  if (value.startsWith('[') && value.endsWith(']')) {
    const content = value.slice(1, -1)
    const pxMatch = /^(-?\d+(\.\d+)?)px$/.exec(content)
    if (pxMatch != null) return {form: 'pixels', pixels: sign * Number(pxMatch[1])}
    const remMatch = /^(-?\d+(\.\d+)?)rem$/.exec(content)
    if (remMatch != null) return {form: 'pixels', pixels: sign * Number(remMatch[1]) * 16}
    return {form: 'keyword', text: content}
  }
  return {form: 'keyword', text: value}
}

function inlineValueProperty(name: string): {axis: SpacingAxis | 'both'; kind: SpacingValueKind} | null {
  switch (name) {
    case 'marginTop':
    case 'marginBottom':
    case 'marginBlock':
    case 'marginBlockStart':
    case 'marginBlockEnd':
      return {axis: 'vertical', kind: 'margin'}
    case 'marginLeft':
    case 'marginRight':
    case 'marginInline':
    case 'marginInlineStart':
    case 'marginInlineEnd':
      return {axis: 'horizontal', kind: 'margin'}
    case 'margin':
      return {axis: 'both', kind: 'margin'}
    case 'paddingTop':
    case 'paddingBottom':
    case 'paddingBlock':
    case 'paddingBlockStart':
    case 'paddingBlockEnd':
      return {axis: 'vertical', kind: 'padding'}
    case 'paddingLeft':
    case 'paddingRight':
    case 'paddingInline':
    case 'paddingInlineStart':
    case 'paddingInlineEnd':
      return {axis: 'horizontal', kind: 'padding'}
    case 'padding':
      return {axis: 'both', kind: 'padding'}
    case 'gap':
      return {axis: 'both', kind: 'gap'}
    case 'rowGap':
      return {axis: 'vertical', kind: 'gap'}
    case 'columnGap':
      return {axis: 'horizontal', kind: 'gap'}
    default:
      return null
  }
}

// null drops the value entirely: an 'auto' margin is alignment, not an amount.
function inlineAmount(value: ts.Expression, sourceFile: ts.SourceFile): SpacingAmount | null {
  if (ts.isNumericLiteral(value)) return {form: 'pixels', pixels: Number(value.text)}
  if (ts.isPrefixUnaryExpression(value)
    && value.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(value.operand)) {
    return {form: 'pixels', pixels: -Number(value.operand.text)}
  }
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    if (value.text === 'auto') return null
    const pxMatch = /^(-?\d+(\.\d+)?)px$/.exec(value.text)
    if (pxMatch != null) return {form: 'pixels', pixels: Number(pxMatch[1])}
    const remMatch = /^(-?\d+(\.\d+)?)rem$/.exec(value.text)
    if (remMatch != null) return {form: 'pixels', pixels: Number(remMatch[1]) * 16}
    return {form: 'keyword', text: value.text}
  }
  if (ts.isIdentifier(value)) return {form: 'named', name: value.text}
  if (ts.isPropertyAccessExpression(value)) return {form: 'named', name: value.getText(sourceFile)}
  return {form: 'computed'}
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
  const distribution = formatValueDistribution(sorted)
  if (distribution.length > 0) lines.push('', ...distribution)
  lines.push(
    '',
    `spacing: ${elements} element${elements === 1 ? '' : 's'} spaced by inline styles across ${sorted.length} scanned file${sorted.length === 1 ? '' : 's'}; ${findingCount} finding${findingCount === 1 ? '' : 's'} (${warnings} warning${warnings === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}).`,
  )
  return lines.join('\n')
}

type ValueTally = {
  amount: SpacingAmount
  count: number
  // The first two occurrences; printed for rare values, where the location is the point.
  sites: string[]
}

// The distribution: every margin, padding, and gap amount in the project, grouped by
// axis and kind, most common first, with locations on values seen at most twice — those
// are the ones worth visiting. A value from a both-axes source (p-4, gap-2, inline
// margin) counts toward both axes, because a question like "what vertical paddings
// exist" includes them.
function formatValueDistribution(scans: SpacingPathScan[]): string[] {
  const groups = new Map<string, Map<string, ValueTally>>()
  for (const {file, scan} of scans) {
    for (const value of scan.values) {
      const axes: SpacingAxis[] = value.axis === 'both' ? ['vertical', 'horizontal'] : [value.axis]
      for (const axis of axes) {
        const groupKey = `${axis} ${value.kind}`
        let group = groups.get(groupKey)
        if (group == null) {
          group = new Map()
          groups.set(groupKey, group)
        }
        const amountKey = formatAmount(value.amount)
        let tally = group.get(amountKey)
        if (tally == null) {
          tally = {amount: value.amount, count: 0, sites: []}
          group.set(amountKey, tally)
        }
        tally.count++
        if (tally.sites.length < 2) tally.sites.push(`${file}:${value.line}:${value.column}`)
      }
    }
  }
  if (groups.size === 0) return []

  const lines = ['spacing values (Tailwind scale at 4px a step; named values are computed in TS):']
  const groupOrder = [
    'vertical margin', 'horizontal margin',
    'vertical padding', 'horizontal padding',
    'vertical gap', 'horizontal gap',
  ]
  for (const groupKey of groupOrder) {
    const group = groups.get(groupKey)
    if (group == null) continue
    const tallies = [...group.values()].sort(compareTallies)
    const shown = tallies.slice(0, 12)
    const parts = shown.map(tally => {
      const site = tally.count <= 2 ? ` (${tally.sites.join(', ')})` : ''
      return `${formatAmount(tally.amount)} ×${tally.count}${site}`
    })
    // The values past the cap split by what a reader wants from them: moderately common
    // ones just get counted, while rare ones (a value used once or twice is where an
    // inconsistency hides) print on their own line with their locations.
    const remaining = tallies.slice(12)
    const commonRemaining = remaining.filter(tally => tally.count > 2).length
    lines.push(`  ${groupKey}: ${parts.join(' · ')}${commonRemaining > 0 ? ` · ${commonRemaining} more` : ''}`)
    const rare = remaining.filter(tally => tally.count <= 2)
    if (rare.length > 0) {
      const shownRare = rare.slice(0, 8)
      const rareParts = shownRare.map(tally =>
        `${formatAmount(tally.amount)}${tally.count === 2 ? ' ×2' : ''} (${tally.sites[0]!})`)
      const moreRare = rare.length - shownRare.length
      lines.push(`    rare: ${rareParts.join(' · ')}${moreRare > 0 ? ` · +${moreRare} more` : ''}`)
    }
  }
  return lines
}

// Most common first; equal counts order by pixel size, then text, so scale neighbors
// sit next to each other.
function compareTallies(left: ValueTally, right: ValueTally): number {
  if (left.count !== right.count) return right.count - left.count
  const leftPixels = left.amount.form === 'pixels' ? left.amount.pixels : Infinity
  const rightPixels = right.amount.form === 'pixels' ? right.amount.pixels : Infinity
  if (leftPixels !== rightPixels) return leftPixels - rightPixels
  return formatAmount(left.amount).localeCompare(formatAmount(right.amount))
}

function formatAmount(amount: SpacingAmount): string {
  switch (amount.form) {
    case 'pixels': return `${amount.pixels}px`
    case 'named': return amount.name
    case 'keyword': return `'${amount.text}'`
    case 'computed': return '(computed)'
  }
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
    case 'partialClassName':
      return 'className is partly computed; the statically visible classes were checked, and the rest cannot be'
    case 'computedPosition':
      return 'the position style value is computed, so whether the element is positioned cannot be checked'
  }
}
