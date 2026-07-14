import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join, relative} from 'node:path'
import {auditSpacingFile} from '../src/spacing/audit.ts'
import {
  findProjectSource,
  loadCheckedTypeScriptProjectGraph,
  loadSyntaxTypeScriptProjectGraph,
} from '../src/typescript/project.ts'

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
}

test('the syntax graph reuses transitive Program SourceFiles without type-checking or rereading', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-syntax-graph-'))
  try {
    writeFiles(directory, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: false,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          jsx: 'preserve',
          pretty: true,
        },
        files: ['entry.ts'],
      }),
      'entry.ts': `import './feature'\n`,
      'feature.ts': `import './overlay'\nimport './types.d.ts'\nimport './node_modules/dependency'\n`,
      'overlay.tsx': `const broken: number = 'type errors do not block syntax consumers'
export const overlay = <div className="mt-2" style={{top: 8}}/>
`,
      'types.d.ts': 'declare const ambient: number\n',
      'node_modules/dependency.ts': 'export const dependency = 1\n',
      'unused.tsx': 'export const unused = <div className="mt-96"/>\n',
    })

    const graph = loadSyntaxTypeScriptProjectGraph(join(directory, 'tsconfig.json'))
    const realDirectory = realpathSync.native(directory)
    expect(graph.entry.parsed.options['pretty']).toBe(true)
    expect(graph.sources.map(source => relative(realDirectory, source.sourceFile.fileName))).toEqual([
      'entry.ts', 'feature.ts', 'overlay.tsx',
    ])
    expect(() => loadCheckedTypeScriptProjectGraph(join(directory, 'tsconfig.json')))
      .toThrow('freerange requires strictNullChecks')

    const overlay = findProjectSource(graph, join(directory, 'overlay.tsx'))
    if (overlay == null) throw new Error('Expected the imported overlay SourceFile')
    rmSync(join(directory, 'overlay.tsx'))
    const audit = auditSpacingFile(overlay.sourceFile)
    expect(audit.elements.flatMap(element => element.ownership)).toEqual([
      {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
      {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-2'},
    ])
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('solution references are loaded once and the deepest project owns a shared source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-reference-graph-'))
  try {
    writeFiles(directory, {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {pretty: false},
        files: [],
        references: [{path: './packages/a'}, {path: './packages/b'}],
      }),
      'packages/a/tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          composite: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        files: ['src/entry.ts'],
      }),
      'packages/a/src/entry.ts': `import {shared} from './shared'\nexport const a = shared\n`,
      'packages/a/src/shared.ts': 'export const shared = 1\n',
      'packages/b/tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          composite: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
        files: ['src/entry.ts'],
      }),
      'packages/b/src/entry.ts': `import {shared} from '../../a/src/shared'\nexport const b = shared\n`,
    })

    const graph = loadSyntaxTypeScriptProjectGraph(join(directory, 'tsconfig.json'))
    const realDirectory = realpathSync.native(directory)
    expect(graph.projects.map(project => relative(realDirectory, project.configPath))).toEqual([
      'packages/a/tsconfig.json',
      'packages/b/tsconfig.json',
      'tsconfig.json',
    ])
    expect(graph.sources.map(source => relative(realDirectory, source.sourceFile.fileName))).toEqual([
      'packages/a/src/entry.ts',
      'packages/a/src/shared.ts',
      'packages/b/src/entry.ts',
    ])
    const shared = findProjectSource(graph, join(directory, 'packages/a/src/shared.ts'))
    expect(shared == null ? null : relative(realDirectory, shared.project.configPath))
      .toBe('packages/a/tsconfig.json')

    const alias = join(directory, 'shared-alias.ts')
    symlinkSync(join(directory, 'packages/a/src/shared.ts'), alias)
    expect(findProjectSource(graph, alias)?.sourceFile).toBe(shared?.sourceFile)
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('both graph modes reject project-reference cycles', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-reference-cycle-'))
  try {
    writeFiles(directory, {
      'a/tsconfig.json': JSON.stringify({files: [], references: [{path: '../b'}]}),
      'b/tsconfig.json': JSON.stringify({files: [], references: [{path: '../a'}]}),
    })
    for (const load of [loadSyntaxTypeScriptProjectGraph, loadCheckedTypeScriptProjectGraph]) {
      expect(() => load(join(directory, 'a/tsconfig.json')))
        .toThrow('Circular TypeScript project reference')
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('syntax graph loading still rejects invalid compiler configuration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-invalid-config-'))
  try {
    writeFiles(directory, {
      'tsconfig.json': JSON.stringify({compilerOptions: {target: 'not-a-target'}, files: []}),
    })
    expect(() => loadSyntaxTypeScriptProjectGraph(join(directory, 'tsconfig.json'))).toThrow()
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
