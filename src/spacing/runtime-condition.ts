import * as ts from 'typescript'
import type {
  GuardPredicate,
  GuardTerm,
  GuardValue,
  RuntimeCases,
  RuntimeGuard,
  StableReference,
} from './model.ts'

const alternativeLimit = 16

export function alwaysRuntimeCases(): RuntimeCases {
  return {kind: 'known', alternatives: [[]]}
}

export function unknownRuntimeCases(): RuntimeCases {
  return {kind: 'unknown'}
}

export function conditionCases(expression: ts.Expression, expected: boolean): RuntimeCases {
  if (ts.isParenthesizedExpression(expression)) return conditionCases(expression.expression, expected)
  if (ts.isPrefixUnaryExpression(expression)
    && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return conditionCases(expression.operand, !expected)
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return expected
          ? intersectCases(conditionCases(expression.left, true), conditionCases(expression.right, true))
          : unionCases(
              conditionCases(expression.left, false),
              intersectCases(conditionCases(expression.left, true), conditionCases(expression.right, false)),
            )
      case ts.SyntaxKind.BarBarToken:
        return expected
          ? unionCases(
              conditionCases(expression.left, true),
              intersectCases(conditionCases(expression.left, false), conditionCases(expression.right, true)),
            )
          : intersectCases(conditionCases(expression.left, false), conditionCases(expression.right, false))
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: {
        const predicate = equalityPredicate(expression.left, expression.right)
        if (predicate == null) return unknownRuntimeCases()
        const equalityExpected = expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        return casesForTerm({predicate, expected: expected === equalityExpected})
      }
      default: break
    }
  }
  const truthiness = staticTruthiness(expression)
  if (truthiness != null) return truthiness === expected ? alwaysRuntimeCases() : knownCases([])
  const reference = stableReference(expression)
  return reference == null
    ? unknownRuntimeCases()
    : casesForTerm({predicate: {kind: 'truthy', reference}, expected})
}

export function inlineValuePresence(expression: ts.Expression, globalUndefined: boolean): RuntimeCases {
  if (ts.isParenthesizedExpression(expression)) return inlineValuePresence(expression.expression, globalUndefined)
  if (expression.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(expression)) return knownCases([])
  if (ts.isIdentifier(expression) && expression.text === 'undefined') {
    return globalUndefined ? knownCases([]) : unknownRuntimeCases()
  }
  if (ts.isConditionalExpression(expression)) {
    const truePresence = inlineValuePresence(expression.whenTrue, globalUndefined)
    const falsePresence = inlineValuePresence(expression.whenFalse, globalUndefined)
    if (isAlways(truePresence) && isAlways(falsePresence)) return alwaysRuntimeCases()
    if (isNever(truePresence) && isNever(falsePresence)) return knownCases([])
    const whenTrue = intersectCases(
      conditionCases(expression.condition, true),
      truePresence,
    )
    const whenFalse = intersectCases(
      conditionCases(expression.condition, false),
      falsePresence,
    )
    return unionCases(whenTrue, whenFalse)
  }
  if (ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const fallback = inlineValuePresence(expression.right, globalUndefined)
    if (isNever(fallback)) {
      const reference = stableReference(expression.left)
      return reference == null
        ? unknownRuntimeCases()
        : casesForTerm({predicate: {kind: 'defined', reference}, expected: true})
    }
    if (isAlways(fallback)) return alwaysRuntimeCases()
    return unknownRuntimeCases()
  }
  return alwaysRuntimeCases()
}

export function combineGuards(left: RuntimeGuard, right: RuntimeGuard): RuntimeGuard | null {
  const combined: RuntimeGuard = [...left]
  for (const term of right) {
    if (combined.some(candidate => termsContradict(candidate, term))) return null
    const existing = combined.find(candidate => samePredicate(candidate.predicate, term.predicate))
    if (existing != null) {
      continue
    }
    combined.push(term)
  }
  return combined
}

export type GuardRelationship = 'overlap' | 'disjoint' | 'unknown'

export function guardRelationship(left: RuntimeGuard, right: RuntimeGuard): GuardRelationship {
  if (combineGuards(left, right) == null) return 'disjoint'
  if (isGuardSubset(left, right) || isGuardSubset(right, left)) return 'overlap'
  return 'unknown'
}

export function isAlways(cases: RuntimeCases): boolean {
  return cases.kind === 'known'
    && cases.alternatives.length === 1
    && cases.alternatives[0]!.length === 0
}

function isNever(cases: RuntimeCases): boolean {
  return cases.kind === 'known' && cases.alternatives.length === 0
}

function casesForTerm(term: GuardTerm): RuntimeCases {
  return knownCases([[term]])
}

function intersectCases(left: RuntimeCases, right: RuntimeCases): RuntimeCases {
  if (left.kind === 'unknown' || right.kind === 'unknown') return unknownRuntimeCases()
  const alternatives: RuntimeGuard[] = []
  for (const leftGuard of left.alternatives) {
    for (const rightGuard of right.alternatives) {
      const combined = combineGuards(leftGuard, rightGuard)
      if (combined != null) alternatives.push(combined)
      if (alternatives.length > alternativeLimit) return unknownRuntimeCases()
    }
  }
  return knownCases(alternatives)
}

function unionCases(left: RuntimeCases, right: RuntimeCases): RuntimeCases {
  if (left.kind === 'unknown' || right.kind === 'unknown') return unknownRuntimeCases()
  if (left.alternatives.length + right.alternatives.length > alternativeLimit) return unknownRuntimeCases()
  return knownCases([...left.alternatives, ...right.alternatives])
}

function knownCases(alternatives: RuntimeGuard[]): RuntimeCases {
  const unique: RuntimeGuard[] = []
  for (const alternative of alternatives) {
    if (!unique.some(existing => sameGuard(existing, alternative))) unique.push(alternative)
  }
  return {kind: 'known', alternatives: unique}
}

function equalityPredicate(left: ts.Expression, right: ts.Expression): GuardPredicate | null {
  const leftReference = stableReference(left)
  const rightValue = guardValue(right)
  if (leftReference != null && rightValue != null) {
    return {kind: 'equals', reference: leftReference, value: rightValue}
  }
  const rightReference = stableReference(right)
  const leftValue = guardValue(left)
  return rightReference != null && leftValue != null
    ? {kind: 'equals', reference: rightReference, value: leftValue}
    : null
}

function stableReference(expression: ts.Expression): StableReference | null {
  if (ts.isParenthesizedExpression(expression)) return stableReference(expression.expression)
  if (ts.isIdentifier(expression)) return {root: expression.text, properties: []}
  if (!ts.isPropertyAccessExpression(expression) || expression.questionDotToken != null) return null
  const parent = stableReference(expression.expression)
  return parent == null
    ? null
    : {root: parent.root, properties: [...parent.properties, expression.name.text]}
}

function guardValue(expression: ts.Expression): GuardValue | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return {kind: 'string', value: expression.text}
  }
  if (ts.isNumericLiteral(expression)) return {kind: 'number', value: Number(expression.text)}
  switch (expression.kind) {
    case ts.SyntaxKind.TrueKeyword: return {kind: 'boolean', value: true}
    case ts.SyntaxKind.FalseKeyword: return {kind: 'boolean', value: false}
    case ts.SyntaxKind.NullKeyword: return {kind: 'null'}
    default: return null
  }
}

function staticTruthiness(expression: ts.Expression): boolean | null {
  switch (expression.kind) {
    case ts.SyntaxKind.TrueKeyword: return true
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword: return false
    default: break
  }
  if (ts.isVoidExpression(expression)) return false
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text !== ''
  if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0
  return null
}

function sameGuard(left: RuntimeGuard, right: RuntimeGuard): boolean {
  return left.length === right.length && isGuardSubset(left, right)
}

function isGuardSubset(left: RuntimeGuard, right: RuntimeGuard): boolean {
  return left.every(leftTerm => right.some(rightTerm => sameTerm(leftTerm, rightTerm)))
}

function sameTerm(left: GuardTerm, right: GuardTerm): boolean {
  return left.expected === right.expected && samePredicate(left.predicate, right.predicate)
}

function termsContradict(left: GuardTerm, right: GuardTerm): boolean {
  if (!sameReference(left.predicate.reference, right.predicate.reference)) return false
  if (samePredicate(left.predicate, right.predicate)) return left.expected !== right.expected
  if (left.predicate.kind === 'equals'
    && right.predicate.kind === 'equals'
    && left.expected
    && right.expected) {
    return !sameGuardValue(left.predicate.value, right.predicate.value)
  }
  if (left.predicate.kind === 'equals' && left.expected) {
    return valueContradictsPredicate(left.predicate.value, right)
  }
  if (right.predicate.kind === 'equals' && right.expected) {
    return valueContradictsPredicate(right.predicate.value, left)
  }
  return false
}

function valueContradictsPredicate(value: GuardValue, term: GuardTerm): boolean {
  switch (term.predicate.kind) {
    case 'truthy': return guardValueIsTruthy(value) !== term.expected
    case 'defined': return (value.kind !== 'null') !== term.expected
    case 'equals': return false
  }
}

function guardValueIsTruthy(value: GuardValue): boolean {
  switch (value.kind) {
    case 'null': return false
    case 'string': return value.value !== ''
    case 'number': return value.value !== 0
    case 'boolean': return value.value
  }
}

function samePredicate(left: GuardPredicate, right: GuardPredicate): boolean {
  if (left.kind !== right.kind || !sameReference(left.reference, right.reference)) return false
  if (left.kind !== 'equals') return true
  return right.kind === 'equals' && sameGuardValue(left.value, right.value)
}

function sameReference(left: StableReference, right: StableReference): boolean {
  return left.root === right.root
    && left.properties.length === right.properties.length
    && left.properties.every((property, index) => property === right.properties[index])
}

function sameGuardValue(left: GuardValue, right: GuardValue): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'null': return true
    case 'string': return right.kind === 'string' && left.value === right.value
    case 'number': return right.kind === 'number' && left.value === right.value
    case 'boolean': return right.kind === 'boolean' && left.value === right.value
  }
}
