export type LayoutAxis = 'block' | 'inline'

export type LayoutMetric =
  | {kind: 'size'; axis: LayoutAxis}
  | {kind: 'edge'; axis: LayoutAxis; edge: 'start' | 'end' | 'center'}

export type LayoutTarget = {
  name: string
  selector: string
}

export type LayoutScenario = {
  name: string
  url: string
  viewport: {width: number; height: number}
  readySelector: string
}

export type LayoutConstraint =
  | {
      kind: 'equalsPixels'
      name: string
      target: string
      metric: Extract<LayoutMetric, {kind: 'size'}>
      pixels: number
      tolerancePx: number
      scenarios: [string, ...string[]]
    }
  | {
      kind: 'align'
      name: string
      targets: [string, string, ...string[]]
      metric: Extract<LayoutMetric, {kind: 'edge'}>
      tolerancePx: number
      scenarios: [string, ...string[]]
    }

export type LayoutAlignmentInference = {
  name: string
  tracks: [string, string, ...string[]]
  axis: LayoutAxis
  tolerancePx: number
  scenarios: [string, ...string[]]
}

export type LayoutSuite = {
  targets: LayoutTarget[]
  scenarios: LayoutScenario[]
  constraints: LayoutConstraint[]
  inferAlignments: LayoutAlignmentInference[]
}

export type LayoutRect = {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

export type LayoutChildBox = {
  label: string
  selector: string
  band: string | null
  position: string
  rect: LayoutRect
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

export type LayoutBox = {
  rect: LayoutRect | null
  writingMode: string
  direction: string
  display: string
  children: LayoutChildBox[]
}

export type LayoutTargetObservation = {
  target: string
  selector: string
  invalidSelector: boolean
  matches: LayoutBox[]
}

export type LayoutScenarioSnapshot =
  | {
      kind: 'captured'
      scenario: string
      stable: boolean
      targets: LayoutTargetObservation[]
    }
  | {
      kind: 'failed'
      scenario: string
      message: string
    }

export type LayoutUnknownReason =
  | {kind: 'targetMissing'; target: string}
  | {kind: 'targetMatchedMultiple'; target: string; count: number}
  | {kind: 'targetHasNoPrincipalBox'; target: string}
  | {kind: 'invalidSelector'; target: string; selector: string}
  | {kind: 'unsupportedWritingMode'; target: string; writingMode: string}
  | {kind: 'unstableGeometry'}
  | {kind: 'scenarioFailed'; message: string}
  | {kind: 'scenarioMissing'}

export type LayoutContributor = {
  label: string
  selector: string
  outerSize: number
}

export type LayoutCheck =
  | {
      kind: 'pass'
      scenario: string
      constraint: string
      measurements: number[]
    }
  | {
      kind: 'fail'
      scenario: string
      constraint: string
      rule: 'layout-size' | 'layout-alignment'
      measurements: number[]
      expected: number | 'aligned'
      tolerancePx: number
      deltaPx: number
      contributors: LayoutContributor[]
    }
  | {
      kind: 'unknown'
      scenario: string
      constraint: string
      reason: LayoutUnknownReason
    }

export type LayoutScenarioAudit = {
  scenario: string
  checks: LayoutCheck[]
  inferences: LayoutInference[]
}

export type LayoutInferenceEvidence = {
  track: string
  child: string
  selector: string
  position: number
}

export type LayoutInferenceAmbiguity = {
  kind: 'trackChildCountMismatch'
  tracks: string[]
  counts: number[]
}

export type LayoutInferenceUnknownReason = LayoutUnknownReason | {kind: 'noVisibleTrackChildren'}

export type LayoutInference =
  | {
      kind: 'candidate'
      scenario: string
      inference: string
      confidence: 'strong' | 'ambiguous'
      axis: LayoutAxis
      childIndex: number
      band: string | null
      tolerancePx: number
      deltaPx: number
      evidence: LayoutInferenceEvidence[]
    }
  | {
      kind: 'ambiguous'
      scenario: string
      inference: string
      reason: LayoutInferenceAmbiguity
    }
  | {
      kind: 'aligned'
      scenario: string
      inference: string
    }
  | {
      kind: 'unknown'
      scenario: string
      inference: string
      reason: LayoutInferenceUnknownReason
    }

export type LayoutSuiteAudit = {
  scenarios: LayoutScenarioAudit[]
}
