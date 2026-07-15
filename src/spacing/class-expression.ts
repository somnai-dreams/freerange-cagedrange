import * as ts from 'typescript'
import type {
  ClassFact,
  ClassOutcome,
  ClassPositionCases,
  ClassSummary,
  PositionTrace,
  RuntimeCases,
  RuntimeGuard,
} from './model.ts'
import {combineGuards, conditionCases} from './runtime-condition.ts'
import {parseTailwindClass} from './tailwind.ts'

const outcomeOrder: ClassOutcome[] = [
  {kind: 'nullish'},
  {kind: 'falsy'},
  {kind: 'truthy', position: 'none'},
  {kind: 'truthy', position: 'static'},
  {kind: 'truthy', position: 'positioned'},
  {kind: 'truthy', position: 'positionedThenStatic'},
]

const classCombinerNames = new Set(['cn', 'clsx', 'cx', 'classnames', 'twmerge', 'twjoin'])

export function classAttributeSummary(attribute: ts.JsxAttribute): ClassSummary {
  const initializer = attribute.initializer
  if (initializer == null) return emptyClassSummary()
  if (ts.isStringLiteral(initializer)) return literalClassSummary(initializer.text)
  if (!ts.isJsxExpression(initializer) || initializer.expression == null) return unknownClassSummary()
  return extractClassExpression(initializer.expression)
}

export function classAttributePositionCases(attribute: ts.JsxAttribute): ClassPositionCases {
  const initializer = attribute.initializer
  if (initializer == null) return positionCasesFromSummary(emptyClassSummary())
  if (ts.isStringLiteral(initializer)) return positionCasesFromSummary(literalClassSummary(initializer.text))
  if (!ts.isJsxExpression(initializer) || initializer.expression == null) return {kind: 'unknown'}
  return positionCasesForExpression(initializer.expression)
}

export function emptyClassSummary(): ClassSummary {
  return normalizeSummary([], 'complete', [{kind: 'falsy'}])
}

function truthyNoClassSummary(): ClassSummary {
  return normalizeSummary([], 'complete', [{kind: 'truthy', position: 'none'}])
}

export function hasPositionOnEveryOutcome(summary: ClassSummary): boolean {
  return summary.outcomes.every(outcome =>
    outcome.kind === 'truthy'
    && (outcome.position === 'positioned' || outcome.position === 'positionedThenStatic'))
}

function positionCasesForExpression(expression: ts.Expression): ClassPositionCases {
  if (ts.isParenthesizedExpression(expression)) return positionCasesForExpression(expression.expression)
  if (ts.isTemplateExpression(expression)) {
    const templateCases = positionCasesForTemplate(expression)
    return templateCases.kind === 'unknown'
      ? positionCasesFromSummary(extractClassExpression(expression))
      : templateCases
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = staticTruthiness(expression.condition)
    if (condition === 'truthy') return positionCasesForExpression(expression.whenTrue)
    if (condition === 'falsy') return positionCasesForExpression(expression.whenFalse)
    const merged = mergePositionCases(
      gatePositionCases(positionCasesForExpression(expression.whenTrue), conditionCases(expression.condition, true)),
      gatePositionCases(positionCasesForExpression(expression.whenFalse), conditionCases(expression.condition, false)),
    )
    return merged.kind === 'unknown'
      ? positionCasesFromSummary(extractClassExpression(expression))
      : merged
  }
  if (ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    const condition = staticTruthiness(expression.left)
    if (condition === 'truthy') return positionCasesForExpression(expression.right)
    if (condition === 'falsy') return positionCasesFromSummary(falseishExpressionSummary(expression.left))
    const merged = mergePositionCases(
      gatePositionCases(positionCasesForExpression(expression.right), conditionCases(expression.left, true)),
      gatePositionCases(
        positionCasesFromSummary(falseishExpressionSummary(expression.left)),
        conditionCases(expression.left, false),
      ),
    )
    return merged.kind === 'unknown'
      ? positionCasesFromSummary(extractClassExpression(expression))
      : merged
  }
  return positionCasesFromSummary(extractClassExpression(expression))
}

function positionCasesForTemplate(expression: ts.TemplateExpression): ClassPositionCases {
  let combined = positionCasesFromSummary(literalClassSummary(expression.head.text))
  for (let index = 0; index < expression.templateSpans.length; index++) {
    const span = expression.templateSpans[index]!
    const previousText = index === 0 ? expression.head.text : expression.templateSpans[index - 1]!.literal.text
    const leftSeparated = index === 0
      ? previousText === '' || /\s$/.test(previousText)
      : previousText !== '' && /\s$/.test(previousText)
    const rightSeparated = index === expression.templateSpans.length - 1
      ? span.literal.text === '' || /^\s/.test(span.literal.text)
      : span.literal.text !== '' && /^\s/.test(span.literal.text)
    if (!leftSeparated || !rightSeparated) return {kind: 'unknown'}
    combined = joinPositionCases(combined, positionCasesForExpression(span.expression))
    combined = joinPositionCases(combined, positionCasesFromSummary(literalClassSummary(span.literal.text)))
    if (combined.kind === 'unknown') return combined
  }
  return combined
}

function positionCasesFromSummary(summary: ClassSummary): ClassPositionCases {
  if (hasPositionOnEveryOutcome(summary)) {
    return {kind: 'known', cases: [{guard: [], positioned: true}]}
  }
  if (!summary.outcomes.some(outcomeIsPositioned)) {
    return {kind: 'known', cases: [{guard: [], positioned: false}]}
  }
  return {kind: 'unknown'}
}

function outcomeIsPositioned(outcome: ClassOutcome): boolean {
  return outcome.kind === 'truthy'
    && (outcome.position === 'positioned' || outcome.position === 'positionedThenStatic')
}

function gatePositionCases(cases: ClassPositionCases, condition: RuntimeCases): ClassPositionCases {
  if (cases.kind === 'unknown' || condition.kind === 'unknown') return {kind: 'unknown'}
  const gated: {guard: RuntimeGuard; positioned: boolean}[] = []
  for (const conditionGuard of condition.alternatives) {
    for (const positionCase of cases.cases) {
      const guard = combineGuards(conditionGuard, positionCase.guard)
      if (guard != null) gated.push({guard, positioned: positionCase.positioned})
      if (gated.length > 16) return {kind: 'unknown'}
    }
  }
  return {kind: 'known', cases: gated}
}

function mergePositionCases(left: ClassPositionCases, right: ClassPositionCases): ClassPositionCases {
  if (left.kind === 'unknown' || right.kind === 'unknown') return {kind: 'unknown'}
  return left.cases.length + right.cases.length > 16
    ? {kind: 'unknown'}
    : {kind: 'known', cases: [...left.cases, ...right.cases]}
}

function joinPositionCases(left: ClassPositionCases, right: ClassPositionCases): ClassPositionCases {
  if (left.kind === 'unknown' || right.kind === 'unknown') return {kind: 'unknown'}
  const cases: {guard: RuntimeGuard; positioned: boolean}[] = []
  for (const leftCase of left.cases) {
    for (const rightCase of right.cases) {
      const guard = combineGuards(leftCase.guard, rightCase.guard)
      if (guard != null) {
        cases.push({guard, positioned: leftCase.positioned || rightCase.positioned})
      }
      if (cases.length > 16) return {kind: 'unknown'}
    }
  }
  return {kind: 'known', cases}
}

function unknownClassSummary(): ClassSummary {
  return normalizeSummary([], 'partial', outcomeOrder)
}

function literalClassSummary(text: string): ClassSummary {
  const classes = splitClassTokens(text).flatMap(token => {
    const parsed = parseTailwindClass(token)
    return parsed == null ? [] : [parsed]
  })
  const outcome: ClassOutcome = text === ''
    ? {kind: 'falsy'}
    : {kind: 'truthy', position: positionTrace(classes)}
  return normalizeSummary(classes, 'complete', [outcome])
}

function extractClassExpression(expression: ts.Expression): ClassSummary {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return literalClassSummary(expression.text)
  }
  if (ts.isParenthesizedExpression(expression)) return extractClassExpression(expression.expression)
  if (ts.isTemplateExpression(expression)) return extractStringPieces(templatePieces(expression))
  if (ts.isConditionalExpression(expression)) {
    const condition = staticTruthiness(expression.condition)
    if (condition === 'truthy') return extractClassExpression(expression.whenTrue)
    if (condition === 'falsy') return extractClassExpression(expression.whenFalse)
    return alternateClasses(
      extractClassExpression(expression.whenTrue),
      extractClassExpression(expression.whenFalse),
    )
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return extractStringPieces(concatPieces(expression))
      case ts.SyntaxKind.AmpersandAmpersandToken: {
        const condition = staticTruthiness(expression.left)
        if (condition === 'truthy') return extractClassExpression(expression.right)
        if (condition === 'falsy') return falseishExpressionSummary(expression.left)
        return andClasses(extractClassExpression(expression.left), extractClassExpression(expression.right))
      }
      case ts.SyntaxKind.BarBarToken: {
        const condition = staticTruthiness(expression.left)
        if (condition === 'truthy') return extractClassExpression(expression.left)
        if (condition === 'falsy') return extractClassExpression(expression.right)
        return orClasses(extractClassExpression(expression.left), extractClassExpression(expression.right))
      }
      case ts.SyntaxKind.QuestionQuestionToken:
        return coalesceClasses(extractClassExpression(expression.left), extractClassExpression(expression.right))
      default:
        return unknownClassSummary()
    }
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && classCombinerNames.has(expression.expression.text.toLowerCase())) {
    let combined = emptyClassSummary()
    for (const argument of expression.arguments) {
      combined = joinClasses(combined, extractCombinerArgument(argument))
    }
    return expression.expression.text.toLowerCase() === 'twmerge'
      ? applyTailwindMerge(combined)
      : combined
  }
  switch (expression.kind) {
    case ts.SyntaxKind.NullKeyword: return normalizeSummary([], 'complete', [{kind: 'nullish'}])
    case ts.SyntaxKind.FalseKeyword: return emptyClassSummary()
    case ts.SyntaxKind.TrueKeyword:
      return normalizeSummary([], 'complete', [{kind: 'truthy', position: 'none'}])
    default: break
  }
  if (ts.isVoidExpression(expression)) {
    return normalizeSummary([], 'complete', [{kind: 'nullish'}])
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text) === 0
      ? emptyClassSummary()
      : normalizeSummary([], 'complete', [{kind: 'truthy', position: 'none'}])
  }
  return unknownClassSummary()
}

function extractCombinerArgument(argument: ts.Expression): ClassSummary {
  if (ts.isSpreadElement(argument)) return unknownClassSummary()
  const numeric = numericCombinerSummary(argument)
  if (numeric != null) return numeric
  if (ts.isObjectLiteralExpression(argument)) {
    let combined = emptyClassSummary()
    for (const member of argument.properties) {
      if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
        combined = markPartial(combined)
        continue
      }
      const truthiness = ts.isPropertyAssignment(member) ? staticTruthiness(member.initializer) : 'unknown'
      if (truthiness === 'falsy') continue
      const classes = objectClassKeySummary(member.name)
      if (classes == null) continue
      const contribution = truthiness === 'truthy'
        ? classes
        : alternateClasses(emptyClassSummary(), classes)
      combined = joinClasses(combined, contribution)
    }
    return combined
  }
  if (ts.isArrayLiteralExpression(argument)) {
    let combined = emptyClassSummary()
    for (const element of argument.elements) {
      combined = joinClasses(combined, extractCombinerArgument(element))
    }
    return combined
  }
  if (argument.kind === ts.SyntaxKind.TrueKeyword
    || argument.kind === ts.SyntaxKind.FalseKeyword
    || argument.kind === ts.SyntaxKind.NullKeyword
    || ts.isVoidExpression(argument)) {
    return emptyClassSummary()
  }
  return extractClassExpression(argument)
}

function numericCombinerSummary(expression: ts.Expression): ClassSummary | null {
  let value: number
  if (ts.isNumericLiteral(expression)) {
    value = Number(expression.text)
  } else if (ts.isPrefixUnaryExpression(expression)
    && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
    && ts.isNumericLiteral(expression.operand)) {
    const sign = expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1
    value = sign * Number(expression.operand.text)
  } else {
    return null
  }
  return value === 0 ? emptyClassSummary() : truthyNoClassSummary()
}

function objectClassKeySummary(name: ts.PropertyName): ClassSummary | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return literalClassSummary(name.text)
  }
  if (ts.isBigIntLiteral(name)) return literalClassSummary(name.text.slice(0, -1))
  if (!ts.isComputedPropertyName(name)) return null
  const literal = computedPropertyKey(name.expression)
  return literal == null
    ? stringifiedSummary(unknownClassSummary())
    : literalClassSummary(literal)
}

function computedPropertyKey(expression: ts.Expression): string | null {
  if (ts.isParenthesizedExpression(expression)) return computedPropertyKey(expression.expression)
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  if (ts.isNumericLiteral(expression)) return expression.text
  if (ts.isBigIntLiteral(expression)) return expression.text.slice(0, -1)
  if (ts.isPrefixUnaryExpression(expression)
    && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
    && ts.isNumericLiteral(expression.operand)) {
    const sign = expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1
    return String(sign * Number(expression.operand.text))
  }
  switch (expression.kind) {
    case ts.SyntaxKind.NullKeyword: return 'null'
    case ts.SyntaxKind.FalseKeyword: return 'false'
    case ts.SyntaxKind.TrueKeyword: return 'true'
    default: return null
  }
}

function alternateClasses(left: ClassSummary, right: ClassSummary): ClassSummary {
  return normalizeSummary(
    [...left.possibleClasses, ...right.possibleClasses],
    combinedCoverage(left, right),
    [...left.outcomes, ...right.outcomes],
  )
}

function andClasses(left: ClassSummary, right: ClassSummary): ClassSummary {
  const outcomes: ClassOutcome[] = []
  let rightReachable = false
  for (const leftOutcome of left.outcomes) {
    switch (leftOutcome.kind) {
      case 'nullish': outcomes.push({kind: 'nullish'}); break
      case 'falsy': outcomes.push({kind: 'falsy'}); break
      case 'truthy':
        rightReachable = true
        outcomes.push(...right.outcomes)
        break
    }
  }
  return normalizeSummary(
    rightReachable ? right.possibleClasses : [],
    rightReachable ? right.coverage : 'complete',
    outcomes,
  )
}

function orClasses(left: ClassSummary, right: ClassSummary): ClassSummary {
  const outcomes: ClassOutcome[] = []
  let rightReachable = false
  for (const leftOutcome of left.outcomes) {
    switch (leftOutcome.kind) {
      case 'nullish':
      case 'falsy':
        rightReachable = true
        outcomes.push(...right.outcomes)
        break
      case 'truthy': outcomes.push(leftOutcome); break
    }
  }
  return normalizeSummary(
    [...left.possibleClasses, ...(rightReachable ? right.possibleClasses : [])],
    left.coverage === 'partial' || (rightReachable && right.coverage === 'partial') ? 'partial' : 'complete',
    outcomes,
  )
}

function coalesceClasses(left: ClassSummary, right: ClassSummary): ClassSummary {
  const outcomes: ClassOutcome[] = []
  let rightReachable = false
  for (const leftOutcome of left.outcomes) {
    switch (leftOutcome.kind) {
      case 'nullish':
        rightReachable = true
        outcomes.push(...right.outcomes)
        break
      case 'falsy':
      case 'truthy': outcomes.push(leftOutcome); break
    }
  }
  return normalizeSummary(
    [...left.possibleClasses, ...(rightReachable ? right.possibleClasses : [])],
    left.coverage === 'partial' || (rightReachable && right.coverage === 'partial') ? 'partial' : 'complete',
    outcomes,
  )
}

function joinClasses(left: ClassSummary, right: ClassSummary): ClassSummary {
  const outcomes: ClassOutcome[] = []
  for (const leftOutcome of left.outcomes) {
    for (const rightOutcome of right.outcomes) {
      const leftPosition = leftOutcome.kind === 'truthy' ? leftOutcome.position : null
      const rightPosition = rightOutcome.kind === 'truthy' ? rightOutcome.position : null
      if (leftPosition == null && rightPosition == null) {
        outcomes.push({kind: 'falsy'})
      } else {
        outcomes.push({
          kind: 'truthy',
          position: combinePositionTraces(leftPosition ?? 'none', rightPosition ?? 'none'),
        })
      }
    }
  }
  return normalizeSummary(
    [...left.possibleClasses, ...right.possibleClasses],
    combinedCoverage(left, right),
    outcomes,
  )
}

function applyTailwindMerge(summary: ClassSummary): ClassSummary {
  return normalizeSummary(
    summary.possibleClasses,
    summary.coverage,
    summary.outcomes.map(outcome => {
      if (outcome.kind !== 'truthy' || outcome.position !== 'positionedThenStatic') return outcome
      return {kind: 'truthy', position: 'static'}
    }),
  )
}

function combinePositionTraces(left: PositionTrace, right: PositionTrace): PositionTrace {
  const everPositioned = hasPosition(left) || hasPosition(right)
  const rightEffect = lastPositionEffect(right)
  const lastEffect = rightEffect === 'none' ? lastPositionEffect(left) : rightEffect
  if (!everPositioned) return lastEffect === 'static' ? 'static' : 'none'
  return lastEffect === 'static' ? 'positionedThenStatic' : 'positioned'
}

function hasPosition(trace: PositionTrace): boolean {
  return trace === 'positioned' || trace === 'positionedThenStatic'
}

function lastPositionEffect(trace: PositionTrace): 'none' | 'static' | 'positioned' {
  switch (trace) {
    case 'none': return 'none'
    case 'static':
    case 'positionedThenStatic': return 'static'
    case 'positioned': return 'positioned'
  }
}

function positionTrace(classes: ClassFact[]): PositionTrace {
  let trace: PositionTrace = 'none'
  for (const classFact of classes) {
    if (classFact.kind !== 'position'
      || classFact.target !== 'self'
      || classFact.condition !== 'always') continue
    trace = combinePositionTraces(trace, classFact.status === 'none' ? 'static' : 'positioned')
  }
  return trace
}

function normalizeSummary(
  possibleClasses: ClassFact[],
  coverage: ClassSummary['coverage'],
  outcomes: ClassOutcome[],
): ClassSummary {
  const uniqueClasses: ClassFact[] = []
  for (const classFact of possibleClasses) {
    if (!uniqueClasses.some(existing => existing.kind === classFact.kind && existing.token === classFact.token)) {
      uniqueClasses.push(classFact)
    }
  }
  const uniqueOutcomes = outcomeOrder.filter(candidate =>
    outcomes.some(outcome => sameOutcome(candidate, outcome)))
  if (uniqueOutcomes.length === 0) throw new Error('A class summary must have at least one runtime outcome')
  return {possibleClasses: uniqueClasses, coverage, outcomes: uniqueOutcomes}
}

function sameOutcome(left: ClassOutcome, right: ClassOutcome): boolean {
  if (left.kind !== right.kind) return false
  return left.kind !== 'truthy' || (right.kind === 'truthy' && left.position === right.position)
}

function combinedCoverage(left: ClassSummary, right: ClassSummary): ClassSummary['coverage'] {
  return left.coverage === 'complete' && right.coverage === 'complete' ? 'complete' : 'partial'
}

function markPartial(summary: ClassSummary): ClassSummary {
  return {...summary, coverage: 'partial'}
}

// A value inside a template or string concatenation is converted to text. The finite
// class domain does not distinguish false, zero, and the empty string, so a falsy or
// nullish source conservatively becomes either empty text or truthy non-positioning
// text. This prevents an enclosing || from treating e.g. `${false}` as definitely empty.
function stringifiedSummary(summary: ClassSummary): ClassSummary {
  const outcomes: ClassOutcome[] = []
  for (const outcome of summary.outcomes) {
    if (outcome.kind === 'truthy') {
      outcomes.push(outcome)
    } else {
      outcomes.push({kind: 'falsy'}, {kind: 'truthy', position: 'none'})
    }
  }
  return normalizeSummary(summary.possibleClasses, summary.coverage, outcomes)
}

type StaticTruthiness = 'truthy' | 'falsy' | 'unknown'

function staticTruthiness(expression: ts.Expression): StaticTruthiness {
  if (ts.isParenthesizedExpression(expression)) return staticTruthiness(expression.expression)
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return 'truthy'
  if (expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword) return 'falsy'
  if (ts.isVoidExpression(expression)) return 'falsy'
  if (ts.isObjectLiteralExpression(expression)
    || ts.isArrayLiteralExpression(expression)
    || ts.isArrowFunction(expression)
    || ts.isFunctionExpression(expression)
    || ts.isClassExpression(expression)
    || ts.isRegularExpressionLiteral(expression)
    || ts.isNewExpression(expression)) return 'truthy'
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text === '' ? 'falsy' : 'truthy'
  }
  if (ts.isNumericLiteral(expression)) return Number(expression.text) === 0 ? 'falsy' : 'truthy'
  if (ts.isBigIntLiteral(expression)) return BigInt(expression.text.slice(0, -1)) === 0n ? 'falsy' : 'truthy'
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = staticTruthiness(expression.operand)
    return operand === 'truthy' ? 'falsy' : operand === 'falsy' ? 'truthy' : 'unknown'
  }
  if (ts.isPrefixUnaryExpression(expression)
    && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
    && ts.isNumericLiteral(expression.operand)) {
    return Number(expression.operand.text) === 0 ? 'falsy' : 'truthy'
  }
  return 'unknown'
}

function falseishExpressionSummary(expression: ts.Expression): ClassSummary {
  return expression.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(expression)
    ? normalizeSummary([], 'complete', [{kind: 'nullish'}])
    : emptyClassSummary()
}

type StringPiece = {kind: 'text'; text: string} | {kind: 'expression'; summary: ClassSummary}

function templatePieces(template: ts.TemplateExpression): StringPiece[] {
  const pieces: StringPiece[] = [{kind: 'text', text: template.head.text}]
  for (const span of template.templateSpans) {
    pieces.push({kind: 'expression', summary: extractClassExpression(span.expression)})
    pieces.push({kind: 'text', text: span.literal.text})
  }
  return pieces
}

function concatPieces(expression: ts.Expression): StringPiece[] {
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...concatPieces(expression.left), ...concatPieces(expression.right)]
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [{kind: 'text', text: expression.text}]
  }
  if (ts.isTemplateExpression(expression)) return templatePieces(expression)
  return [{kind: 'expression', summary: extractClassExpression(expression)}]
}

function extractStringPieces(rawPieces: StringPiece[]): ClassSummary {
  const pieces: StringPiece[] = []
  for (const piece of rawPieces) {
    const last = pieces.at(-1)
    if (piece.kind === 'text' && last?.kind === 'text') {
      pieces[pieces.length - 1] = {kind: 'text', text: last.text + piece.text}
    } else if (piece.kind !== 'text' || piece.text !== '') {
      pieces.push(piece)
    }
  }

  let combined = emptyClassSummary()
  let fusedBoundary = false
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]!
    const previous = index > 0 ? pieces[index - 1]! : null
    const next = index + 1 < pieces.length ? pieces[index + 1]! : null
    if (piece.kind === 'text') {
      const fusedLeft = previous != null && /^\S/.test(piece.text)
      const fusedRight = next != null && /\S$/.test(piece.text)
      const parts = splitClassTokens(piece.text)
      const kept = parts.slice(
        fusedLeft ? 1 : 0,
        fusedRight ? Math.max(parts.length - 1, fusedLeft ? 1 : 0) : parts.length,
      )
      if (fusedLeft || fusedRight) fusedBoundary = true
      if (kept.length > 0) combined = joinClasses(combined, literalClassSummary(kept.join(' ')))
      else if (piece.text !== '') combined = joinClasses(combined, truthyNoClassSummary())
    } else {
      const previousFuses = previous != null && (previous.kind === 'expression' || /\S$/.test(previous.text))
      const nextFuses = next != null && (next.kind === 'expression' || /^\S/.test(next.text))
      if (previousFuses || nextFuses) {
        fusedBoundary = true
        combined = joinClasses(combined, stringifiedSummary(unknownClassSummary()))
      } else {
        combined = joinClasses(combined, stringifiedSummary(piece.summary))
      }
    }
  }
  return fusedBoundary ? markPartial(combined) : combined
}

function splitClassTokens(text: string): string[] {
  return text.split(/\s+/).filter(token => token !== '')
}
