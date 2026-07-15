import type {
  LayoutBox,
  LayoutChildBox,
  LayoutRect,
  LayoutScenarioSnapshot,
  LayoutTargetObservation,
} from './model.ts'

export function parseCapturedLayoutSnapshot(value: unknown, scenario: string): LayoutScenarioSnapshot {
  const snapshot = record(value, 'captured layout snapshot')
  const failure = snapshot['failure']
  if (typeof failure === 'string') return {kind: 'failed', scenario, message: failure}
  return {
    kind: 'captured',
    scenario,
    stable: boolean(snapshot['stable'], 'captured layout snapshot.stable'),
    targets: array(snapshot['targets'], 'captured layout snapshot.targets').map((target, index) =>
      parseTarget(target, `captured layout snapshot.targets[${index}]`)),
  }
}

function parseTarget(value: unknown, path: string): LayoutTargetObservation {
  const target = record(value, path)
  return {
    target: string(target['target'], `${path}.target`),
    selector: string(target['selector'], `${path}.selector`),
    invalidSelector: boolean(target['invalidSelector'], `${path}.invalidSelector`),
    matches: array(target['matches'], `${path}.matches`).map((match, index) =>
      parseBox(match, `${path}.matches[${index}]`)),
  }
}

function parseBox(value: unknown, path: string): LayoutBox {
  const box = record(value, path)
  const rawRect = box['rect']
  return {
    rect: rawRect === null ? null : parseRect(rawRect, `${path}.rect`),
    writingMode: string(box['writingMode'], `${path}.writingMode`),
    direction: string(box['direction'], `${path}.direction`),
    display: string(box['display'], `${path}.display`),
    children: array(box['children'], `${path}.children`).map((child, index) =>
      parseChild(child, `${path}.children[${index}]`)),
  }
}

function parseChild(value: unknown, path: string): LayoutChildBox {
  const child = record(value, path)
  return {
    label: string(child['label'], `${path}.label`),
    selector: string(child['selector'], `${path}.selector`),
    position: string(child['position'], `${path}.position`),
    rect: parseRect(child['rect'], `${path}.rect`),
    marginTop: finiteNumber(child['marginTop'], `${path}.marginTop`),
    marginRight: finiteNumber(child['marginRight'], `${path}.marginRight`),
    marginBottom: finiteNumber(child['marginBottom'], `${path}.marginBottom`),
    marginLeft: finiteNumber(child['marginLeft'], `${path}.marginLeft`),
  }
}

function parseRect(value: unknown, path: string): LayoutRect {
  const rect = record(value, path)
  return {
    top: finiteNumber(rect['top'], `${path}.top`),
    right: finiteNumber(rect['right'], `${path}.right`),
    bottom: finiteNumber(rect['bottom'], `${path}.bottom`),
    left: finiteNumber(rect['left'], `${path}.left`),
    width: finiteNumber(rect['width'], `${path}.width`),
    height: finiteNumber(rect['height'], `${path}.height`),
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) throw new Error(`${path} must be an object.`)
  return value as Record<string, unknown>
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string.`)
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`)
  return value
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number.`)
  return value
}
