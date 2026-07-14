export type SpacingAxis = 'vertical' | 'horizontal'

export type OffsetProperty =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'blockStart'
  | 'blockEnd'
  | 'inlineStart'
  | 'inlineEnd'

export type PositionStatus = 'outOfFlow' | 'positionedInFlow' | 'none'

// The normal className reading only asks whether any effective position utility is
// present. Tailwind Merge additionally needs the last utility in that group. These four
// states keep the two facts correlated, so impossible combinations cannot be built.
export type PositionTrace = 'none' | 'static' | 'positioned' | 'positionedThenStatic'

export type ClassOutcome =
  | {kind: 'nullish'}
  | {kind: 'falsy'}
  | {kind: 'truthy'; position: PositionTrace}

export type ClassCoverage = 'complete' | 'partial'

export type ClassSummary = {
  possibleClasses: ClassFact[]
  coverage: ClassCoverage
  outcomes: ClassOutcome[]
}

export type DeclarationTarget = 'self' | 'other'
export type DeclarationCondition = 'always' | 'conditional'

export type SpacingAmount =
  | {form: 'tailwindScale'; steps: number}
  | {form: 'length'; value: number; unit: 'px' | 'rem'}
  | {form: 'named'; name: string}
  | {form: 'keyword'; text: string}
  | {form: 'computed'}

export type ClassFact =
  | {
      kind: 'position'
      token: string
      status: PositionStatus
      target: DeclarationTarget
      condition: DeclarationCondition
    }
  | {
      kind: 'offset'
      token: string
      properties: OffsetProperty[]
      target: DeclarationTarget
      condition: DeclarationCondition
    }
  | {
      kind: 'margin' | 'padding' | 'gap'
      token: string
      axis: SpacingAxis | 'both'
      amount: SpacingAmount
      target: DeclarationTarget
      condition: DeclarationCondition
    }

export type DeclarationSource =
  | {kind: 'class'; token: string}
  | {kind: 'inline'; property: string}

export type SpacingDeclaration =
  | {
      kind: 'offset'
      properties: OffsetProperty[]
      source: DeclarationSource
      target: DeclarationTarget
      condition: DeclarationCondition
    }
  | {
      kind: 'margin' | 'padding' | 'gap'
      axis: SpacingAxis | 'both'
      amount: SpacingAmount
      source: DeclarationSource
      target: DeclarationTarget
      condition: DeclarationCondition
    }

export type SpacingCoverageReason =
  | {kind: 'spreadAttributes'}
  | {kind: 'computedStyle'}
  | {kind: 'opaqueStyleMember'}
  | {kind: 'computedClassName'}
  | {kind: 'partialClassName'}
  | {kind: 'computedPosition'}

export type SpacingElementCoverage =
  | {kind: 'complete'}
  | {kind: 'partial'; reasons: [SpacingCoverageReason, ...SpacingCoverageReason[]]}
  | {kind: 'unsupported'; reason: SpacingCoverageReason}

export type SpacingOwnershipFinding =
  | {kind: 'offsetWithoutPosition'; styleProperty: string; positionClass: string | null}
  | {kind: 'marginClassOnOwnedAxis'; axis: SpacingAxis; styleProperty: string; className: string}
  | {kind: 'offsetClassOnOwnedProperty'; property: OffsetProperty; styleProperty: string; className: string}

export type SpacingValueKind = 'margin' | 'padding' | 'gap'

export type SpacingValue = {
  axis: SpacingAxis | 'both'
  kind: SpacingValueKind
  amount: SpacingAmount
  source: string
}

export type SpacingElementAudit = {
  line: number
  column: number
  coverage: SpacingElementCoverage
  ownership: SpacingOwnershipFinding[]
  values: SpacingValue[]
  hasVisibleInlineOwnership: boolean
}

export type SpacingFileAudit = {
  file: string
  elements: SpacingElementAudit[]
}

export type SpacingNormalization = {
  tailwindStepRem: number
  rootFontSizePx: number
}

export type SpacingReportOptions = {
  pretty: boolean
  normalization: SpacingNormalization
}

export type LoweredSpacingElement = {
  line: number
  column: number
  classes: ClassSummary
  inlineDeclarations: SpacingDeclaration[]
  inlinePosition: PositionStatus | 'computed' | null
  stylePositionComplete: boolean
  coverageReasons: SpacingCoverageReason[]
}
