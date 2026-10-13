// Headless Luau tests with Lune. See CONTRACT.md for the IPC, types and agent tools to wire up.
export { TestService, affectedSpecs, type TestServiceOptions } from './service.ts'
export { createSpec, specPathFor, instanceExpression, moduleShape, specTemplate, SpecError } from './scaffold.ts'
export { buildSourcemap, discoverSpecs, instancePathOf, isSpecFile, fileInstance, scriptFiles, type SourcemapNode } from './rojoTree.ts'
export { EventStream, ResultCollector, parseEventLine, formatCompact, PROTOCOL_VERSION, type RunnerEvent } from './protocol.ts'
export { findLune, luneStatus, parseLuneVersion, findRuntimeDir, INSTALL_HINT } from './lune.ts'
export { testTools, runTestsRequest, RUN_TESTS_DESCRIPTION, CREATE_SPEC_DESCRIPTION } from './agentTools.ts'
export type * from './types.ts'
