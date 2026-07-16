export type StaticLayoutSourceTarget = {
  kind: 'jsx'
  file: string
  marker: string
}

export type StaticLayoutTarget = {
  name: string
  source: StaticLayoutSourceTarget
}

export type StaticLayoutConstraint = {
  kind: 'intrinsicBlockSize'
  name: string
  target: string
  pixels: number
  tolerancePx: number
  viewportWidths: [number, ...number[]]
}

export type StaticLayoutSuite = {
  targets: StaticLayoutTarget[]
  constraints: StaticLayoutConstraint[]
}

export type StaticLayoutEvidence = {
  file: string
  line: number
  column: number
  description: string
}

export type StaticLayoutUnknownReason =
  | {kind: 'typescriptProjectMissing'}
  | {kind: 'sourceFileMissing'; file: string}
  | {kind: 'sourceFileOutsideProject'; file: string}
  | {kind: 'sourceSuppressesTypeChecking'; file: string}
  | {kind: 'sourceMentionsEval'; file: string}
  | {kind: 'sourceMarkerMissing'; marker: string}
  | {kind: 'sourceMarkerMatchedMultiple'; marker: string; count: number}
  | {kind: 'unsupportedSource'; reasons: string[]}

export type StaticLayoutCheck =
  | {
      kind: 'pass'
      constraint: string
      target: string
      minimumPx: number
      maximumPx: number
    }
  | {
      kind: 'fail'
      constraint: string
      target: string
      expectedPixels: number
      tolerancePx: number
      minimumPx: number
      maximumPx: number | null
      witnessMinimumPx: number
      evidence: StaticLayoutEvidence[]
    }
  | {
      kind: 'unknown'
      constraint: string
      target: string
      minimumPx: number | null
      maximumPx: number | null
      reason: StaticLayoutUnknownReason
    }

export type StaticLayoutAudit = {
  checks: StaticLayoutCheck[]
}
