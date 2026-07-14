import * as ts from 'typescript'
import {hasPositionOnEveryOutcome} from './class-expression.ts'
import {lowerSpacingElements} from './lower.ts'
import type {
  ClassFact,
  LoweredSpacingElement,
  OffsetProperty,
  SpacingAxis,
  SpacingCoverageReason,
  SpacingDeclaration,
  SpacingElementAudit,
  SpacingElementCoverage,
  SpacingFileAudit,
  SpacingOwnershipFinding,
  SpacingValue,
} from './model.ts'

export function auditSpacingSource(file: string, source: string): SpacingFileAudit {
  return auditSpacingFile(ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, false))
}

export function auditSpacingFile(sourceFile: ts.SourceFile): SpacingFileAudit {
  return {
    file: sourceFile.fileName,
    elements: lowerSpacingElements(sourceFile).map(auditElement),
  }
}

function auditElement(element: LoweredSpacingElement): SpacingElementAudit {
  const classDeclarations = element.classes.possibleClasses.flatMap(classFactDeclaration)
  const ownership = ownershipFindings(element, classDeclarations)
  const values = spacingValues(element.inlineDeclarations, classDeclarations)
  const hasVisibleInlineOwnership = element.inlineDeclarations.some(declaration =>
    declaration.kind === 'offset' || declaration.kind === 'margin')
  return {
    line: element.line,
    column: element.column,
    coverage: elementCoverage(element, classDeclarations),
    ownership,
    values,
    hasVisibleInlineOwnership,
  }
}

function classFactDeclaration(classFact: ClassFact): SpacingDeclaration[] {
  switch (classFact.kind) {
    case 'position': return []
    case 'offset':
      return [{
        kind: 'offset',
        properties: classFact.properties,
        source: {kind: 'class', token: classFact.token},
        target: classFact.target,
        condition: classFact.condition,
      }]
    case 'margin':
    case 'padding':
    case 'gap':
      return [{
        kind: classFact.kind,
        axis: classFact.axis,
        amount: classFact.amount,
        source: {kind: 'class', token: classFact.token},
        target: classFact.target,
        condition: classFact.condition,
      }]
  }
}

function ownershipFindings(
  element: LoweredSpacingElement,
  classDeclarations: SpacingDeclaration[],
): SpacingOwnershipFinding[] {
  const findings: SpacingOwnershipFinding[] = []
  const inlineOwned = element.inlineDeclarations.filter(declaration =>
    declaration.kind === 'offset' || declaration.kind === 'margin')
  const inlineOffsets = inlineOwned.filter(declaration => declaration.kind === 'offset')

  if (inlineOffsets.length > 0 && offsetIsProvenUnpositioned(element)) {
    const staticClass = element.classes.possibleClasses.find(classFact =>
      classFact.kind === 'position'
      && classFact.status === 'none'
      && classFact.target === 'self'
      && classFact.condition === 'always')
    findings.push({
      kind: 'offsetWithoutPosition',
      styleProperty: inlineProperty(inlineOffsets[0]!),
      positionClass: staticClass?.kind === 'position' ? staticClass.token : null,
    })
  }

  for (const classDeclaration of classDeclarations) {
    if (classDeclaration.target !== 'self') continue
    if (classDeclaration.kind === 'margin') {
      const owned = inlineOwned.find(candidate => axesOverlap(classDeclaration.axis, declarationAxes(candidate)))
      if (owned == null) continue
      findings.push({
        kind: 'marginClassOnOwnedAxis',
        axis: firstSharedAxis(classDeclaration.axis, declarationAxes(owned)),
        styleProperty: inlineProperty(owned),
        className: classToken(classDeclaration),
      })
      continue
    }
    if (classDeclaration.kind !== 'offset') continue
    for (const inlineOffset of inlineOffsets) {
      const shared = classDeclaration.properties.find(property => inlineOffset.properties.includes(property))
      if (shared == null) continue
      findings.push({
        kind: 'offsetClassOnOwnedProperty',
        property: shared,
        styleProperty: inlineProperty(inlineOffset),
        className: classToken(classDeclaration),
      })
      break
    }
  }
  return findings
}

function offsetIsProvenUnpositioned(element: LoweredSpacingElement): boolean {
  if (!element.stylePositionComplete) return false
  switch (element.inlinePosition) {
    case 'outOfFlow':
    case 'positionedInFlow': return false
    case 'none': return true
    case 'computed': return false
    case null:
      return element.classes.coverage === 'complete' && !hasPositionOnEveryOutcome(element.classes)
  }
}

function spacingValues(
  inlineDeclarations: SpacingDeclaration[],
  classDeclarations: SpacingDeclaration[],
): SpacingValue[] {
  const values: SpacingValue[] = []
  for (const declaration of [...inlineDeclarations, ...classDeclarations]) {
    if (declaration.kind === 'offset') continue
    values.push({
      axis: declaration.axis,
      kind: declaration.kind,
      amount: declaration.amount,
      source: declaration.source.kind === 'inline'
        ? declaration.source.property
        : declaration.source.token,
    })
  }
  return values
}

function elementCoverage(
  element: LoweredSpacingElement,
  classDeclarations: SpacingDeclaration[],
): SpacingElementCoverage {
  const reasons = uniqueReasons(element.coverageReasons)
  if (reasons.length === 0) return {kind: 'complete'}
  const hasUsefulFact = element.inlineDeclarations.length > 0
    || classDeclarations.length > 0
    || (element.inlinePosition != null && element.inlinePosition !== 'computed')
    || element.classes.possibleClasses.some(classFact => classFact.kind === 'position')
  if (!hasUsefulFact) return {kind: 'unsupported', reason: reasons[0]!}
  return {kind: 'partial', reasons: [reasons[0]!, ...reasons.slice(1)]}
}

function uniqueReasons(reasons: SpacingCoverageReason[]): SpacingCoverageReason[] {
  const unique: SpacingCoverageReason[] = []
  for (const reason of reasons) {
    if (!unique.some(existing => existing.kind === reason.kind)) unique.push(reason)
  }
  return unique
}

function declarationAxes(declaration: SpacingDeclaration): SpacingAxis | 'both' {
  if (declaration.kind !== 'offset') return declaration.axis
  const vertical = declaration.properties.some(isVerticalOffset)
  const horizontal = declaration.properties.some(property => !isVerticalOffset(property))
  return vertical && horizontal ? 'both' : vertical ? 'vertical' : 'horizontal'
}

function isVerticalOffset(property: OffsetProperty): boolean {
  return property === 'top'
    || property === 'bottom'
    || property === 'blockStart'
    || property === 'blockEnd'
}

function axesOverlap(left: SpacingAxis | 'both', right: SpacingAxis | 'both'): boolean {
  return left === 'both' || right === 'both' || left === right
}

function firstSharedAxis(left: SpacingAxis | 'both', right: SpacingAxis | 'both'): SpacingAxis {
  if (left !== 'both') return left
  if (right !== 'both') return right
  return 'vertical'
}

function inlineProperty(declaration: SpacingDeclaration): string {
  if (declaration.source.kind !== 'inline') throw new Error('Expected an inline spacing declaration')
  return declaration.source.property
}

function classToken(declaration: SpacingDeclaration): string {
  if (declaration.source.kind !== 'class') throw new Error('Expected a class spacing declaration')
  return declaration.source.token
}
