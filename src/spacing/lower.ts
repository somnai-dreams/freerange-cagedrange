import * as ts from 'typescript'
import {
  classAttributePositionCases,
  classAttributeSummary,
  emptyClassSummary,
} from './class-expression.ts'
import type {
  ClassPositionCases,
  ClassSummary,
  LoweredSpacingElement,
  OffsetProperty,
  PositionStatus,
  RuntimeCases,
  SpacingAmount,
  SpacingCoverageReason,
  SpacingDeclaration,
  SpacingValueKind,
} from './model.ts'
import {alwaysRuntimeCases, inlineValuePresence} from './runtime-condition.ts'

export function lowerSpacingElements(sourceFile: ts.SourceFile): LoweredSpacingElement[] {
  const elements: LoweredSpacingElement[] = []
  const globalUndefined = !sourceFileHasUndefinedBinding(sourceFile)
  const runtimeStability = sourceFileRuntimeStability(sourceFile)
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName)
      && isIntrinsicTagName(node.tagName.text)) {
      elements.push(lowerElement(node, sourceFile, globalUndefined, runtimeStability))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return elements
}

function lowerElement(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
  globalUndefined: boolean,
  runtimeStability: RuntimeStability,
): LoweredSpacingElement {
  let classes = emptyClassSummary()
  let classPositionCases: ClassPositionCases = {
    kind: 'known',
    cases: [{guard: [], positioned: false}],
  }
  let inlineDeclarations: SpacingDeclaration[] = []
  let inlinePosition: PositionStatus | 'computed' | null = null
  let stylePositionComplete = true
  let classMayComeFromSpread = false
  let styleMayComeFromSpread = false
  const coverageReasons: SpacingCoverageReason[] = []

  for (const attribute of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      classMayComeFromSpread = true
      styleMayComeFromSpread = true
      continue
    }
    if (!ts.isIdentifier(attribute.name)) continue
    switch (attribute.name.text) {
      case 'class':
      case 'className': {
        classes = classAttributeSummary(attribute)
        classPositionCases = classAttributePositionCases(attribute)
        classMayComeFromSpread = false
        if (classes.coverage === 'partial') {
          coverageReasons.push({
            kind: classes.possibleClasses.length === 0 ? 'computedClassName' : 'partialClassName',
          })
        }
        break
      }
      case 'style': {
        const style = lowerStyleAttribute(attribute, sourceFile, globalUndefined)
        inlineDeclarations = style.declarations
        inlinePosition = style.position
        stylePositionComplete = style.positionComplete
        styleMayComeFromSpread = false
        coverageReasons.push(...style.coverageReasons)
        break
      }
      default: break
    }
  }

  if (classMayComeFromSpread || styleMayComeFromSpread) {
    coverageReasons.push({kind: 'spreadAttributes'})
    if (classMayComeFromSpread) {
      classes = markClassSummaryPartial(classes)
      classPositionCases = {kind: 'unknown'}
    }
    if (styleMayComeFromSpread) stylePositionComplete = false
  }

  const requiredRuntimeRoots = positionCorrelationRoots(classPositionCases, inlineDeclarations)
  const stableRuntimeRoots = stableRuntimeRootsAt(
    element,
    sourceFile,
    runtimeStability,
    requiredRuntimeRoots,
  )
  if (!positionCorrelationUsesStableRoots(classPositionCases, inlineDeclarations, stableRuntimeRoots)) {
    classPositionCases = {kind: 'unknown'}
  }

  const {line, character} = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
  return {
    line: line + 1,
    column: character + 1,
    classes,
    classPositionCases,
    inlineDeclarations,
    inlinePosition,
    stylePositionComplete,
    coverageReasons,
  }
}

function isIntrinsicTagName(tagName: string): boolean {
  const first = tagName.charAt(0)
  return first !== '' && first === first.toLowerCase()
}

function markClassSummaryPartial(summary: ClassSummary): ClassSummary {
  return summary.coverage === 'partial' ? summary : {...summary, coverage: 'partial'}
}

type LoweredStyle = {
  declarations: SpacingDeclaration[]
  position: PositionStatus | 'computed' | null
  positionComplete: boolean
  coverageReasons: SpacingCoverageReason[]
}

function lowerStyleAttribute(
  attribute: ts.JsxAttribute,
  sourceFile: ts.SourceFile,
  globalUndefined: boolean,
): LoweredStyle {
  const initializer = attribute.initializer
  if (initializer == null
    || !ts.isJsxExpression(initializer)
    || initializer.expression == null
    || !ts.isObjectLiteralExpression(initializer.expression)) {
    return {
      declarations: [],
      position: null,
      positionComplete: false,
      coverageReasons: [{kind: 'computedStyle'}],
    }
  }

  const declarations: SpacingDeclaration[] = []
  const coverageReasons: SpacingCoverageReason[] = []
  const propertyCoverageReasons: {propertyName: string; reason: SpacingCoverageReason}[] = []
  let position: PositionStatus | 'computed' | null = null
  let positionComplete = true
  for (const member of initializer.expression.properties) {
    if (!ts.isPropertyAssignment(member) && !ts.isShorthandPropertyAssignment(member)) {
      coverageReasons.push({kind: 'opaqueStyleMember'})
      positionComplete = false
      continue
    }
    if (ts.isComputedPropertyName(member.name)) {
      coverageReasons.push({kind: 'opaqueStyleMember'})
      positionComplete = false
      continue
    }
    if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) continue
    const propertyName = member.name.text
    removeEarlierDeclaration(declarations, propertyName)
    removeEarlierPropertyCoverage(propertyCoverageReasons, propertyName)
    if (propertyName === 'position') {
      position = positionValue(member)
      positionComplete = position !== 'computed'
      if (position === 'computed') {
        propertyCoverageReasons.push({propertyName, reason: {kind: 'computedPosition'}})
      }
      continue
    }

    const declaration = inlineDeclaration(member, propertyName, sourceFile, globalUndefined)
    if (declaration != null) {
      declarations.push(declaration)
      if (declaration.kind === 'offset' && declaration.presence.kind === 'unknown') {
        propertyCoverageReasons.push({propertyName, reason: {kind: 'computedOffsetPresence'}})
      }
    }
  }
  return {
    declarations,
    position,
    positionComplete,
    coverageReasons: [...coverageReasons, ...propertyCoverageReasons.map(entry => entry.reason)],
  }
}

function positionValue(
  member: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
): PositionStatus | 'computed' {
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
    default: return 'computed'
  }
}

function inlineDeclaration(
  member: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  propertyName: string,
  sourceFile: ts.SourceFile,
  globalUndefined: boolean,
): SpacingDeclaration | null {
  const offsetProperties = inlineOffsetProperties(propertyName)
  if (offsetProperties != null) {
    const presence = ts.isPropertyAssignment(member)
      ? inlineValuePresence(member.initializer, globalUndefined)
      : alwaysRuntimeCases()
    if (presence.kind === 'known' && presence.alternatives.length === 0) return null
    return {
      kind: 'offset',
      properties: offsetProperties,
      source: {kind: 'inline', property: propertyName},
      target: 'self',
      condition: 'always',
      presence,
    }
  }
  const valueProperty = inlineValueProperty(propertyName)
  if (valueProperty == null) return null
  const amount = ts.isPropertyAssignment(member)
    ? inlineAmount(member.initializer, sourceFile)
    : {form: 'named' as const, name: propertyName}
  if (amount == null) return null
  return {
    ...valueProperty,
    amount,
    source: {kind: 'inline', property: propertyName},
    target: 'self',
    condition: 'always',
  }
}

function inlineOffsetProperties(name: string): OffsetProperty[] | null {
  switch (name) {
    case 'top':
    case 'bottom':
    case 'left':
    case 'right': return [name]
    case 'inset': return ['top', 'bottom', 'left', 'right']
    case 'insetBlock': return ['blockStart', 'blockEnd']
    case 'insetBlockStart': return ['blockStart']
    case 'insetBlockEnd': return ['blockEnd']
    case 'insetInline': return ['inlineStart', 'inlineEnd']
    case 'insetInlineStart': return ['inlineStart']
    case 'insetInlineEnd': return ['inlineEnd']
    default: return null
  }
}

function inlineValueProperty(
  name: string,
): {axis: 'vertical' | 'horizontal' | 'both'; kind: SpacingValueKind} | null {
  switch (name) {
    case 'marginTop':
    case 'marginBottom':
    case 'marginBlock':
    case 'marginBlockStart':
    case 'marginBlockEnd': return {axis: 'vertical', kind: 'margin'}
    case 'marginLeft':
    case 'marginRight':
    case 'marginInline':
    case 'marginInlineStart':
    case 'marginInlineEnd': return {axis: 'horizontal', kind: 'margin'}
    case 'margin': return {axis: 'both', kind: 'margin'}
    case 'paddingTop':
    case 'paddingBottom':
    case 'paddingBlock':
    case 'paddingBlockStart':
    case 'paddingBlockEnd': return {axis: 'vertical', kind: 'padding'}
    case 'paddingLeft':
    case 'paddingRight':
    case 'paddingInline':
    case 'paddingInlineStart':
    case 'paddingInlineEnd': return {axis: 'horizontal', kind: 'padding'}
    case 'padding': return {axis: 'both', kind: 'padding'}
    case 'gap': return {axis: 'both', kind: 'gap'}
    case 'rowGap': return {axis: 'vertical', kind: 'gap'}
    case 'columnGap': return {axis: 'horizontal', kind: 'gap'}
    default: return null
  }
}

// React treats numeric margin, padding, and gap values as pixels. Strings retain their
// written unit so the report can state the assumptions needed to compare them.
function inlineAmount(value: ts.Expression, sourceFile: ts.SourceFile): SpacingAmount | null {
  if (ts.isNumericLiteral(value)) return {form: 'length', value: Number(value.text), unit: 'px'}
  if (ts.isPrefixUnaryExpression(value)
    && (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken)
    && ts.isNumericLiteral(value.operand)) {
    const sign = value.operator === ts.SyntaxKind.MinusToken ? -1 : 1
    return {form: 'length', value: sign * Number(value.operand.text), unit: 'px'}
  }
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
    if (value.text === 'auto') return null
    const pxMatch = /^(-?\d+(\.\d+)?)px$/.exec(value.text)
    if (pxMatch != null) return {form: 'length', value: Number(pxMatch[1]), unit: 'px'}
    const remMatch = /^(-?\d+(\.\d+)?)rem$/.exec(value.text)
    if (remMatch != null) return {form: 'length', value: Number(remMatch[1]), unit: 'rem'}
    return {form: 'keyword', text: value.text}
  }
  if (ts.isIdentifier(value)) return {form: 'named', name: value.text}
  if (ts.isPropertyAccessExpression(value)) return {form: 'named', name: value.getText(sourceFile)}
  return {form: 'computed'}
}

function sourceFileHasUndefinedBinding(sourceFile: ts.SourceFile): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    const name = valueBindingName(node)
    if (name != null && bindingNameContains(name, 'undefined')) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function valueBindingName(node: ts.Node): ts.BindingName | ts.Identifier | null {
  if (ts.isVariableDeclaration(node)
    || ts.isParameter(node)
    || ts.isBindingElement(node)) return node.name
  if (ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node)
    || ts.isEnumDeclaration(node)
    || ts.isImportEqualsDeclaration(node)) return node.name ?? null
  if (ts.isModuleDeclaration(node)) return ts.isIdentifier(node.name) ? node.name : null
  if (ts.isImportClause(node)) return node.name ?? null
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) return node.name
  return null
}

function bindingNameContains(name: ts.BindingName | ts.Identifier, expected: string): boolean {
  if (ts.isIdentifier(name)) return name.text === expected
  return name.elements.some(element =>
    !ts.isOmittedExpression(element) && bindingNameContains(element.name, expected))
}

type RuntimeBinding = {
  scope: ts.Node
  declaration: ts.Node
  eligible: boolean
}

type RuntimeStability = {
  bindingsByName: Map<string, RuntimeBinding[]>
  written: Set<string>
  hasEval: boolean
}

function sourceFileRuntimeStability(sourceFile: ts.SourceFile): RuntimeStability {
  const bindingsByName = new Map<string, RuntimeBinding[]>()
  const written = new Set<string>()
  let hasEval = false
  const visit = (node: ts.Node, scopes: ts.Node[], ambient: boolean): void => {
    const nestedScopes = node !== sourceFile && isRuntimeScope(node) ? [node, ...scopes] : scopes
    const nodeIsAmbient = ambient || hasDeclareModifier(node)
    const name = runtimeBindingName(node)
    if (name != null) {
      const eligible = !isImportBinding(node) && !nodeIsAmbient
      addRuntimeBindings(name, nestedScopes[0]!, node, eligible, bindingsByName)
    }
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      addAssignedNames(node.left, written)
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      addAssignedNames(node.operand, written)
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && ts.isExpression(node.initializer)) {
      addAssignedNames(node.initializer, written)
    }
    if (ts.isIdentifier(node) && node.text === 'eval') hasEval = true
    ts.forEachChild(node, child => visit(child, nestedScopes, nodeIsAmbient))
  }
  visit(sourceFile, [sourceFile], sourceFile.isDeclarationFile)
  return {bindingsByName, written, hasEval}
}

function runtimeBindingName(node: ts.Node): ts.BindingName | ts.Identifier | null {
  if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return node.name
  if (ts.isImportClause(node)) return node.name ?? null
  if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node)) {
    return node.name
  }
  return null
}

function isImportBinding(node: ts.Node): boolean {
  return ts.isImportClause(node)
    || ts.isImportSpecifier(node)
    || ts.isNamespaceImport(node)
    || ts.isImportEqualsDeclaration(node)
}

function hasDeclareModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true
}

function addRuntimeBindings(
  name: ts.BindingName | ts.Identifier,
  scope: ts.Node,
  declaration: ts.Node,
  eligible: boolean,
  bindingsByName: Map<string, RuntimeBinding[]>,
): void {
  if (ts.isIdentifier(name)) {
    const binding = {scope, declaration, eligible}
    const existing = bindingsByName.get(name.text)
    if (existing == null) bindingsByName.set(name.text, [binding])
    else existing.push(binding)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      addRuntimeBindings(element.name, scope, declaration, eligible, bindingsByName)
    }
  }
}

function isRuntimeScope(node: ts.Node): boolean {
  return ts.isBlock(node)
    || ts.isModuleBlock(node)
    || ts.isFunctionLike(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isCatchClause(node)
    || ts.isCaseBlock(node)
}

function stableRuntimeRootsAt(
  element: ts.Node,
  sourceFile: ts.SourceFile,
  stability: RuntimeStability,
  requiredRoots: Set<string>,
): Set<string> {
  const roots = new Set<string>()
  if (stability.hasEval) return roots
  for (const name of requiredRoots) {
    const containing = (stability.bindingsByName.get(name) ?? []).filter(binding =>
      binding.scope.pos <= element.pos
      && binding.scope.end >= element.end)
    if (containing.length === 0) continue
    let closestSize = Number.POSITIVE_INFINITY
    for (const binding of containing) {
      closestSize = Math.min(closestSize, binding.scope.end - binding.scope.pos)
    }
    const closest = containing.filter(binding => binding.scope.end - binding.scope.pos === closestSize)
    if (closest.length !== 1) continue
    const binding = closest[0]!
    if (binding.eligible
      && binding.declaration.getStart(sourceFile) < element.getStart(sourceFile)
      && !stability.written.has(name)) roots.add(name)
  }
  return roots
}

function removeEarlierDeclaration(declarations: SpacingDeclaration[], propertyName: string): void {
  const index = declarations.findIndex(declaration =>
    declaration.source.kind === 'inline' && declaration.source.property === propertyName)
  if (index !== -1) declarations.splice(index, 1)
}

function removeEarlierPropertyCoverage(
  reasons: {propertyName: string; reason: SpacingCoverageReason}[],
  propertyName: string,
): void {
  const index = reasons.findIndex(entry => entry.propertyName === propertyName)
  if (index !== -1) reasons.splice(index, 1)
}

function positionCorrelationRoots(
  classPositionCases: ClassPositionCases,
  declarations: SpacingDeclaration[],
): Set<string> {
  const roots = new Set<string>()
  if (classPositionCases.kind === 'known') {
    for (const positionCase of classPositionCases.cases) addGuardRoots(positionCase.guard, roots)
  }
  for (const declaration of declarations) {
    if (declaration.kind !== 'offset' || declaration.presence.kind === 'unknown') continue
    for (const guard of declaration.presence.alternatives) addGuardRoots(guard, roots)
  }
  return roots
}

function addGuardRoots(
  guard: Extract<RuntimeCases, {kind: 'known'}>['alternatives'][number],
  roots: Set<string>,
): void {
  for (const term of guard) roots.add(term.predicate.reference.root)
}

function addAssignedNames(target: ts.Node, names: Set<string>): void {
  if (ts.isIdentifier(target)) {
    names.add(target.text)
    return
  }
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return
  ts.forEachChild(target, child => addAssignedNames(child, names))
}

function positionCorrelationUsesStableRoots(
  classPositionCases: ClassPositionCases,
  declarations: SpacingDeclaration[],
  stableRuntimeRoots: Set<string>,
): boolean {
  if (classPositionCases.kind === 'known'
    && !classPositionCases.cases.every(positionCase =>
      guardUsesStableRoots(positionCase.guard, stableRuntimeRoots))) return false
  for (const declaration of declarations) {
    if (declaration.kind === 'offset'
      && !runtimeCasesUseStableRoots(declaration.presence, stableRuntimeRoots)) return false
  }
  return true
}

function runtimeCasesUseStableRoots(cases: RuntimeCases, stableRuntimeRoots: Set<string>): boolean {
  return cases.kind === 'unknown'
    || cases.alternatives.every(guard => guardUsesStableRoots(guard, stableRuntimeRoots))
}

function guardUsesStableRoots(
  guard: Extract<RuntimeCases, {kind: 'known'}>['alternatives'][number],
  stableRuntimeRoots: Set<string>,
): boolean {
  return guard.every(term =>
    term.predicate.reference.properties.length === 0
    && stableRuntimeRoots.has(term.predicate.reference.root))
}
