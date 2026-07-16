import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path'
import * as ts from 'typescript'
import {TypeScriptDiagnosticsError} from './diagnostics.ts'

export type LoadedTypeScriptProject = {
  configPath: string
  rootDirectory: string
  parsed: ts.ParsedCommandLine
  program: ts.Program
}

export type ProjectSource = {
  project: LoadedTypeScriptProject
  sourceFile: ts.SourceFile
}

export type TypeScriptProjectGraph = {
  entry: LoadedTypeScriptProject
  projects: LoadedTypeScriptProject[]
  sources: ProjectSource[]
}

export function findTypeScriptConfig(searchFrom: string): string | null {
  return ts.findConfigFile(resolve(searchFrom), file => ts.sys.fileExists(file), 'tsconfig.json') ?? null
}

export function loadCheckedTypeScriptProjectGraph(configPath: string): TypeScriptProjectGraph {
  return loadProjectGraph(configPath, true)
}

// Syntax-first consumers use the same Programs and SourceFiles as project discovery.
// They never request diagnostics, so files with type errors still analyze, and unlike
// the checked analyzer they accept a project without strict null checks. A consumer may
// still ask the Program for a checker: the layout evaluator reads literal-union types
// to decide branch reachability.
export function loadSyntaxTypeScriptProjectGraph(configPath: string): TypeScriptProjectGraph {
  return loadProjectGraph(configPath, false)
}

export function findProjectSource(graph: TypeScriptProjectGraph, file: string): ProjectSource | null {
  const target = canonicalPathKey(file)
  return graph.sources.find(source => canonicalPathKey(source.sourceFile.fileName) === target) ?? null
}

function loadProjectGraph(configPath: string, requireStrict: boolean): TypeScriptProjectGraph {
  const projects: LoadedTypeScriptProject[] = []
  const loadedByConfig = new Map<string, LoadedTypeScriptProject>()
  const loading = new Set<string>()

  const load = (requestedConfigPath: string): LoadedTypeScriptProject => {
    const absoluteConfigPath = realPath(requestedConfigPath)
    const configKey = canonicalPathKey(absoluteConfigPath)
    const existing = loadedByConfig.get(configKey)
    if (existing != null) return existing
    if (loading.has(configKey)) {
      throw new Error(`Circular TypeScript project reference involving ${absoluteConfigPath}`)
    }
    loading.add(configKey)
    const parsed = parseConfig(absoluteConfigPath)
    if (requireStrict) requireStrictNullChecks(parsed.options, absoluteConfigPath)
    for (const reference of parsed.projectReferences ?? []) {
      load(ts.resolveProjectReferencePath(reference))
    }
    const project: LoadedTypeScriptProject = {
      configPath: absoluteConfigPath,
      rootDirectory: dirname(absoluteConfigPath),
      parsed,
      program: createProjectProgram(parsed),
    }
    loading.delete(configKey)
    loadedByConfig.set(configKey, project)
    projects.push(project)
    return project
  }

  const entry = load(configPath)
  return {entry, projects, sources: collectProjectSources(projects)}
}

function collectProjectSources(projects: LoadedTypeScriptProject[]): ProjectSource[] {
  const sources = new Map<string, ProjectSource>()
  for (const project of projects) {
    for (const sourceFile of project.program.getSourceFiles()) {
      if (!isProjectImplementationSource(sourceFile)) continue
      const absoluteFile = realPath(sourceFile.fileName)
      const fileKey = canonicalPathKey(absoluteFile)
      const existing = sources.get(fileKey)
      const candidate = {project, sourceFile}
      if (existing == null
        || ownershipScore(project, absoluteFile) > ownershipScore(existing.project, absoluteFile)) {
        sources.set(fileKey, candidate)
      }
    }
  }
  return [...sources.values()]
    .sort((left, right) => left.sourceFile.fileName.localeCompare(right.sourceFile.fileName))
}

function createProjectProgram(parsed: ts.ParsedCommandLine): ts.Program {
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    configFileParsingDiagnostics: parsed.errors,
    ...(parsed.projectReferences == null ? {} : {projectReferences: parsed.projectReferences}),
  })
}

function isProjectImplementationSource(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile || sourceFile.fileName.includes(`${sep}node_modules${sep}`)) return false
  switch (extname(sourceFile.fileName).toLowerCase()) {
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
    case '.mjs':
    case '.mts':
    case '.cjs':
    case '.cts': return true
    default: return false
  }
}

function parseConfig(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new TypeScriptDiagnosticsError([diagnostic], {}, dirname(configPath))
    },
  })
  if (parsed == null) throw new Error(`TypeScript could not parse ${configPath}`)
  if (parsed.errors.length > 0) {
    throw new TypeScriptDiagnosticsError(parsed.errors, parsed.options, dirname(configPath))
  }
  return parsed
}

function requireStrictNullChecks(options: ts.CompilerOptions, configPath: string): void {
  // TypeScript 6 defaults strict mode on. An explicit strictNullChecks setting wins;
  // otherwise strict:false is the only way the effective option is disabled.
  const enabled = options.strictNullChecks ?? options.strict !== false
  if (enabled) return
  throw new Error(
    `freerange requires strictNullChecks. Enable "strict": true or "strictNullChecks": true in ${configPath}.`,
  )
}

function ownershipScore(project: LoadedTypeScriptProject, file: string): number {
  const path = relative(project.rootDirectory, file)
  const inside = path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  return inside ? project.rootDirectory.length : -1
}

function realPath(path: string): string {
  const absolute = resolve(path)
  return ts.sys.realpath?.(absolute) ?? absolute
}

function canonicalPathKey(path: string): string {
  const real = realPath(path)
  return ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase()
}
