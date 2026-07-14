import * as ts from 'typescript'
import {classAttributeSummary, emptyClassSummary} from './class-expression.ts'
import type {
  ClassSummary,
  LoweredSpacingElement,
  OffsetProperty,
  PositionStatus,
  SpacingAmount,
  SpacingCoverageReason,
  SpacingDeclaration,
  SpacingValueKind,
} from './model.ts'

export function lowerSpacingElements(sourceFile: ts.SourceFile): LoweredSpacingElement[] {
  const elements: LoweredSpacingElement[] = []
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && ts.isIdentifier(node.tagName)
      && isIntrinsicTagName(node.tagName.text)) {
      elements.push(lowerElement(node, sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return elements
}

function lowerElement(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  sourceFile: ts.SourceFile,
): LoweredSpacingElement {
  let classes = emptyClassSummary()
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
        classMayComeFromSpread = false
        if (classes.coverage === 'partial') {
          coverageReasons.push({
            kind: classes.possibleClasses.length === 0 ? 'computedClassName' : 'partialClassName',
          })
        }
        break
      }
      case 'style': {
        const style = lowerStyleAttribute(attribute, sourceFile)
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
    if (classMayComeFromSpread) classes = markClassSummaryPartial(classes)
    if (styleMayComeFromSpread) stylePositionComplete = false
  }

  const {line, character} = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile))
  return {
    line: line + 1,
    column: character + 1,
    classes,
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

function lowerStyleAttribute(attribute: ts.JsxAttribute, sourceFile: ts.SourceFile): LoweredStyle {
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
    if (propertyName === 'position') {
      position = positionValue(member)
      positionComplete = position !== 'computed'
      if (position === 'computed') {
        coverageReasons.push({kind: 'computedPosition'})
      }
      continue
    }

    const declaration = inlineDeclaration(member, propertyName, sourceFile)
    if (declaration != null) declarations.push(declaration)
  }
  return {declarations, position, positionComplete, coverageReasons}
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
): SpacingDeclaration | null {
  const offsetProperties = inlineOffsetProperties(propertyName)
  if (offsetProperties != null) {
    return {
      kind: 'offset',
      properties: offsetProperties,
      source: {kind: 'inline', property: propertyName},
      target: 'self',
      condition: 'always',
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
