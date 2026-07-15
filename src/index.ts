import {analyzeCheckedSource} from './analyze.ts'
import {createFileAudit, type FileAudit} from './audit.ts'
import {createReport, type AnalysisReport} from './report/index.ts'
import {checkFile, checkSource} from './typescript/check.ts'

export function analyzeFile(file: string, baseDirectory?: string): AnalysisReport {
  const {program, analysis} = analyzeCheckedSource(checkFile(file), baseDirectory)
  return createReport(program, analysis)
}

export function analyzeSource(file: string, source: string): AnalysisReport {
  const {program, analysis} = analyzeCheckedSource(checkSource(file, source))
  return createReport(program, analysis)
}

export function auditSource(file: string, source: string): FileAudit {
  return createFileAudit(analyzeCheckedSource(checkSource(file, source)))
}

export {formatReport} from './report/index.ts'
export {formatFileAuditUnit, refactorGuide, refactorGuides} from './audit.ts'
export {auditSpacingSource, formatSpacingReport, spacingPreamble} from './spacing/index.ts'
export {
  auditLayoutSnapshot,
  auditLayoutSnapshots,
  findChromeExecutable,
  formatLayoutReport,
  parseLayoutSuite,
  runLayoutSuite,
} from './layout/index.ts'
export type {AuditCoverage, AuditReason, AuditReference, FileAudit, RefactorGuide, RefactorGuideID} from './audit.ts'
export type {AnalysisReport} from './report/index.ts'
export type {
  OffsetProperty,
  SpacingAmount,
  SpacingAxis,
  SpacingCoverageReason,
  SpacingElementAudit,
  SpacingElementCoverage,
  SpacingFileAudit,
  SpacingNormalization,
  SpacingOwnershipFinding,
  SpacingReportOptions,
  SpacingValue,
  SpacingValueKind,
} from './spacing/index.ts'
export type {
  LayoutAxis,
  LayoutAlignmentInference,
  LayoutBox,
  LayoutCheck,
  LayoutChildBox,
  LayoutConstraint,
  LayoutMetric,
  LayoutInference,
  LayoutInferenceAmbiguity,
  LayoutInferenceEvidence,
  LayoutInferenceUnknownReason,
  LayoutRect,
  LayoutScenario,
  LayoutScenarioAudit,
  LayoutScenarioSnapshot,
  LayoutSuite,
  LayoutSuiteAudit,
  LayoutTarget,
  LayoutTargetObservation,
  LayoutUnknownReason,
} from './layout/index.ts'
