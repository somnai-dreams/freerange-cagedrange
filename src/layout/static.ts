import {existsSync} from 'node:fs'
import {relative, resolve} from 'node:path'
import * as ts from 'typescript'
import {evalMention, typeCheckSuppressionMention} from '../lower/accept.ts'
import {
  findProjectSource,
  findTypeScriptConfig,
  loadSyntaxTypeScriptProjectGraph,
  type ProjectSource,
} from '../typescript/project.ts'
import {
  layoutAdd,
  layoutChoice,
  layoutConstant,
  layoutExpressionRange,
  layoutMaximum,
  layoutMinimum,
  layoutOpaque,
  proveLayoutEquality,
  type LayoutExpression,
  type LayoutExpressionRange,
} from './algebra.ts'
import {resolveCssClasses} from './css.ts'
import {checkLineBoxContainment, type LineBoxCheck} from './linebox.ts'
import type {
  StaticLayoutAudit,
  StaticLayoutCheck,
  StaticLayoutConstraint,
  StaticLayoutEvidence,
  StaticLayoutSuite,
  StaticLayoutTarget,
  StaticLayoutUnknownReason,
} from './model.ts'

const maximumAlternatives = 16
const maximumConstantDepth = 32

// A bound's own block margins stay outside its expression because only the parent knows
// what they mean: flex items add them, block flow may collapse them. Conditional class
// and JSX alternatives can disagree about a margin, so each margin is a range; a
// degenerate range is the ordinary single-value case.
type MarginRangePx = {minPx: number; maxPx: number}

type Bound = {
  expression: LayoutExpression
  witnessMinimumPx: number
  evidence: StaticLayoutEvidence[]
  unknownReasons: string[]
  marginTop: MarginRangePx
  marginBottom: MarginRangePx
  conditional: boolean
}

type BlockFacts = {
  layout: 'block' | 'inline' | 'flex-row' | 'flex-column' | 'none'
  outOfFlow: boolean
  boxSizing: 'border-box' | 'content-box'
  heightPx: number | null
  minHeightPx: number
  maxHeightPx: number | null
  paddingTopPx: number
  paddingBottomPx: number
  marginTopPx: number
  marginBottomPx: number
  borderTopPx: number
  borderBottomPx: number
  importantProperties: Set<string>
  lowerBoundReliable: boolean
  unknownReasons: string[]
}

type StyleAlternative = Map<string, ts.Expression>

export function runStaticLayoutSuite(suite: StaticLayoutSuite, configDirectory: string): StaticLayoutAudit {
  // Line-box claims read stylesheets, not the TypeScript project, so they run either way.
  const lineBoxChecks = runLineBoxClaims(suite, configDirectory)
  if (suite.constraints.length === 0) return {checks: [], lineBoxChecks}
  const configPath = findTypeScriptConfig(configDirectory)
  if (configPath == null) {
    return {checks: suite.constraints.map(constraint => unknownCheck(
      constraint,
      targetForConstraint(suite, constraint),
      {kind: 'typescriptProjectMissing'},
    )), lineBoxChecks}
  }
  const graph = loadSyntaxTypeScriptProjectGraph(configPath)
  return {
    lineBoxChecks,
    checks: suite.constraints.map(constraint => {
      const target = targetForConstraint(suite, constraint)
      const sourceFile = resolve(configDirectory, target.source.file)
      if (!existsSync(sourceFile)) {
        return unknownCheck(constraint, target, {kind: 'sourceFileMissing', file: target.source.file})
      }
      const projectSource = findProjectSource(graph, sourceFile)
      if (projectSource == null) {
        return unknownCheck(constraint, target, {kind: 'sourceFileOutsideProject', file: target.source.file})
      }
      return auditSourceConstraint(projectSource, constraint, target, configDirectory)
    }),
  }
}

function runLineBoxClaims(suite: StaticLayoutSuite, configDirectory: string): LineBoxCheck[] {
  if (suite.lineBoxContainment.length === 0) return []
  const index = resolveCssClasses(configDirectory)
  if (index.stylesheets.length === 0) {
    return suite.lineBoxContainment.map(claim => ({
      kind: 'unknown' as const,
      claim: claim.name,
      reason: 'no stylesheets were discovered under the config directory',
    }))
  }
  return suite.lineBoxContainment.map(claim => checkLineBoxContainment(claim, index))
}

function targetForConstraint(suite: StaticLayoutSuite, constraint: StaticLayoutConstraint): StaticLayoutTarget {
  return suite.targets.find(target => target.name === constraint.target)!
}

function auditSourceConstraint(
  projectSource: ProjectSource,
  constraint: StaticLayoutConstraint,
  target: StaticLayoutTarget,
  configDirectory: string,
): StaticLayoutCheck {
  // Branch reachability rests on the checker's word, so the numeric analyzer's file-wide
  // trust rules apply to the marked file: a type-check suppression can put a wrong value
  // behind any declared type, and an eval string can rewrite the bindings constants are
  // followed through. Either one could prune a reachable alternative into a false pass.
  if (typeCheckSuppressionMention(projectSource.sourceFile) != null) {
    return unknownCheck(constraint, target, {kind: 'sourceSuppressesTypeChecking', file: target.source.file})
  }
  if (evalMention(projectSource.sourceFile) != null) {
    return unknownCheck(constraint, target, {kind: 'sourceMentionsEval', file: target.source.file})
  }
  const matches = findMarkedElements(projectSource.sourceFile, target.source.marker)
  if (matches.length === 0) {
    return unknownCheck(constraint, target, {kind: 'sourceMarkerMissing', marker: target.source.marker})
  }
  if (matches.length > 1) {
    return unknownCheck(constraint, target, {
      kind: 'sourceMarkerMatchedMultiple',
      marker: target.source.marker,
      count: matches.length,
    })
  }
  const context: EvaluationContext = {
    checker: projectSource.project.program.getTypeChecker(),
    configDirectory,
    constantStack: new Set(),
    viewportWidths: constraint.viewportWidths,
  }
  const markedElement = matches[0]!
  const reachability = markedElementReachability(markedElement, context)
  if (reachability === 'unreachable') {
    return unknownCheck(constraint, target, {
      kind: 'unsupportedSource',
      reasons: ['source marker is inside a statically unreachable branch'],
    })
  }
  const sourceBound = elementBound(markedElement, context, 'target')
  const ancestorRisk = sourceAncestorRisk(markedElement, context)
  const ancestryAdjusted: Bound = ancestorRisk == null
    ? sourceBound
    : {
        ...sourceBound,
        expression: layoutOpaque({minimum: 0, maximum: null}, ancestorRisk),
        witnessMinimumPx: 0,
        evidence: [],
        unknownReasons: [...sourceBound.unknownReasons, ancestorRisk],
      }
  const bound: Bound = reachability === 'always'
    ? ancestryAdjusted
    : reachability === 'conditional'
      ? {
          ...ancestryAdjusted,
          expression: layoutOpaque(
            {minimum: 0, maximum: null},
            'source target renders only conditionally',
          ),
          unknownReasons: [...ancestryAdjusted.unknownReasons, 'source target renders only conditionally'],
          conditional: true,
        }
      : {
          ...ancestryAdjusted,
          expression: layoutOpaque(
            {minimum: 0, maximum: null},
            'source target reachability could not be proven',
          ),
          witnessMinimumPx: 0,
          evidence: [],
          unknownReasons: [...ancestryAdjusted.unknownReasons, 'source target reachability could not be proven'],
          conditional: true,
        }
  const range = sourceRange(bound.expression)
  const upperLimit = constraint.pixels + constraint.tolerancePx
  if (bound.witnessMinimumPx > upperLimit) {
    return {
      kind: 'fail',
      constraint: constraint.name,
      target: target.name,
      expectedPixels: constraint.pixels,
      tolerancePx: constraint.tolerancePx,
      minimumPx: range.minimumPx,
      maximumPx: range.maximumPx,
      witnessMinimumPx: bound.witnessMinimumPx,
      violation: {kind: 'atLeast', pixels: bound.witnessMinimumPx},
      evidence: bound.evidence,
    }
  }
  const proof = proveLayoutEquality(
    bound.expression,
    layoutConstant(constraint.pixels),
    constraint.tolerancePx,
  )
  if (proof.kind === 'violated') {
    const violation = proof.minimumDelta != null && proof.minimumDelta > constraint.tolerancePx
      ? {kind: 'atLeast' as const, pixels: constraint.pixels + proof.minimumDelta}
      : proof.maximumDelta != null && proof.maximumDelta < -constraint.tolerancePx
        ? {kind: 'atMost' as const, pixels: constraint.pixels + proof.maximumDelta}
        : null
    if (violation == null) throw new Error('violated layout equality has no violating bound')
    return {
      kind: 'fail',
      constraint: constraint.name,
      target: target.name,
      expectedPixels: constraint.pixels,
      tolerancePx: constraint.tolerancePx,
      minimumPx: range.minimumPx,
      maximumPx: range.maximumPx,
      witnessMinimumPx: violation.kind === 'atLeast'
        ? Math.max(bound.witnessMinimumPx, violation.pixels)
        : bound.witnessMinimumPx,
      violation,
      evidence: violation.kind === 'atLeast'
        ? bound.evidence
        : [],
    }
  }
  if (proof.kind === 'proven' && range.maximumPx != null) {
    return {
      kind: 'pass',
      constraint: constraint.name,
      target: target.name,
      minimumPx: range.minimumPx,
      maximumPx: range.maximumPx,
    }
  }
  const spanReason = range.maximumPx == null
    ? []
    : [`source alternatives are bounded between ${pixels(range.minimumPx)} and ${pixels(range.maximumPx)}, but their conditions are not correlated across siblings`]
  const proofReasons = proof.kind === 'unknown' ? proof.reasons : []
  return unknownCheck(
    constraint,
    target,
    {kind: 'unsupportedSource', reasons: unique([...bound.unknownReasons, ...proofReasons, ...spanReason])},
    range.minimumPx,
    range.maximumPx,
  )
}

function markedElementReachability(
  element: ts.Node,
  context: EvaluationContext,
): 'always' | 'conditional' | 'unreachable' | 'unknown' {
  let reachability: 'always' | 'conditional' | 'unreachable' | 'unknown' = 'always'
  let child = element
  while (!ts.isSourceFile(child)) {
    const parent = child.parent
    if (ts.isConditionalExpression(parent)) {
      const required = parent.whenTrue === child ? true : parent.whenFalse === child ? false : null
      if (required != null) {
        reachability = combineReachability(
          reachability,
          branchReachability(parent.condition, required, context),
        )
      }
    } else if (ts.isBinaryExpression(parent)) {
      if (parent.right === child && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        reachability = combineReachability(reachability, branchReachability(parent.left, true, context))
      } else if (parent.right === child && parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        reachability = combineReachability(reachability, branchReachability(parent.left, false, context))
      } else if (parent.left === child
        && (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
          || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken
          || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
        reachability = 'unknown'
      }
    } else if (ts.isIfStatement(parent)) {
      const required = parent.thenStatement === child ? true : parent.elseStatement === child ? false : null
      if (required != null) {
        reachability = combineReachability(
          reachability,
          branchReachability(parent.expression, required, context),
        )
      }
    }
    if (reachability === 'unreachable') return reachability
    child = parent
  }
  return reachability
}

function branchReachability(
  condition: ts.Expression,
  required: boolean,
  context: EvaluationContext,
): 'always' | 'conditional' | 'unreachable' | 'unknown' {
  const possibilities = booleanPossibilities(condition, context, 0)
  if (possibilities == null) return booleanBranchProven(condition, required, context, 0)
    ? 'conditional'
    : 'unknown'
  const requiredPossible = required ? possibilities.canBeTrue : possibilities.canBeFalse
  if (!requiredPossible) return 'unreachable'
  const oppositePossible = required ? possibilities.canBeFalse : possibilities.canBeTrue
  return oppositePossible ? 'conditional' : 'always'
}

function combineReachability(
  current: 'always' | 'conditional' | 'unknown',
  next: 'always' | 'conditional' | 'unreachable' | 'unknown',
): 'always' | 'conditional' | 'unreachable' | 'unknown' {
  if (next === 'unreachable') return next
  if (current === 'unknown' || next === 'unknown') return 'unknown'
  if (current === 'conditional' || next === 'conditional') return 'conditional'
  return 'always'
}

function findMarkedElements(
  sourceFile: ts.SourceFile,
  marker: string,
): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const matches: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = []
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName)
      && isIntrinsicTag(node.tagName.text)
      && jsxLiteralAttribute(node, 'data-fr-layout') === marker) matches.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return matches
}

type EvaluationContext = {
  checker: ts.TypeChecker
  configDirectory: string
  constantStack: Set<ts.Node>
  viewportWidths: number[]
}

type ElementFactAlternatives = {
  facts: BlockFacts[]
  truncated: boolean
  classCount: number
  styleCount: number
  classAlternativesProven: boolean
  styleAlternativesProven: boolean
}

function elementBound(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: EvaluationContext,
  role: 'target' | 'child',
): Bound {
  const evaluated = elementFactAlternatives(element, context)
  const alternativesNeedCorrelation = evaluated.classCount > 1 && evaluated.styleCount > 1
  const alternatives = evaluated.facts.map(facts => boundWithFacts(element, facts, context, role))
  if (evaluated.truncated) alternatives.push(unknownBound('class and style alternatives exceed the limit'))
  const pressureKeys = new Set<string>()
  for (const facts of evaluated.facts) pressureKeys.add(blockFactsPressureKey(facts))
  const merged = mergeAlternatives(alternatives)
  const hidden = elementHiddenState(element, context)
  const hiddenAdjusted = hidden === 'conditional'
    ? {
        ...merged,
        expression: layoutOpaque({minimum: 0, maximum: null}, 'the hidden attribute is conditional'),
        conditional: true,
      }
    : merged
  const parentAndChildNeedCorrelation = pressureKeys.size > 1
    && alternatives.some(alternative => alternative.conditional)
  const unprovenElementAlternatives = pressureKeys.size > 1
    && (!evaluated.classAlternativesProven || !evaluated.styleAlternativesProven)
  if (!alternativesNeedCorrelation && !parentAndChildNeedCorrelation && !unprovenElementAlternatives) {
    return hiddenAdjusted
  }
  const correlationReasons = [
    ...(alternativesNeedCorrelation ? ['conditional className and style alternatives cannot be correlated'] : []),
    ...(parentAndChildNeedCorrelation
      ? ['parent geometry alternatives cannot be correlated with descendant JSX alternatives']
      : []),
    ...(unprovenElementAlternatives ? ['conditional className or style alternatives are not proven reachable'] : []),
  ]
  const range = sourceRange(hiddenAdjusted.expression)
  return {
    ...hiddenAdjusted,
    expression: layoutOpaque(
      {minimum: range.minimumPx, maximum: range.maximumPx},
      correlationReasons as [string, ...string[]],
    ),
    witnessMinimumPx: range.minimumPx,
    evidence: [],
    unknownReasons: [
      ...hiddenAdjusted.unknownReasons,
      ...correlationReasons,
    ],
  }
}

function elementFactAlternatives(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: EvaluationContext,
): ElementFactAlternatives {
  const classValues = elementClassValues(element, context)
  const styleValues = elementStyleValues(element, context)
  const hidden = elementHiddenState(element, context)
  const facts: BlockFacts[] = []
  let truncated = false
  for (const classValue of classValues.values) {
    for (const style of styleValues.values) {
      if (facts.length >= maximumAlternatives) {
        truncated = true
        break
      }
      const alternative = applyInlineStyle(
        classFacts(
          classValue,
          classValues.complete,
          context.viewportWidths,
          intrinsicDefaultLayout(element.tagName.getText()),
        ),
        style,
        styleValues.complete,
        context,
      )
      if (hidden === 'hidden') alternative.layout = 'none'
      else if (hidden === 'conditional') alternative.unknownReasons.push('the hidden attribute is conditional')
      else if (hidden === 'unknown') {
        alternative.lowerBoundReliable = false
        alternative.unknownReasons.push('the hidden attribute condition is outside the supported boolean subset')
      }
      facts.push(alternative)
    }
    if (truncated) break
  }
  return {
    facts,
    truncated,
    classCount: classValues.values.length,
    styleCount: styleValues.values.length,
    classAlternativesProven: classValues.alternativesProven,
    styleAlternativesProven: styleValues.alternativesProven,
  }
}

function sourceAncestorRisk(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: EvaluationContext,
): string | null {
  const targetAlternatives = elementFactAlternatives(element, context)
  if (targetAlternatives.truncated) return 'source target class and style alternatives exceed the limit'
  const child: ts.Node = ts.isJsxOpeningElement(element) ? element.parent : element
  let directParent = true
  for (let ancestor = child.parent; !ts.isSourceFile(ancestor); ancestor = ancestor.parent) {
    if (!ts.isJsxElement(ancestor)) continue
    const opening = ancestor.openingElement
    if (!ts.isIdentifier(opening.tagName) || !isIntrinsicTag(opening.tagName.text)) {
      return 'a component ancestor controls the source target parent layout'
    }
    const alternatives = elementFactAlternatives(opening, context)
    if (alternatives.truncated) return 'ancestor class and style alternatives exceed the limit'
    if (directParent && alternatives.facts.some(facts => !facts.lowerBoundReliable)) {
      return 'the direct parent block geometry is outside the static layout subset'
    }
    if (alternatives.facts.some(facts => facts.layout === 'none')) {
      return 'an ancestor can remove the source target principal box'
    }
    if (directParent && alternatives.facts.some(facts =>
      facts.layout === 'flex-column' && (facts.heightPx != null || facts.maxHeightPx != null))) {
      return 'a size-constrained flex-column parent can shrink the source target'
    }
    if (directParent
      && alternatives.facts.some(facts => facts.layout === 'flex-row')
      && targetAlternatives.facts.some(facts => facts.heightPx == null)) {
      return 'a flex-row parent can stretch the auto-sized source target'
    }
    directParent = false
  }
  return null
}

// Every fact that can change the produced bound must be in the key, unknown reasons
// included: a class like flex-wrap contributes only an unknown reason, and two
// alternatives that differ only there must still count as different pressure — collapsing
// them would turn an unproven alternative into a definite claim. JSON keeps the key
// injective; a plain join cannot tell null from an empty string.
function blockFactsPressureKey(facts: BlockFacts): string {
  return JSON.stringify([
    facts.layout,
    facts.outOfFlow,
    facts.boxSizing,
    facts.heightPx,
    facts.minHeightPx,
    facts.maxHeightPx,
    facts.paddingTopPx,
    facts.paddingBottomPx,
    facts.marginTopPx,
    facts.marginBottomPx,
    facts.borderTopPx,
    facts.borderBottomPx,
    facts.lowerBoundReliable,
    [...facts.importantProperties].sort(),
    facts.unknownReasons,
  ])
}

function elementHiddenState(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: EvaluationContext,
): 'visible' | 'hidden' | 'conditional' | 'unknown' {
  const attribute = jsxAttribute(element, 'hidden')
  if (attribute == null) return 'visible'
  if (attribute.initializer == null) return 'hidden'
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text === 'until-found' ? 'conditional' : 'hidden'
  }
  if (!ts.isJsxExpression(attribute.initializer) || attribute.initializer.expression == null) return 'unknown'
  const possibilities = booleanPossibilities(attribute.initializer.expression, context, 0)
  if (possibilities == null) return 'unknown'
  if (possibilities.canBeTrue && possibilities.canBeFalse) return 'conditional'
  return possibilities.canBeTrue ? 'hidden' : 'visible'
}

function boundWithFacts(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  facts: BlockFacts,
  context: EvaluationContext,
  role: 'target' | 'child',
): Bound {
  if (facts.layout === 'none') {
    if (role === 'target') return unknownBound('source target may have no principal box')
    return facts.unknownReasons.length === 0 ? zeroBound() : unknownBound(facts.unknownReasons)
  }
  if (facts.layout === 'inline') return unknownBound('non-replaced inline boxes ignore explicit block size')
  if (facts.outOfFlow && role === 'child') {
    return facts.unknownReasons.length === 0 ? zeroBound() : unknownBound(facts.unknownReasons)
  }
  const chromePx = facts.paddingTopPx + facts.paddingBottomPx + facts.borderTopPx + facts.borderBottomPx
  if (facts.heightPx != null) {
    const specified = clampSpecifiedExpression(layoutConstant(facts.heightPx), facts)
    const height = sourceRange(facts.boxSizing === 'border-box'
      ? layoutMaximum(layoutConstant(chromePx), specified)
      : layoutAdd(specified, layoutConstant(chromePx))).minimumPx
    return {
      expression: facts.lowerBoundReliable
        ? facts.unknownReasons.length === 0
          ? layoutConstant(height)
          : opaqueSourceExpression({minimum: height, maximum: null}, facts.unknownReasons)
        : opaqueSourceExpression({minimum: 0, maximum: null}, facts.unknownReasons),
      witnessMinimumPx: facts.lowerBoundReliable ? height : 0,
      evidence: facts.lowerBoundReliable
        ? [evidence(element, `explicit block size contributes ${pixels(height)}`, context)]
        : [],
      unknownReasons: facts.unknownReasons,
      marginTop: {minPx: facts.marginTopPx, maxPx: facts.marginTopPx},
      marginBottom: {minPx: facts.marginBottomPx, maxPx: facts.marginBottomPx},
      conditional: false,
    }
  }

  const childBounds = elementChildren(element).map(child => childBound(child, context))
  let content: Bound
  switch (facts.layout) {
    case 'flex-row': content = crossSize(childBounds); break
    case 'flex-column': content = stackedSize(childBounds); break
    case 'block': content = blockSize(childBounds); break
  }
  const knownExpression = autoOuterExpression(content.expression, chromePx, facts)
  const knownRange = sourceRange(knownExpression)
  const witnessMinimumPx = facts.lowerBoundReliable
    ? autoOuterHeight(content.witnessMinimumPx, chromePx, facts)
    : 0
  const chromeEvidence = chromePx === 0
    ? []
    : [evidence(element, `block padding and borders contribute ${pixels(chromePx)}`, context)]
  return {
    expression: facts.lowerBoundReliable
      ? facts.unknownReasons.length === 0
        ? knownExpression
        : opaqueSourceExpression({minimum: knownRange.minimumPx, maximum: null}, facts.unknownReasons)
      : opaqueSourceExpression({minimum: 0, maximum: null}, facts.unknownReasons),
    witnessMinimumPx,
    evidence: [...content.evidence, ...chromeEvidence],
    unknownReasons: [...content.unknownReasons, ...facts.unknownReasons],
    marginTop: {minPx: facts.marginTopPx, maxPx: facts.marginTopPx},
    marginBottom: {minPx: facts.marginBottomPx, maxPx: facts.marginBottomPx},
    conditional: content.conditional,
  }
}

function elementChildren(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): ts.JsxChild[] {
  return ts.isJsxSelfClosingElement(element) ? [] : flattenFragments(element.parent.children)
}

function flattenFragments(children: readonly ts.JsxChild[]): ts.JsxChild[] {
  const flattened: ts.JsxChild[] = []
  for (const child of children) {
    if (ts.isJsxFragment(child)) flattened.push(...flattenFragments(child.children))
    else flattened.push(child)
  }
  return flattened
}

function childBound(child: ts.JsxChild, context: EvaluationContext): Bound {
  if (ts.isJsxText(child)) return child.text.trim() === '' ? zeroBound() : unknownBound('intrinsic text size')
  if (ts.isJsxElement(child)) {
    return ts.isIdentifier(child.openingElement.tagName) && isIntrinsicTag(child.openingElement.tagName.text)
      ? elementBound(child.openingElement, context, 'child')
      : unknownBound(`component <${child.openingElement.tagName.getText()}> has no intrinsic size boundary`)
  }
  if (ts.isJsxSelfClosingElement(child)) {
    return ts.isIdentifier(child.tagName) && isIntrinsicTag(child.tagName.text)
      ? elementBound(child, context, 'child')
      : unknownBound(`component <${child.tagName.getText()}> has no intrinsic size boundary`)
  }
  if (ts.isJsxFragment(child)) return unknownBound('conditional JSX fragments need parent-layout correlation')
  const expression = child.expression
  if (expression == null) return zeroBound()
  return expressionChildBound(expression, context)
}

function expressionChildBound(expression: ts.Expression, context: EvaluationContext): Bound {
  if (ts.isParenthesizedExpression(expression)) return expressionChildBound(expression.expression, context)
  if (ts.isJsxElement(expression)) return childBound(expression, context)
  if (ts.isJsxSelfClosingElement(expression)) return childBound(expression, context)
  if (ts.isJsxFragment(expression)) return unknownBound('conditional JSX fragments need parent-layout correlation')
  if (ts.isConditionalExpression(expression)) {
    const possibilities = booleanPossibilities(expression.condition, context, 0)
    if (possibilities != null) {
      if (!possibilities.canBeFalse) return expressionChildBound(expression.whenTrue, context)
      if (!possibilities.canBeTrue) return expressionChildBound(expression.whenFalse, context)
    }
    return mergeConditional(
      expressionChildBound(expression.whenTrue, context),
      expressionChildBound(expression.whenFalse, context),
      expression.condition.getText(),
      possibilities?.canBeTrue ?? booleanBranchProven(expression.condition, true, context, 0),
      possibilities?.canBeFalse ?? booleanBranchProven(expression.condition, false, context, 0),
    )
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken: {
        const possibilities = booleanPossibilities(expression.left, context, 0)
        if (possibilities != null) {
          if (!possibilities.canBeTrue) return zeroBound()
          if (!possibilities.canBeFalse) return expressionChildBound(expression.right, context)
        }
        return mergeConditional(
          expressionChildBound(expression.right, context),
          zeroBound(),
          expression.left.getText(),
          possibilities?.canBeTrue ?? booleanBranchProven(expression.left, true, context, 0),
          possibilities?.canBeFalse ?? booleanBranchProven(expression.left, false, context, 0),
        )
      }
      case ts.SyntaxKind.BarBarToken: {
        const possibilities = booleanPossibilities(expression.left, context, 0)
        if (possibilities != null) {
          if (!possibilities.canBeFalse) return zeroBound()
          if (!possibilities.canBeTrue) return expressionChildBound(expression.right, context)
        }
        return mergeConditional(
          zeroBound(),
          expressionChildBound(expression.right, context),
          expression.left.getText(),
          possibilities?.canBeTrue ?? booleanBranchProven(expression.left, true, context, 0),
          possibilities?.canBeFalse ?? booleanBranchProven(expression.left, false, context, 0),
        )
      }
      case ts.SyntaxKind.QuestionQuestionToken:
        return mergeConditional(
          expressionChildBound(expression.left, context),
          expressionChildBound(expression.right, context),
          expression.left.getText(),
          false,
          false,
        )
      default: break
    }
  }
  switch (expression.kind) {
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.TrueKeyword:
      return zeroBound()
    default: return unknownBound(`expression '${shortText(expression.getText())}' has unknown intrinsic block size`)
  }
}

function mergeConditional(
  whenTrue: Bound,
  whenFalse: Bound,
  condition: string,
  trueReachable: boolean,
  falseReachable: boolean,
): Bound {
  const trueRange = sourceRange(whenTrue.expression)
  const falseRange = sourceRange(whenFalse.expression)
  const alternatives = layoutChoice(whenTrue.expression, whenFalse.expression)
  const alternativesRange = sourceRange(alternatives)
  const reachabilityProven = trueReachable && falseReachable
  const reachabilityReason = `both outcomes of '${shortText(condition)}' are not proven reachable`
  const trueWins = trueReachable
    && (!falseReachable || whenTrue.witnessMinimumPx >= whenFalse.witnessMinimumPx)
  const witness = trueWins ? whenTrue : whenFalse
  const witnessReachable = trueReachable || falseReachable
  const label = trueWins ? condition : `not (${condition})`
  return {
    expression: reachabilityProven
      ? alternatives
      : layoutOpaque(
          {minimum: alternativesRange.minimumPx, maximum: alternativesRange.maximumPx},
          reachabilityReason,
        ),
    witnessMinimumPx: witnessReachable
      ? witness.witnessMinimumPx
      : Math.min(trueRange.minimumPx, falseRange.minimumPx),
    evidence: witnessReachable
      ? witness.evidence.map(item => ({...item, description: `when ${label}: ${item.description}`}))
      : [],
    unknownReasons: [
      ...whenTrue.unknownReasons,
      ...whenFalse.unknownReasons,
      ...(reachabilityProven ? [] : [reachabilityReason]),
    ],
    marginTop: mergeMarginRanges([whenTrue.marginTop, whenFalse.marginTop]),
    marginBottom: mergeMarginRanges([whenTrue.marginBottom, whenFalse.marginBottom]),
    conditional: true,
  }
}

function mergeMarginRanges(ranges: MarginRangePx[]): MarginRangePx {
  return {
    minPx: Math.min(...ranges.map(range => range.minPx)),
    maxPx: Math.max(...ranges.map(range => range.maxPx)),
  }
}

function crossSize(children: Bound[]): Bound {
  if (children.length === 0) return zeroBound()
  const outer = children.map(outerBound)
  const witness = outer.reduce((largest, child) =>
    child.witnessMinimumPx > largest.witnessMinimumPx ? child : largest, outer[0]!)
  const expression = layoutMaximum(...outer.map(child => child.expression))
  const correlationRisk = outer.filter(child => child.conditional).length > 1
  const correlationReason = 'sibling JSX alternatives cannot be correlated across a flex row'
  const range = sourceRange(expression)
  return {
    expression: correlationRisk
      ? layoutOpaque({minimum: range.minimumPx, maximum: range.maximumPx}, correlationReason)
      : expression,
    witnessMinimumPx: witness.witnessMinimumPx,
    evidence: witness.evidence,
    unknownReasons: [
      ...children.flatMap(child => child.unknownReasons),
      ...(correlationRisk ? [correlationReason] : []),
    ],
    marginTop: {minPx: 0, maxPx: 0},
    marginBottom: {minPx: 0, maxPx: 0},
    conditional: children.some(child => child.conditional),
  }
}

function stackedSize(children: Bound[]): Bound {
  if (children.length === 0) return zeroBound()
  const outer = children.map(outerBound)
  const outerRanges = outer.map(child => sourceRange(child.expression))
  const minimumPx = outerRanges.reduce((sum, child) => sum + child.minimumPx, 0)
  let witness = outer[0]!
  let largestExtra = witness.witnessMinimumPx - outerRanges[0]!.minimumPx
  for (const [index, child] of outer.slice(1).entries()) {
    const extra = child.witnessMinimumPx - outerRanges[index + 1]!.minimumPx
    if (extra > largestExtra) {
      witness = child
      largestExtra = extra
    }
  }
  const expression = layoutAdd(...outer.map(child => child.expression))
  const correlationRisk = outer.filter(child => child.conditional).length > 1
  const correlationReason = 'sibling JSX alternatives cannot be correlated across a stack'
  const range = sourceRange(expression)
  return {
    expression: correlationRisk
      ? layoutOpaque({minimum: range.minimumPx, maximum: range.maximumPx}, correlationReason)
      : expression,
    witnessMinimumPx: minimumPx + Math.max(0, largestExtra),
    evidence: witness.evidence,
    unknownReasons: [
      ...children.flatMap(child => child.unknownReasons),
      ...(correlationRisk ? [correlationReason] : []),
    ],
    marginTop: {minPx: 0, maxPx: 0},
    marginBottom: {minPx: 0, maxPx: 0},
    conditional: children.some(child => child.conditional),
  }
}

function blockSize(children: Bound[]): Bound {
  if (children.some(child => child.marginTop.maxPx !== 0 || child.marginBottom.maxPx !== 0)) {
    return unknownBound('block margin collapsing is outside the static layout subset')
  }
  if (children.length === 0) return unknownBound('auto-sized block has intrinsic content height')
  return stackedSize(children)
}

function outerBound(bound: Bound): Bound {
  const minimumMarginsPx = bound.marginTop.minPx + bound.marginBottom.minPx
  const maximumMarginsPx = bound.marginTop.maxPx + bound.marginBottom.maxPx
  // Conditional class or JSX alternatives can put different margins on the same element.
  // The size choice has already merged, so which margin accompanies which size is lost;
  // an opaque margin range keeps the fold honest, and the witness keeps the smallest
  // reachable outer size rather than pairing a branch's witness with another's margin.
  const marginExpression = minimumMarginsPx === maximumMarginsPx
    ? layoutConstant(minimumMarginsPx)
    : layoutOpaque(
        {minimum: minimumMarginsPx, maximum: maximumMarginsPx},
        'conditional margins select with their branch',
      )
  return {
    ...bound,
    expression: layoutMaximum(layoutConstant(0), layoutAdd(bound.expression, marginExpression)),
    witnessMinimumPx: Math.max(0, bound.witnessMinimumPx + minimumMarginsPx),
    marginTop: {minPx: 0, maxPx: 0},
    marginBottom: {minPx: 0, maxPx: 0},
  }
}

function mergeAlternatives(alternatives: Bound[]): Bound {
  if (alternatives.length === 0) return unknownBound('element has no statically readable class/style alternative')
  const witness = alternatives.reduce((largest, alternative) =>
    alternative.witnessMinimumPx > largest.witnessMinimumPx ? alternative : largest, alternatives[0]!)
  return {
    expression: layoutChoice(...alternatives.map(alternative => alternative.expression)),
    witnessMinimumPx: witness.witnessMinimumPx,
    evidence: witness.evidence,
    unknownReasons: alternatives.flatMap(alternative => alternative.unknownReasons),
    marginTop: mergeMarginRanges(alternatives.map(alternative => alternative.marginTop)),
    marginBottom: mergeMarginRanges(alternatives.map(alternative => alternative.marginBottom)),
    conditional: alternatives.length > 1 || alternatives.some(alternative => alternative.conditional),
  }
}

function classFacts(
  classValue: string,
  complete: boolean,
  viewportWidths: number[],
  defaultLayout: BlockFacts['layout'],
): BlockFacts {
  const facts = defaultFacts(defaultLayout)
  if (!complete) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push('className is outside the supported static string subset')
  }
  const geometryOwners = new Map<string, string>()
  for (const rawToken of classValue.trim().split(/\s+/)) {
    if (rawToken === '') continue
    const split = splitClassVariants(rawToken)
    let effectiveToken = rawToken
    if (split.variants.length > 0) {
      const geometryProperties = classGeometryProperties(split.utility)
      if (geometryProperties.length === 0) continue
      switch (responsiveClassState(split.variants, viewportWidths)) {
        case 'active': effectiveToken = split.utility; break
        case 'inactive': continue
        case 'mixed':
          facts.lowerBoundReliable = false
          facts.unknownReasons.push(`responsive class '${rawToken}' differs across configured viewports`)
          continue
        case 'unsupported':
          facts.lowerBoundReliable = false
          facts.unknownReasons.push(`variant class '${rawToken}' depends on runtime CSS state`)
          continue
      }
    }
    for (const property of classGeometryProperties(effectiveToken)) {
      const previous = geometryOwners.get(property)
      if (previous != null && previous !== effectiveToken) {
        facts.lowerBoundReliable = false
        facts.unknownReasons.push(`classes '${previous}' and '${effectiveToken}' both set ${property}`)
      } else geometryOwners.set(property, effectiveToken)
      if (isImportantClass(effectiveToken)) facts.importantProperties.add(property)
    }
    applyClassToken(facts, effectiveToken)
  }
  return facts
}

function responsiveClassState(
  variants: string[],
  viewportWidths: number[],
): 'active' | 'inactive' | 'mixed' | 'unsupported' {
  if (variants.length !== 1) return 'unsupported'
  const boundary = responsiveBoundary(variants[0]!)
  if (boundary == null) return 'unsupported'
  const active = viewportWidths.map(width => boundary.side === 'minimum'
    ? width >= boundary.pixels
    : width < boundary.pixels)
  if (active.every(Boolean)) return 'active'
  if (active.every(value => !value)) return 'inactive'
  return 'mixed'
}

function responsiveBoundary(variant: string): {
  pixels: number
  side: 'minimum' | 'maximum'
} | null {
  const maximum = /^max-(sm|md|lg|xl|2xl)$/.exec(variant)
  if (maximum != null) return {pixels: defaultBreakpoint(maximum[1]!), side: 'maximum'}
  return /^(sm|md|lg|xl|2xl)$/.test(variant) ? {pixels: defaultBreakpoint(variant), side: 'minimum'} : null
}

function defaultBreakpoint(name: string): number {
  switch (name) {
    case 'sm': return 640
    case 'md': return 768
    case 'lg': return 1024
    case 'xl': return 1280
    case '2xl': return 1536
    default: throw new Error(`unsupported default breakpoint '${name}'`)
  }
}

function applyClassToken(facts: BlockFacts, rawToken: string): void {
  const {utility, variants} = splitClassVariants(rawToken)
  const token = stripImportant(utility)
  if (variants.length > 0) {
    if (isGeometryUtility(token)) facts.unknownReasons.push(`variant class '${rawToken}' depends on runtime CSS state`)
    return
  }
  switch (token) {
    case 'flex': facts.layout = 'flex-row'; return
    case 'inline-flex': facts.layout = 'flex-row'; return
    case 'flex-row': facts.layout = 'flex-row'; return
    case 'flex-col': facts.layout = 'flex-column'; return
    case 'block': facts.layout = 'block'; return
    case 'inline-block': facts.layout = 'block'; return
    case 'inline': facts.layout = 'inline'; return
    case 'hidden': facts.layout = 'none'; return
    case 'absolute':
    case 'fixed': facts.outOfFlow = true; return
    case 'relative':
    case 'sticky':
    case 'static': facts.outOfFlow = false; return
    case 'box-border': facts.boxSizing = 'border-box'; return
    case 'box-content': facts.boxSizing = 'content-box'; return
    case 'border': facts.borderTopPx = 1; facts.borderBottomPx = 1; return
    case 'border-y': facts.borderTopPx = 1; facts.borderBottomPx = 1; return
    case 'border-t': facts.borderTopPx = 1; return
    case 'border-b': facts.borderBottomPx = 1; return
    default: break
  }
  const height = utilityLength(token, 'h')
  if (height.matched) {
    if (height.value == null) {
      facts.lowerBoundReliable = false
      facts.unknownReasons.push(`class '${token}' has a relative or unsupported height`)
    }
    else facts.heightPx = height.value
    return
  }
  const minHeight = utilityLength(token, 'min-h')
  if (minHeight.matched) {
    if (minHeight.value == null) {
      facts.lowerBoundReliable = false
      facts.unknownReasons.push(`class '${token}' has an unsupported minimum height`)
    }
    else facts.minHeightPx = minHeight.value
    return
  }
  const maxHeight = utilityLength(token, 'max-h')
  if (maxHeight.matched) {
    if (maxHeight.value == null) {
      facts.lowerBoundReliable = false
      facts.unknownReasons.push(`class '${token}' has an unsupported maximum height`)
    }
    else facts.maxHeightPx = maxHeight.value
    return
  }
  if (applySpacingToken(facts, token)) return
  if (applyBorderToken(facts, token)) return
  if (token === 'flex-wrap' || token === 'flex-wrap-reverse') {
    facts.unknownReasons.push(`class '${token}' creates multiple flex lines`)
    return
  }
  if (isUnsupportedBlockUtility(token)) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push(`class '${token}' may affect block geometry outside the supported subset`)
  }
}

function applySpacingToken(facts: BlockFacts, token: string): boolean {
  let negative = false
  let utility = token
  if (utility.startsWith('-')) {
    negative = true
    utility = utility.slice(1)
  }
  const dash = utility.indexOf('-')
  if (dash <= 0) return false
  const root = utility.slice(0, dash)
  if (!['p', 'py', 'pt', 'pb', 'm', 'my', 'mt', 'mb'].includes(root)) return false
  const amount = tailwindLength(utility.slice(dash + 1))
  if (amount == null) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push(`class '${token}' has an unsupported block spacing amount`)
    return true
  }
  if (negative && (root === 'p' || root === 'py' || root === 'pt' || root === 'pb')) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push(`class '${token}' uses invalid negative padding`)
    return true
  }
  const value = negative ? -amount : amount
  if (value < 0 && (root === 'm' || root === 'my' || root === 'mt' || root === 'mb')) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push(`class '${token}' uses negative block margins outside the static layout subset`)
    return true
  }
  switch (root) {
    case 'p':
    case 'py': facts.paddingTopPx = value; facts.paddingBottomPx = value; break
    case 'pt': facts.paddingTopPx = value; break
    case 'pb': facts.paddingBottomPx = value; break
    case 'm':
    case 'my': facts.marginTopPx = value; facts.marginBottomPx = value; break
    case 'mt': facts.marginTopPx = value; break
    case 'mb': facts.marginBottomPx = value; break
    default: return false
  }
  return true
}

function applyBorderToken(facts: BlockFacts, token: string): boolean {
  const match = /^(border|border-y|border-t|border-b)-(0|2|4|8|\[(?:\d+(?:\.\d+)?)px\])$/.exec(token)
  if (match == null) return false
  const value = match[2]!.startsWith('[') ? Number(match[2]!.slice(1, -3)) : Number(match[2])
  switch (match[1]) {
    case 'border':
    case 'border-y': facts.borderTopPx = value; facts.borderBottomPx = value; break
    case 'border-t': facts.borderTopPx = value; break
    case 'border-b': facts.borderBottomPx = value; break
    default: return false
  }
  return true
}

function isGeometryUtility(token: string): boolean {
  const utility = stripImportant(token)
  return utility === 'hidden'
    || utility === 'block'
    || utility === 'inline-block'
    || utility === 'flex'
    || utility === 'inline-flex'
    || utility === 'flex-row'
    || utility === 'flex-col'
    || utility === 'grid'
    || utility === 'inline-grid'
    || utility === 'contents'
    || utility === 'absolute'
    || utility === 'fixed'
    || utility === 'relative'
    || utility === 'sticky'
    || utility === 'static'
    || utility === 'box-border'
    || utility === 'box-content'
    || utility.startsWith('h-')
    || utility.startsWith('min-h-')
    || utility.startsWith('max-h-')
    || utility.startsWith('size-')
    || utility.startsWith('aspect-')
    || /^(p|py|pt|pb|m|my|mt|mb)-/.test(utility)
    || isBorderWidthUtility(utility)
    || isUnsupportedBlockUtility(utility)
}

function isUnsupportedBlockUtility(token: string): boolean {
  return token === 'grid'
    || token === 'inline-grid'
    || token === 'contents'
    || token === 'inline'
    || token === 'flow-root'
    || token === 'list-item'
    || token === 'collapse'
    || token === 'sr-only'
    || token.startsWith('table-')
    || token.startsWith('size-')
    || token.startsWith('aspect-')
    || /^(?:gap|gap-y|space-y|divide-y|scale)(?:-|$)/.test(token)
    || /^border(?:-y|-t|-b)-\[/.test(token)
    || token.startsWith('[')
}

function stripImportant(token: string): string {
  const withoutPrefix = token.startsWith('!') ? token.slice(1) : token
  return withoutPrefix.endsWith('!') ? withoutPrefix.slice(0, -1) : withoutPrefix
}

function isImportantClass(rawToken: string): boolean {
  const utility = splitClassVariants(rawToken).utility
  return utility.startsWith('!') || utility.endsWith('!')
}

function classGeometryProperties(rawToken: string): string[] {
  const {utility, variants} = splitClassVariants(rawToken)
  if (variants.length > 0) return []
  const token = stripImportant(utility)
  switch (token) {
    case 'block':
    case 'inline-block':
    case 'inline':
    case 'flex':
    case 'inline-flex':
    case 'grid':
    case 'inline-grid':
    case 'contents':
    case 'hidden': return ['display']
    case 'flex-row':
    case 'flex-col': return ['flexDirection']
    case 'absolute':
    case 'fixed':
    case 'relative':
    case 'sticky':
    case 'static': return ['position']
    case 'box-border':
    case 'box-content': return ['boxSizing']
    default: break
  }
  if (token.startsWith('min-h-')) return ['minHeight']
  if (token.startsWith('max-h-')) return ['maxHeight']
  if (token.startsWith('h-') || token.startsWith('size-') || token.startsWith('aspect-')) return ['height']
  const spacing = /^-?(p|py|pt|pb|m|my|mt|mb)-/.exec(token)
  if (spacing != null) {
    switch (spacing[1]) {
      case 'p':
      case 'py': return ['paddingTop', 'paddingBottom']
      case 'pt': return ['paddingTop']
      case 'pb': return ['paddingBottom']
      case 'm':
      case 'my': return ['marginTop', 'marginBottom']
      case 'mt': return ['marginTop']
      case 'mb': return ['marginBottom']
      default: return []
    }
  }
  if (token === 'border' || token.startsWith('border-')) {
    if (token === 'border-t' || token.startsWith('border-t-')) return ['borderTopWidth']
    if (token === 'border-b' || token.startsWith('border-b-')) return ['borderBottomWidth']
    if (token === 'border-y' || token.startsWith('border-y-')) return ['borderTopWidth', 'borderBottomWidth']
    if (isBorderWidthUtility(token)) return ['borderTopWidth', 'borderBottomWidth']
  }
  return []
}

function splitClassVariants(token: string): {utility: string; variants: string[]} {
  let bracketDepth = 0
  let utilityStart = 0
  const variants: string[] = []
  for (let index = 0; index < token.length; index++) {
    const character = token[index]!
    if (character === '[') bracketDepth++
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    else if (character === ':' && bracketDepth === 0) {
      variants.push(token.slice(utilityStart, index))
      utilityStart = index + 1
    }
  }
  return {utility: token.slice(utilityStart), variants}
}

function isBorderWidthUtility(token: string): boolean {
  return /^(?:border|border-y|border-t|border-b)(?:-(?:0|2|4|8|\[(?:\d+(?:\.\d+)?)px\]))?$/.test(token)
}

function utilityLength(token: string, root: string): {matched: boolean; value: number | null} {
  if (!token.startsWith(`${root}-`)) return {matched: false, value: null}
  return {matched: true, value: tailwindLength(token.slice(root.length + 1))}
}

function tailwindLength(value: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const scaled = Number(value) * 4
    return Number.isFinite(scaled) ? scaled : null
  }
  const arbitrary = /^\[(\d+(?:\.\d+)?)px\]$/.exec(value)
  if (arbitrary == null) return null
  const parsed = Number(arbitrary[1])
  return Number.isFinite(parsed) ? parsed : null
}

function applyInlineStyle(
  facts: BlockFacts,
  style: StyleAlternative,
  complete: boolean,
  context: EvaluationContext,
): BlockFacts {
  if (!complete) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push('style is outside the supported static object subset')
  }
  for (const [property, expression] of style) {
    if (inlinePropertyIsOverriddenByImportantClass(property, facts.importantProperties)) continue
    switch (property) {
      case 'height': setLength(facts, 'heightPx', expression, context, property); break
      case 'minHeight': setLength(facts, 'minHeightPx', expression, context, property); break
      case 'maxHeight': setLength(facts, 'maxHeightPx', expression, context, property); break
      case 'paddingTop': setLength(facts, 'paddingTopPx', expression, context, property); break
      case 'paddingBottom': setLength(facts, 'paddingBottomPx', expression, context, property); break
      case 'marginTop': setLength(facts, 'marginTopPx', expression, context, property); break
      case 'marginBottom': setLength(facts, 'marginBottomPx', expression, context, property); break
      case 'borderTopWidth': setLength(facts, 'borderTopPx', expression, context, property); break
      case 'borderBottomWidth': setLength(facts, 'borderBottomPx', expression, context, property); break
      case 'position': {
        const value = exactString(expression, context, 0)
        if (value === 'absolute' || value === 'fixed') facts.outOfFlow = true
        else if (value === 'static' || value === 'relative' || value === 'sticky') facts.outOfFlow = false
        else {
          facts.lowerBoundReliable = false
          facts.unknownReasons.push(`inline ${property} is not statically supported`)
        }
        break
      }
      case 'display': {
        const value = exactString(expression, context, 0)
        if (value === 'none') facts.layout = 'none'
        else if (value === 'flex') facts.layout = 'flex-row'
        else if (value === 'block') facts.layout = 'block'
        else {
          facts.lowerBoundReliable = false
          facts.unknownReasons.push(`inline ${property} is not statically supported`)
        }
        break
      }
      case 'flexDirection': {
        const value = exactString(expression, context, 0)
        if (value === 'row') facts.layout = 'flex-row'
        else if (value === 'column') facts.layout = 'flex-column'
        else {
          facts.lowerBoundReliable = false
          facts.unknownReasons.push(`inline ${property} is not statically supported`)
        }
        break
      }
      case 'boxSizing': {
        const value = exactString(expression, context, 0)
        if (value === 'border-box' || value === 'content-box') facts.boxSizing = value
        else {
          facts.lowerBoundReliable = false
          facts.unknownReasons.push(`inline ${property} is not statically supported`)
        }
        break
      }
      case 'padding':
      case 'paddingBlock':
      case 'margin':
      case 'marginBlock':
      case 'borderWidth':
        facts.lowerBoundReliable = false
        facts.unknownReasons.push(`inline ${property} shorthand is outside the static layout subset`)
        break
      default: break
    }
  }
  return facts
}

function inlinePropertyIsOverriddenByImportantClass(property: string, important: Set<string>): boolean {
  if (important.has(property)) return true
  switch (property) {
    case 'padding':
    case 'paddingBlock': return important.has('paddingTop') && important.has('paddingBottom')
    case 'margin':
    case 'marginBlock': return important.has('marginTop') && important.has('marginBottom')
    case 'borderWidth': return important.has('borderTopWidth') && important.has('borderBottomWidth')
    default: return false
  }
}

type LengthField = 'heightPx' | 'minHeightPx' | 'maxHeightPx' | 'paddingTopPx' | 'paddingBottomPx'
  | 'marginTopPx' | 'marginBottomPx' | 'borderTopPx' | 'borderBottomPx'

function setLength(
  facts: BlockFacts,
  field: LengthField,
  expression: ts.Expression,
  context: EvaluationContext,
  property: string,
): void {
  const value = cssPixels(expression, context)
  const mayBeNegative = field === 'marginTopPx' || field === 'marginBottomPx'
  if (value == null || (!mayBeNegative && value < 0)) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push(`inline ${property} is not a valid finite pixel value`)
  } else if (mayBeNegative && value < 0) {
    facts.lowerBoundReliable = false
    facts.unknownReasons.push(`inline ${property} uses negative block margins outside the static layout subset`)
  } else facts[field] = value
}

function defaultFacts(layout: BlockFacts['layout']): BlockFacts {
  return {
    layout,
    outOfFlow: false,
    boxSizing: 'border-box',
    heightPx: null,
    minHeightPx: 0,
    maxHeightPx: null,
    paddingTopPx: 0,
    paddingBottomPx: 0,
    marginTopPx: 0,
    marginBottomPx: 0,
    borderTopPx: 0,
    borderBottomPx: 0,
    importantProperties: new Set(),
    lowerBoundReliable: true,
    unknownReasons: [],
  }
}

function intrinsicDefaultLayout(tagName: string): BlockFacts['layout'] {
  switch (tagName) {
    case 'a':
    case 'abbr':
    case 'b':
    case 'cite':
    case 'code':
    case 'em':
    case 'i':
    case 'label':
    case 'mark':
    case 'q':
    case 's':
    case 'small':
    case 'span':
    case 'strong':
    case 'sub':
    case 'sup':
    case 'time':
    case 'u': return 'inline'
    default: return 'block'
  }
}

function elementClassValues(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: EvaluationContext,
): {values: string[]; complete: boolean; alternativesProven: boolean} {
  const attribute = jsxAttribute(element, 'className') ?? jsxAttribute(element, 'class')
  if (attribute == null || attribute.initializer == null) {
    return {values: [''], complete: true, alternativesProven: true}
  }
  if (ts.isStringLiteral(attribute.initializer)) {
    return {values: [attribute.initializer.text], complete: true, alternativesProven: true}
  }
  if (!ts.isJsxExpression(attribute.initializer) || attribute.initializer.expression == null) {
    return {values: [''], complete: false, alternativesProven: false}
  }
  const values = stringAlternatives(attribute.initializer.expression, context, 0)
  return values == null
    ? {values: [''], complete: false, alternativesProven: false}
    : {
        values: unique(values),
        complete: true,
        alternativesProven: conditionalAlternativesProven(attribute.initializer.expression, context, 0),
      }
}

function stringAlternatives(expression: ts.Expression, context: EvaluationContext, depth: number): string[] | null {
  if (depth > maximumConstantDepth) return null
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text]
  if (ts.isParenthesizedExpression(expression)) return stringAlternatives(expression.expression, context, depth + 1)
  if (ts.isTemplateExpression(expression)) {
    let values = [expression.head.text]
    let uncertainSpans = 0
    for (const span of expression.templateSpans) {
      const inserted = stringAlternatives(span.expression, context, depth + 1)
      if (inserted == null) return null
      if (inserted.length > 1 && ++uncertainSpans > 1) return null
      values = crossStrings(values, inserted.map(value => value + span.literal.text))
      if (values.length > maximumAlternatives) return null
    }
    return values
  }
  if (ts.isConditionalExpression(expression)) {
    const possibilities = booleanPossibilities(expression.condition, context, depth + 1)
    if (possibilities != null && !possibilities.canBeFalse) {
      return stringAlternatives(expression.whenTrue, context, depth + 1)
    }
    if (possibilities != null && !possibilities.canBeTrue) {
      return stringAlternatives(expression.whenFalse, context, depth + 1)
    }
    const left = stringAlternatives(expression.whenTrue, context, depth + 1)
    const right = stringAlternatives(expression.whenFalse, context, depth + 1)
    return left == null || right == null ? null : cappedUnion(left, right)
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: {
        const left = stringAlternatives(expression.left, context, depth + 1)
        const right = stringAlternatives(expression.right, context, depth + 1)
        return left == null || right == null || (left.length > 1 && right.length > 1)
          ? null
          : crossStrings(left, right)
      }
      case ts.SyntaxKind.AmpersandAmpersandToken: {
        const possibilities = booleanPossibilities(expression.left, context, depth + 1)
        if (possibilities != null && !possibilities.canBeTrue) return ['']
        if (possibilities != null && !possibilities.canBeFalse) {
          return stringAlternatives(expression.right, context, depth + 1)
        }
        const right = stringAlternatives(expression.right, context, depth + 1)
        return right == null ? null : cappedUnion([''], right)
      }
      default: return null
    }
  }
  const resolved = immutableInitializer(expression, context)
  return resolved == null ? null : stringAlternatives(resolved.initializer, resolved.context, depth + 1)
}

function crossStrings(left: string[], right: string[]): string[] {
  const values: string[] = []
  for (const leftValue of left) {
    for (const rightValue of right) {
      values.push(leftValue + rightValue)
      if (values.length > maximumAlternatives) return values
    }
  }
  return values
}

function cappedUnion(left: string[], right: string[]): string[] | null {
  const values = unique([...left, ...right])
  return values.length > maximumAlternatives ? null : values
}

function elementStyleValues(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  context: EvaluationContext,
): {values: StyleAlternative[]; complete: boolean; alternativesProven: boolean} {
  const attribute = jsxAttribute(element, 'style')
  if (attribute == null || attribute.initializer == null) {
    return {values: [new Map()], complete: true, alternativesProven: true}
  }
  if (!ts.isJsxExpression(attribute.initializer) || attribute.initializer.expression == null) {
    return {values: [new Map()], complete: false, alternativesProven: false}
  }
  const values = styleAlternatives(attribute.initializer.expression, context, 0)
  return values == null
    ? {values: [new Map()], complete: false, alternativesProven: false}
    : {
        values: dedupeStyleAlternatives(values),
        complete: true,
        alternativesProven: conditionalAlternativesProven(attribute.initializer.expression, context, 0),
      }
}

function dedupeStyleAlternatives(alternatives: StyleAlternative[]): StyleAlternative[] {
  const seen = new Set<string>()
  const values: StyleAlternative[] = []
  for (const alternative of alternatives) {
    const key = [...alternative].map(([property, expression]) => `${property}:${expression.getText()}`).join(';')
    if (seen.has(key)) continue
    seen.add(key)
    values.push(alternative)
  }
  return values
}

function conditionalAlternativesProven(
  expression: ts.Expression,
  context: EvaluationContext,
  depth: number,
): boolean {
  if (depth > maximumConstantDepth) return false
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return conditionalAlternativesProven(peeled, context, depth + 1)
  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.every(span =>
      conditionalAlternativesProven(span.expression, context, depth + 1))
  }
  if (ts.isConditionalExpression(expression)) {
    return booleanPossibilities(expression.condition, context, depth + 1) != null
      && conditionalAlternativesProven(expression.whenTrue, context, depth + 1)
      && conditionalAlternativesProven(expression.whenFalse, context, depth + 1)
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return conditionalAlternativesProven(expression.left, context, depth + 1)
          && conditionalAlternativesProven(expression.right, context, depth + 1)
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken:
        return booleanPossibilities(expression.left, context, depth + 1) != null
          && conditionalAlternativesProven(expression.right, context, depth + 1)
      default: return true
    }
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every(property =>
      !ts.isSpreadAssignment(property)
      || conditionalAlternativesProven(property.expression, context, depth + 1))
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true
  const resolved = immutableInitializer(expression, context)
  return resolved != null
    && conditionalAlternativesProven(resolved.initializer, resolved.context, depth + 1)
}

function styleAlternatives(
  expression: ts.Expression,
  context: EvaluationContext,
  depth: number,
): StyleAlternative[] | null {
  if (depth > maximumConstantDepth) return null
  if (ts.isParenthesizedExpression(expression)) return styleAlternatives(expression.expression, context, depth + 1)
  if (ts.isConditionalExpression(expression)) {
    const possibilities = booleanPossibilities(expression.condition, context, depth + 1)
    if (possibilities != null && !possibilities.canBeFalse) {
      return styleAlternatives(expression.whenTrue, context, depth + 1)
    }
    if (possibilities != null && !possibilities.canBeTrue) {
      return styleAlternatives(expression.whenFalse, context, depth + 1)
    }
    const left = styleAlternatives(expression.whenTrue, context, depth + 1)
    const right = styleAlternatives(expression.whenFalse, context, depth + 1)
    if (left == null || right == null || left.length + right.length > maximumAlternatives) return null
    return [...left, ...right]
  }
  if (ts.isObjectLiteralExpression(expression)) {
    let alternatives: StyleAlternative[] = [new Map()]
    for (const property of expression.properties) {
      if (ts.isPropertyAssignment(property)
        && !ts.isComputedPropertyName(property.name)
        && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        const propertyName = property.name.text
        if (!isBlockStyleProperty(propertyName)) continue
        alternatives = alternatives.map(alternative => {
          const next = new Map(alternative)
          next.set(propertyName, property.initializer)
          return next
        })
        continue
      }
      if (ts.isSpreadAssignment(property)) {
        const spread = styleAlternatives(property.expression, context, depth + 1)
        if (spread == null || (alternatives.length > 1 && spread.length > 1)
          || alternatives.length * spread.length > maximumAlternatives) return null
        const merged: StyleAlternative[] = []
        for (const alternative of alternatives) {
          for (const spreadAlternative of spread) merged.push(new Map([...alternative, ...spreadAlternative]))
        }
        alternatives = merged
        continue
      }
      return null
    }
    return alternatives
  }
  const resolved = immutableInitializer(expression, context)
  return resolved == null ? null : styleAlternatives(resolved.initializer, resolved.context, depth + 1)
}

function isBlockStyleProperty(property: string): boolean {
  switch (property) {
    case 'height':
    case 'minHeight':
    case 'maxHeight':
    case 'paddingTop':
    case 'paddingBottom':
    case 'marginTop':
    case 'marginBottom':
    case 'borderTopWidth':
    case 'borderBottomWidth':
    case 'position':
    case 'display':
    case 'flexDirection':
    case 'boxSizing':
    case 'padding':
    case 'paddingBlock':
    case 'margin':
    case 'marginBlock':
    case 'borderWidth': return true
    default: return false
  }
}

function cssPixels(expression: ts.Expression, context: EvaluationContext): number | null {
  const number = exactNumber(expression, context, 0)
  if (number != null) return number
  const string = exactString(expression, context, 0)
  if (string == null) return null
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(string)
  if (match == null) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
}

function exactNumber(expression: ts.Expression, context: EvaluationContext, depth: number): number | null {
  if (depth > maximumConstantDepth) return null
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return exactNumber(peeled, context, depth + 1)
  // A literal like 1e999 folds to Infinity; non-finite pixels are outside the subset,
  // the same boundary the binary-operator arm below already enforces.
  if (ts.isNumericLiteral(expression)) {
    const parsed = Number(expression.text)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (ts.isParenthesizedExpression(expression)) return exactNumber(expression.expression, context, depth + 1)
  if (ts.isPrefixUnaryExpression(expression)
    && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)) {
    const operand = exactNumber(expression.operand, context, depth + 1)
    if (operand == null) return null
    return expression.operator === ts.SyntaxKind.MinusToken ? -operand : operand
  }
  if (ts.isBinaryExpression(expression)) {
    const left = exactNumber(expression.left, context, depth + 1)
    const right = exactNumber(expression.right, context, depth + 1)
    if (left == null || right == null) return null
    let value: number
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: value = left + right; break
      case ts.SyntaxKind.MinusToken: value = left - right; break
      case ts.SyntaxKind.AsteriskToken: value = left * right; break
      case ts.SyntaxKind.SlashToken: value = left / right; break
      default: return null
    }
    return Number.isFinite(value) ? value : null
  }
  const resolved = immutableInitializer(expression, context)
  return resolved == null ? null : exactNumber(resolved.initializer, resolved.context, depth + 1)
}

function exactString(expression: ts.Expression, context: EvaluationContext, depth: number): string | null {
  if (depth > maximumConstantDepth) return null
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return exactString(peeled, context, depth + 1)
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
  if (ts.isParenthesizedExpression(expression)) return exactString(expression.expression, context, depth + 1)
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text
    for (const span of expression.templateSpans) {
      const inserted = exactNumber(span.expression, context, depth + 1) ?? exactString(span.expression, context, depth + 1)
      if (inserted == null) return null
      value += String(inserted) + span.literal.text
    }
    return value
  }
  const resolved = immutableInitializer(expression, context)
  return resolved == null ? null : exactString(resolved.initializer, resolved.context, depth + 1)
}

function exactBoolean(expression: ts.Expression, context: EvaluationContext, depth: number): boolean | null {
  if (depth > maximumConstantDepth) return null
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return exactBoolean(peeled, context, depth + 1)
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false
  if (ts.isParenthesizedExpression(expression)) return exactBoolean(expression.expression, context, depth + 1)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = exactBoolean(expression.operand, context, depth + 1)
    return operand == null ? null : !operand
  }
  if (ts.isBinaryExpression(expression)) {
    const left = exactPrimitive(expression.left, context, depth + 1)
    const right = exactPrimitive(expression.right, context, depth + 1)
    if (left == null || right == null) return null
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken: return left.value === right.value
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left.value !== right.value
      case ts.SyntaxKind.LessThanToken: return left.value < right.value
      case ts.SyntaxKind.LessThanEqualsToken: return left.value <= right.value
      case ts.SyntaxKind.GreaterThanToken: return left.value > right.value
      case ts.SyntaxKind.GreaterThanEqualsToken: return left.value >= right.value
      default: return null
    }
  }
  const property = propertyInitializer(expression, context)
  if (property != null) return exactBoolean(property.initializer, property.context, depth + 1)
  const resolved = immutableInitializer(expression, context)
  return resolved == null ? null : exactBoolean(resolved.initializer, resolved.context, depth + 1)
}

type BooleanPossibilities = {canBeTrue: boolean; canBeFalse: boolean}

function booleanPossibilities(
  expression: ts.Expression,
  context: EvaluationContext,
  depth: number,
): BooleanPossibilities | null {
  if (depth > maximumConstantDepth) return null
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return booleanPossibilities(peeled, context, depth + 1)
  const exact = exactBoolean(expression, context, depth + 1)
  if (exact != null) return exact ? {canBeTrue: true, canBeFalse: false} : {canBeTrue: false, canBeFalse: true}
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = booleanPossibilities(expression.operand, context, depth + 1)
    return operand == null ? null : {canBeTrue: operand.canBeFalse, canBeFalse: operand.canBeTrue}
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken: {
        if (booleanExpressionsMayShareDependency(expression.left, expression.right, context, depth + 1)) return null
        const left = booleanPossibilities(expression.left, context, depth + 1)
        const right = booleanPossibilities(expression.right, context, depth + 1)
        if (left == null || right == null) return null
        return {
          canBeTrue: left.canBeTrue && right.canBeTrue,
          canBeFalse: left.canBeFalse || (left.canBeTrue && right.canBeFalse),
        }
      }
      case ts.SyntaxKind.BarBarToken: {
        if (booleanExpressionsMayShareDependency(expression.left, expression.right, context, depth + 1)) return null
        const left = booleanPossibilities(expression.left, context, depth + 1)
        const right = booleanPossibilities(expression.right, context, depth + 1)
        if (left == null || right == null) return null
        return {
          canBeTrue: left.canBeTrue || (left.canBeFalse && right.canBeTrue),
          canBeFalse: left.canBeFalse && right.canBeFalse,
        }
      }
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: {
        const left = literalDomain(expression.left, context.checker)
        const right = literalDomain(expression.right, context.checker)
        if (left == null || right == null) return null
        let canEqual = false
        let canDiffer = false
        for (const leftValue of left) {
          for (const rightValue of right) {
            if (leftValue === rightValue) canEqual = true
            else canDiffer = true
          }
        }
        return expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
          ? {canBeTrue: canEqual, canBeFalse: canDiffer}
          : {canBeTrue: canDiffer, canBeFalse: canEqual}
      }
      default: return null
    }
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = booleanPossibilities(expression.condition, context, depth + 1)
    if (condition == null) return null
    const whenTrue = condition.canBeTrue
      ? booleanPossibilities(expression.whenTrue, context, depth + 1)
      : {canBeTrue: false, canBeFalse: false}
    const whenFalse = condition.canBeFalse
      ? booleanPossibilities(expression.whenFalse, context, depth + 1)
      : {canBeTrue: false, canBeFalse: false}
    if (whenTrue == null || whenFalse == null) return null
    return {
      canBeTrue: whenTrue.canBeTrue || whenFalse.canBeTrue,
      canBeFalse: whenTrue.canBeFalse || whenFalse.canBeFalse,
    }
  }
  const property = propertyInitializer(expression, context)
  if (property != null) return booleanPossibilities(property.initializer, property.context, depth + 1)
  const resolved = immutableInitializer(expression, context)
  if (resolved != null) {
    const possibilities = booleanPossibilities(resolved.initializer, resolved.context, depth + 1)
    return possibilities != null && possibilities.canBeTrue !== possibilities.canBeFalse ? possibilities : null
  }
  if ((ts.isIdentifier(expression) && identifierIsInput(expression, context.checker))
    || (ts.isPropertyAccessExpression(expression) && propertyRootIsInput(expression, context.checker))) {
    const domain = literalDomain(expression, context.checker)
    if (domain == null || !domain.every(value => typeof value === 'boolean')) return null
    return {
      canBeTrue: domain.includes(true),
      canBeFalse: domain.includes(false),
    }
  }
  return null
}

function booleanBranchProven(
  expression: ts.Expression,
  value: boolean,
  context: EvaluationContext,
  depth: number,
): boolean {
  if (depth > maximumConstantDepth) return false
  const possibilities = booleanPossibilities(expression, context, depth + 1)
  if (possibilities != null) return value ? possibilities.canBeTrue : possibilities.canBeFalse
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return booleanBranchProven(peeled, value, context, depth + 1)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return booleanBranchProven(expression.operand, !value, context, depth + 1)
  }
  if (ts.isBinaryExpression(expression)) {
    switch (expression.operatorToken.kind) {
      case ts.SyntaxKind.AmpersandAmpersandToken: return value
        ? !booleanExpressionsMayShareDependency(expression.left, expression.right, context, depth + 1)
          && booleanBranchProven(expression.left, true, context, depth + 1)
          && booleanBranchProven(expression.right, true, context, depth + 1)
        : booleanBranchProven(expression.left, false, context, depth + 1)
          || booleanBranchProven(expression.right, false, context, depth + 1)
      case ts.SyntaxKind.BarBarToken: return value
        ? booleanBranchProven(expression.left, true, context, depth + 1)
          || booleanBranchProven(expression.right, true, context, depth + 1)
        : !booleanExpressionsMayShareDependency(expression.left, expression.right, context, depth + 1)
          && booleanBranchProven(expression.left, false, context, depth + 1)
          && booleanBranchProven(expression.right, false, context, depth + 1)
      default: return false
    }
  }
  return false
}

function booleanExpressionsMayShareDependency(
  left: ts.Expression,
  right: ts.Expression,
  context: EvaluationContext,
  depth: number,
): boolean {
  const leftDependencies = booleanDependencies(left, context, depth + 1)
  const rightDependencies = booleanDependencies(right, context, depth + 1)
  if (leftDependencies == null || rightDependencies == null) return true
  for (const dependency of leftDependencies) {
    if (rightDependencies.has(dependency)) return true
  }
  return false
}

function booleanDependencies(
  expression: ts.Expression,
  context: EvaluationContext,
  depth: number,
): Set<ts.Symbol> | null {
  if (depth > maximumConstantDepth) return null
  const peeled = peelTransparentExpression(expression)
  if (peeled !== expression) return booleanDependencies(peeled, context, depth + 1)
  if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword) return new Set()
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    return booleanDependencies(expression.operand, context, depth + 1)
  }
  if (ts.isBinaryExpression(expression)) {
    const left = booleanDependencies(expression.left, context, depth + 1)
    const right = booleanDependencies(expression.right, context, depth + 1)
    return left == null || right == null ? null : new Set([...left, ...right])
  }
  if (ts.isConditionalExpression(expression)) {
    const condition = booleanDependencies(expression.condition, context, depth + 1)
    const whenTrue = booleanDependencies(expression.whenTrue, context, depth + 1)
    const whenFalse = booleanDependencies(expression.whenFalse, context, depth + 1)
    return condition == null || whenTrue == null || whenFalse == null
      ? null
      : new Set([...condition, ...whenTrue, ...whenFalse])
  }
  if (ts.isIdentifier(expression) && identifierIsInput(expression, context.checker)) {
    const symbol = context.checker.getSymbolAtLocation(expression)
    return symbol == null ? null : new Set([symbol])
  }
  if (ts.isPropertyAccessExpression(expression) && propertyRootIsInput(expression, context.checker)) {
    let root: ts.Expression = expression.expression
    while (ts.isPropertyAccessExpression(root)) root = root.expression
    if (!ts.isIdentifier(root)) return null
    const symbol = context.checker.getSymbolAtLocation(root)
    return symbol == null ? null : new Set([symbol])
  }
  const property = propertyInitializer(expression, context)
  if (property != null) return booleanDependencies(property.initializer, property.context, depth + 1)
  const resolved = immutableInitializer(expression, context)
  return resolved == null ? null : booleanDependencies(resolved.initializer, resolved.context, depth + 1)
}

function literalDomain(expression: ts.Expression, checker: ts.TypeChecker): Array<string | number | boolean> | null {
  // The checker's answer at an assertion node is the asserted type — exactly where its
  // word and the runtime value may diverge. Query the operand instead, so the domain
  // always comes from a declared or flow-narrowed type.
  for (let peeled = peelTransparentExpression(expression); peeled !== expression; peeled = peelTransparentExpression(expression)) {
    expression = peeled
  }
  const type = checker.getTypeAtLocation(expression)
  const members = type.isUnion() ? type.types : [type]
  const values: Array<string | number | boolean> = []
  for (const member of members) {
    if ((member.flags & ts.TypeFlags.StringLiteral) !== 0) values.push((member as ts.StringLiteralType).value)
    else if ((member.flags & ts.TypeFlags.NumberLiteral) !== 0) values.push((member as ts.NumberLiteralType).value)
    else if ((member.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      values.push(checker.typeToString(member) === 'true')
    } else if ((member.flags & ts.TypeFlags.Boolean) !== 0) values.push(true, false)
    else return null
    if (values.length > maximumAlternatives) return null
  }
  return unique(values)
}

function identifierIsInput(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const declaration = checker.getSymbolAtLocation(identifier)?.valueDeclaration
  if (declaration == null) return false
  let node: ts.Node = declaration
  while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    node = node.parent
  }
  return ts.isParameter(node)
}

function propertyRootIsInput(expression: ts.PropertyAccessExpression, checker: ts.TypeChecker): boolean {
  let root: ts.Expression = expression.expression
  while (ts.isPropertyAccessExpression(root)) root = root.expression
  return ts.isIdentifier(root) && identifierIsInput(root, checker)
}

function propertyInitializer(
  expression: ts.Expression,
  context: EvaluationContext,
): {initializer: ts.Expression; context: EvaluationContext} | null {
  if (!ts.isPropertyAccessExpression(expression)) return null
  const resolvedObject = immutableInitializer(expression.expression, context)
  if (resolvedObject == null) return null
  const object = peelTransparentExpression(resolvedObject.initializer)
  if (!ts.isObjectLiteralExpression(object)) return null
  for (let index = object.properties.length - 1; index >= 0; index--) {
    const property = object.properties[index]!
    if (ts.isPropertyAssignment(property)
      && !ts.isComputedPropertyName(property.name)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      && property.name.text === expression.name.text) {
      return {initializer: property.initializer, context: resolvedObject.context}
    }
    if (ts.isSpreadAssignment(property)) return null
  }
  return null
}

function peelTransparentExpression(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)) return expression.expression
  return expression
}

function exactPrimitive(
  expression: ts.Expression,
  context: EvaluationContext,
  depth: number,
): {value: number | string} | null {
  const number = exactNumber(expression, context, depth)
  if (number != null) return {value: number}
  const string = exactString(expression, context, depth)
  return string == null ? null : {value: string}
}

function immutableInitializer(
  expression: ts.Expression,
  context: EvaluationContext,
): {initializer: ts.Expression; context: EvaluationContext} | null {
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return null
  let symbol = context.checker.getSymbolAtLocation(expression)
  if (symbol == null) return null
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = context.checker.getAliasedSymbol(symbol)
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
  if (declaration == null || context.constantStack.has(declaration)) return null
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer == null) return null
  const declarationList = declaration.parent
  if (!ts.isVariableDeclarationList(declarationList)
    || (declarationList.flags & ts.NodeFlags.Const) === 0) return null
  if (!constInitializerIsStable(expression, declaration, declaration.initializer, context.checker)) return null
  return {
    initializer: declaration.initializer,
    context: {...context, constantStack: new Set([...context.constantStack, declaration])},
  }
}

function constInitializerIsStable(
  expression: ts.Expression,
  declaration: ts.VariableDeclaration,
  declarationInitializer: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const initializer = peelTransparentExpression(declarationInitializer)
  if (!ts.isObjectLiteralExpression(initializer) && !ts.isArrayLiteralExpression(initializer)) return true
  if (!ts.isIdentifier(expression) || expression.getSourceFile() !== declaration.getSourceFile()) return false
  let references = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node)
      if (symbol != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
      if ((symbol?.valueDeclaration ?? symbol?.declarations?.[0]) === declaration) references++
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration.getSourceFile())
  return references === 2
}

function jsxAttribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): ts.JsxAttribute | null {
  for (let index = element.attributes.properties.length - 1; index >= 0; index--) {
    const attribute = element.attributes.properties[index]!
    if (ts.isJsxAttribute(attribute) && ts.isIdentifier(attribute.name) && attribute.name.text === name) return attribute
    if (ts.isJsxSpreadAttribute(attribute)) return null
  }
  return null
}

function jsxLiteralAttribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string,
): string | null {
  const attribute = jsxAttribute(element, name)
  if (attribute?.initializer == null) return null
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text
  if (ts.isJsxExpression(attribute.initializer)
    && attribute.initializer.expression != null
    && (ts.isStringLiteral(attribute.initializer.expression)
      || ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))) {
    return attribute.initializer.expression.text
  }
  return null
}

// Constant inputs fold exactly through the expression constructors, so the witness
// number derives from the same expression the proof uses; one encoding of the box
// clamping cannot drift from the other.
function autoOuterHeight(contentPx: number, chromePx: number, facts: BlockFacts): number {
  return sourceRange(autoOuterExpression(layoutConstant(contentPx), chromePx, facts)).minimumPx
}

function autoOuterExpression(
  content: LayoutExpression,
  chromePx: number,
  facts: BlockFacts,
): LayoutExpression {
  const chrome = layoutConstant(chromePx)
  return facts.boxSizing === 'border-box'
    ? layoutMaximum(chrome, clampSpecifiedExpression(layoutAdd(content, chrome), facts))
    : layoutAdd(clampSpecifiedExpression(content, facts), chrome)
}

function clampSpecifiedExpression(value: LayoutExpression, facts: BlockFacts): LayoutExpression {
  const capped = facts.maxHeightPx == null
    ? value
    : layoutMinimum(value, layoutConstant(facts.maxHeightPx))
  return layoutMaximum(capped, layoutConstant(facts.minHeightPx))
}


function evidence(element: ts.Node, description: string, context: EvaluationContext): StaticLayoutEvidence {
  const sourceFile = element.getSourceFile()
  const {line, character} = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
  return {
    file: relative(context.configDirectory, sourceFile.fileName),
    line: line + 1,
    column: character + 1,
    description,
  }
}

function zeroBound(): Bound {
  return {
    expression: layoutConstant(0),
    witnessMinimumPx: 0,
    evidence: [],
    unknownReasons: [],
    marginTop: {minPx: 0, maxPx: 0},
    marginBottom: {minPx: 0, maxPx: 0},
    conditional: false,
  }
}

function unknownBound(reason: string | string[]): Bound {
  const reasons = typeof reason === 'string' ? [reason] : reason
  return {
    expression: opaqueSourceExpression({minimum: 0, maximum: null}, reasons),
    witnessMinimumPx: 0,
    evidence: [],
    unknownReasons: reasons,
    marginTop: {minPx: 0, maxPx: 0},
    marginBottom: {minPx: 0, maxPx: 0},
    conditional: true,
  }
}

function sourceRange(expression: LayoutExpression): {minimumPx: number; maximumPx: number | null} {
  const range = layoutExpressionRange(expression)
  return {minimumPx: range.minimum ?? 0, maximumPx: range.maximum}
}

function opaqueSourceExpression(
  range: LayoutExpressionRange,
  reasons: string[],
): LayoutExpression {
  const uniqueReasons = unique(reasons)
  return layoutOpaque(
    range,
    uniqueReasons.length === 0
      ? 'source block size is outside the supported subset'
      : uniqueReasons as [string, ...string[]],
  )
}

function unknownCheck(
  constraint: StaticLayoutConstraint,
  target: StaticLayoutTarget,
  reason: StaticLayoutUnknownReason,
  minimumPx: number | null = null,
  maximumPx: number | null = null,
): StaticLayoutCheck {
  return {
    kind: 'unknown',
    constraint: constraint.name,
    target: target.name,
    minimumPx,
    maximumPx,
    reason,
  }
}

function isIntrinsicTag(name: string): boolean {
  const first = name.charAt(0)
  return first !== '' && first === first.toLowerCase()
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function shortText(text: string): string {
  return text.length <= 60 ? text : text.slice(0, 57) + '...'
}

function pixels(value: number): string {
  return `${Number(value.toFixed(3))}px`
}
