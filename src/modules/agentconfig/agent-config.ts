/**
 * Project-source-tree Agent/Profile configuration adapter.
 *
 * This module deliberately is not a second persistence store. It only reads
 * and edits the fixed Kimi project files below a workspace root resolved by
 * BoardStore:
 *
 *   <project>/.kimi-code/agents/<kebab-case>.md
 *   <project>/.kimi-code/local.toml
 *
 * Construction is side-effect free. All filesystem work starts in an explicit
 * read/mutation method, which lets ControlPlane keep the adapter out of the
 * Bus/MCP hot paths.
 */
import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { type AtomicWriteOptions, writeFileAtomic } from '../../core/fs-utils.js';

/** Fixed filename contract for project-local Agent Markdown files. */
export const AGENT_DIRECTORY_NAME = 'agents';
export const KIMI_CONFIG_DIRECTORY_NAME = '.kimi-code';
export const LOCAL_TOML_FILE_NAME = 'local.toml';

/** Safety limits for the low-frequency management surface. */
export const AGENT_CONFIG_MAX_AGENT_FILES = 128;
export const AGENT_CONFIG_MAX_FILE_BYTES = 48 * 1024;
export const AGENT_CONFIG_MAX_LOCAL_TOML_BYTES = 48 * 1024;
export const AGENT_CONFIG_MAX_NAME_LENGTH = 64;

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AGENT_FILE_SUFFIX = '.md';
const SECTION_NAMES = ['subagent', 'subagent-slot'] as const;
const BINDING_FIELDS = ['model', 'thinking_effort', 'inherit'] as const;

type BindingField = (typeof BINDING_FIELDS)[number];
export type AgentSection = (typeof SECTION_NAMES)[number];

export interface BindingPatch {
  readonly model?: string | null;
  readonly thinking_effort?: string | null;
  readonly inherit?: boolean | null;
}

export interface BindingChange {
  readonly section: AgentSection;
  readonly name: string;
  readonly binding: BindingPatch | null;
}

export interface AgentBindingSummary {
  readonly section: AgentSection;
  readonly name: string;
  readonly binding: BindingPatch;
  readonly layout: 'standard' | 'complex';
}

export interface AgentLayoutDiagnostic {
  readonly section: string;
  readonly name?: string;
  readonly reason: string;
}

export interface AgentSummary {
  readonly name: string;
  readonly fileName: string;
  readonly hash: string;
  readonly size: number;
  readonly valid: boolean;
  readonly description?: string;
  readonly slot?: string;
  readonly error?: string;
}

export interface AgentDocument {
  readonly projectRoot: string;
  readonly name: string;
  readonly fileName: string;
  readonly content: string;
  readonly hash: string;
  readonly size: number;
  readonly valid: boolean;
  readonly frontmatter?: Record<string, unknown>;
  readonly prompt?: string;
  readonly description?: string;
  readonly slot?: string;
  readonly error?: string;
}

export interface LocalTomlSummary {
  readonly exists: boolean;
  readonly hash: string | null;
  readonly size: number;
}

export interface WorkspaceAgentConfigSnapshot {
  readonly projectRoot: string;
  readonly configDir: string;
  readonly agentsDir: string;
  readonly agents: readonly AgentSummary[];
  readonly bindings: {
    readonly types: readonly AgentBindingSummary[];
    readonly slots: readonly AgentBindingSummary[];
  };
  /** Aliases make the response convenient for both the UI and API consumers. */
  readonly typeBindings: readonly AgentBindingSummary[];
  readonly slotBindings: readonly AgentBindingSummary[];
  readonly layout: 'standard' | 'complex' | 'invalid';
  readonly layoutDiagnostics: readonly AgentLayoutDiagnostic[];
  readonly localToml: LocalTomlSummary;
}

export interface LocalTomlDocument extends LocalTomlSummary {
  readonly projectRoot: string;
  readonly content: string;
}

export interface AgentMutationResult {
  readonly projectRoot: string;
  readonly name: string;
  readonly fileName: string;
  readonly hash: string;
  readonly size: number;
  readonly content: string;
}

export interface AgentDeleteResult {
  readonly projectRoot: string;
  readonly name: string;
  readonly deleted: boolean;
  readonly currentHash: string | null;
}

export interface BindingMutationResult {
  readonly projectRoot: string;
  readonly section: AgentSection;
  readonly name: string;
  readonly binding: BindingPatch;
  readonly hash: string;
  readonly content: string;
}

export interface LocalTomlMutationResult {
  readonly projectRoot: string;
  readonly hash: string;
  readonly size: number;
  readonly content: string;
}

/**
 * Narrow filesystem seam. It intentionally resembles ArchiveIndexFileSystem,
 * while including only operations this source-tree adapter needs.
 */
export interface WorkspaceAgentConfigFileSystem {
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  unlink(path: string): Promise<void>;
  /** Optional so read-only test doubles do not need to implement writes. */
  writeFileAtomic?: (
    path: string,
    content: string,
    options?: AtomicWriteOptions,
  ) => Promise<void>;
}

/** Naming alias for callers that use the shorter seam name. */
export type AgentConfigFileSystem = WorkspaceAgentConfigFileSystem;

const nodeFileSystem: WorkspaceAgentConfigFileSystem = {
  readdir: (path, options) => readdir(path, options),
  lstat,
  realpath,
  readFile: (path, encoding) => readFile(path, encoding),
  mkdir: (path, options) => mkdir(path, options),
  unlink,
  writeFileAtomic,
};

export class AgentConfigError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentConfigError';
    this.status = status;
  }
}

export class AgentConfigValidationError extends AgentConfigError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'AgentConfigValidationError';
  }
}

export class AgentConfigNotFoundError extends AgentConfigError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'AgentConfigNotFoundError';
  }
}

export class AgentConfigUnsafePathError extends AgentConfigError {
  constructor(message = 'project configuration contains an unsafe symbolic link') {
    super(message, 403);
    this.name = 'AgentConfigUnsafePathError';
  }
}

export class AgentConfigConflictError extends AgentConfigError {
  readonly currentHash: string | null;

  constructor(message: string, currentHash: string | null) {
    super(message, 409);
    this.name = 'AgentConfigConflictError';
    this.currentHash = currentHash;
  }
}

/** A Windows editor/antivirus sharing race gets an actionable 409 response. */
export class AgentConfigBusyError extends AgentConfigError {
  constructor(message = 'the configuration file is busy; close the editor or antivirus scan and retry') {
    super(message, 409);
    this.name = 'AgentConfigBusyError';
  }
}

export class AgentConfigLayoutError extends AgentConfigError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'AgentConfigLayoutError';
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isBusy(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

function pathKey(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function isInside(root: string, candidate: string): boolean {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  if (rootKey === candidateKey) return true;
  const prefix = rootKey.endsWith('/') || rootKey.endsWith('\\') ? rootKey : `${rootKey}/`;
  return candidateKey.startsWith(prefix);
}

/** SHA-256 of the exact UTF-8 bytes written to disk. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export const sha256 = contentHash;

export function isKebabCaseName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= AGENT_CONFIG_MAX_NAME_LENGTH
    && KEBAB_NAME.test(value);
}

function assertKebabName(value: unknown, field: string): string {
  if (!isKebabCaseName(value)) {
    throw new AgentConfigValidationError(`${field} must be a kebab-case name`);
  }
  return value;
}

function assertWorkspaceCwd(workspaceCwd: unknown): string {
  if (typeof workspaceCwd !== 'string' || !isAbsolute(workspaceCwd)) {
    throw new AgentConfigValidationError('workspace cwd must be an absolute path resolved by the workspace registry');
  }
  return resolve(workspaceCwd);
}

function assertExpectedHash(expectedHash: unknown): string | null {
  if (expectedHash === null) return null;
  if (typeof expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new AgentConfigValidationError('expectedHash must be a SHA-256 hash or null');
  }
  return expectedHash;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function scalarBinding(value: unknown, field: BindingField): string | boolean | undefined {
  if (value === undefined) return undefined;
  if (field === 'inherit') return typeof value === 'boolean' ? value : undefined;
  return typeof value === 'string' ? value : undefined;
}

function projectBinding(value: unknown): BindingPatch {
  const record = asRecord(value);
  if (record === undefined) return {};
  const model = scalarBinding(record.model, 'model');
  const thinking = scalarBinding(record.thinking_effort, 'thinking_effort');
  const inherit = scalarBinding(record.inherit, 'inherit');
  return {
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof thinking === 'string' ? { thinking_effort: thinking } : {}),
    ...(typeof inherit === 'boolean' ? { inherit } : {}),
  };
}

function validateBindingPatch(value: unknown): BindingPatch {
  const record = asRecord(value);
  if (record === undefined) throw new AgentConfigValidationError('binding must be an object');
  for (const key of Object.keys(record)) {
    if (!(BINDING_FIELDS as readonly string[]).includes(key)) {
      throw new AgentConfigValidationError(`unsupported binding field: ${key}`);
    }
  }
  const result: Record<string, string | boolean | null> = {};
  for (const field of BINDING_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue === undefined) continue;
    if (fieldValue === null) {
      result[field] = null;
    } else if (field === 'inherit') {
      if (typeof fieldValue !== 'boolean') throw new AgentConfigValidationError('binding.inherit must be boolean or null');
      result[field] = fieldValue;
    } else {
      if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0 || fieldValue.length > 1024) {
        throw new AgentConfigValidationError(`binding.${field} must be a non-empty string or null`);
      }
      result[field] = fieldValue;
    }
  }
  return result as BindingPatch;
}

function lineRecords(raw: string): Array<{ text: string; eol: string }> {
  const result: Array<{ text: string; eol: string }> = [];
  let offset = 0;
  while (offset < raw.length) {
    let end = offset;
    while (end < raw.length && raw[end] !== '\r' && raw[end] !== '\n') end += 1;
    let eol = '';
    if (end < raw.length) {
      if (raw[end] === '\r' && raw[end + 1] === '\n') {
        eol = '\r\n';
        end += 2;
      } else {
        eol = raw[end];
        end += 1;
      }
    }
    result.push({ text: raw.slice(offset, eol ? end - eol.length : end), eol });
    offset = end;
  }
  return result;
}

function joinLineRecords(lines: Array<{ text: string; eol: string }>): string {
  return lines.map((line) => line.text + line.eol).join('');
}

function preferredNewline(raw: string): string {
  return raw.includes('\r\n') ? '\r\n' : raw.includes('\r') ? '\r' : '\n';
}

interface TomlLexState {
  mode: 'none' | 'basic' | 'literal' | 'multi-basic' | 'multi-literal';
}

interface LexedLine {
  readonly code: string;
  readonly stateBefore: TomlLexState['mode'];
  readonly stateAfter: TomlLexState['mode'];
}

/** Remove comments while tracking TOML basic/literal multi-line strings. */
function lexTomlLine(line: string, state: TomlLexState['mode']): LexedLine {
  const before = state;
  let mode = state;
  let code = '';
  let i = 0;
  while (i < line.length) {
    if (mode === 'multi-basic' || mode === 'multi-literal') {
      if (mode === 'multi-basic' && line[i] === '\\') {
        if (i + 1 < line.length) {
          code += '  ';
          i += 2;
        } else {
          code += ' ';
          i += 1;
        }
        continue;
      }
      const close = mode === 'multi-basic' ? '"""' : "'''";
      if (line.startsWith(close, i)) {
        code += close;
        i += 3;
        mode = 'none';
      } else {
        code += ' ';
        i += 1;
      }
      continue;
    }
    if (mode === 'basic' || mode === 'literal') {
      const quote = mode === 'basic' ? '"' : "'";
      const character = line[i];
      code += ' ';
      if (mode === 'basic' && character === '\\') {
        if (i + 1 < line.length) {
          code += ' ';
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      i += 1;
      if (character === quote) mode = 'none';
      continue;
    }

    if (line[i] === '#') break;
    if (line.startsWith('"""', i)) {
      code += '   ';
      i += 3;
      mode = 'multi-basic';
    } else if (line.startsWith("'''", i)) {
      code += '   ';
      i += 3;
      mode = 'multi-literal';
    } else if (line[i] === '"') {
      code += ' ';
      i += 1;
      mode = 'basic';
    } else if (line[i] === "'") {
      code += ' ';
      i += 1;
      mode = 'literal';
    } else {
      code += line[i];
      i += 1;
    }
  }
  return { code, stateBefore: before, stateAfter: mode };
}

interface TableBlock {
  readonly section: AgentSection | null;
  readonly name: string | undefined;
  readonly start: number;
  end: number;
  readonly standard: boolean;
}

function standardHeader(code: string): { section: AgentSection; name: string } | undefined {
  const match = /^\s*\[([a-z-]+)\.([a-z0-9]+(?:-[a-z0-9]+)*)\]\s*$/.exec(code);
  if (match === null) return undefined;
  if (!SECTION_NAMES.includes(match[1] as AgentSection)) return undefined;
  if (!isKebabCaseName(match[2])) return undefined;
  return { section: match[1] as AgentSection, name: match[2] };
}

function anyTableHeader(code: string): boolean {
  const trimmed = code.trim();
  return (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function scanTableBlocks(raw: string): { blocks: TableBlock[]; nonStandard: AgentLayoutDiagnostic[] } {
  const lines = lineRecords(raw);
  const blocks: TableBlock[] = [];
  const nonStandard: AgentLayoutDiagnostic[] = [];
  let mode: TomlLexState['mode'] = 'none';
  let current: TableBlock | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const lexed = lexTomlLine(lines[index].text, mode);
    const header = lexed.stateBefore === 'none' && anyTableHeader(lexed.code)
      ? standardHeader(lexed.code)
      : undefined;
    const isHeader = lexed.stateBefore === 'none' && anyTableHeader(lexed.code);
    if (isHeader) {
      if (current !== undefined) current.end = index;
      if (header !== undefined) {
        current = { ...header, start: index, end: lines.length, standard: true };
        blocks.push(current);
      } else {
        current = { section: null, name: undefined, start: index, end: lines.length, standard: false };
        const trimmed = lexed.code.trim();
        const target = /^\[+\s*(subagent|subagent-slot)\./.exec(trimmed);
        if (target !== null) nonStandard.push({ section: target[1], reason: 'non-standard table layout' });
      }
    }
    mode = lexed.stateAfter;
  }
  if (current !== undefined) current.end = lines.length;
  return { blocks, nonStandard };
}

function getOwn(record: Record<string, unknown> | undefined, key: string): unknown {
  if (record === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function bindingRoot(parsed: Record<string, unknown>, section: AgentSection): Record<string, unknown> | undefined {
  const root = getOwn(parsed, section);
  return asRecord(root);
}

function extractTomlBinding(parsedValue: unknown, section: string, name: string, diagnostics: AgentLayoutDiagnostic[]): BindingPatch {
  const record = asRecord(parsedValue);
  if (record === undefined) {
    diagnostics.push({ section, name, reason: 'binding value is not a table' });
    return {};
  }
  for (const field of BINDING_FIELDS) {
    if (getOwn(record, field) === undefined) continue;
    if (scalarBinding(record[field], field) === undefined) {
      diagnostics.push({ section, name, reason: `binding field ${field} is not a simple scalar` });
    }
  }
  return projectBinding(record);
}

interface ScannedToml {
  readonly types: AgentBindingSummary[];
  readonly slots: AgentBindingSummary[];
  readonly diagnostics: AgentLayoutDiagnostic[];
  readonly layout: 'standard' | 'complex';
  readonly blocks: TableBlock[];
  readonly parsed: Record<string, unknown>;
}

function scanToml(raw: string, parsed: Record<string, unknown>): ScannedToml {
  const tableScan = scanTableBlocks(raw);
  const diagnostics = [...tableScan.nonStandard];
  const types: AgentBindingSummary[] = [];
  const slots: AgentBindingSummary[] = [];
  const seen = new Set<string>();

  for (const section of SECTION_NAMES) {
    const root = bindingRoot(parsed, section);
    if (root === undefined) {
      if (getOwn(parsed, section) !== undefined) diagnostics.push({ section, reason: 'section root is not a table' });
      continue;
    }
    for (const [name, value] of Object.entries(root)) {
      const validName = isKebabCaseName(name);
      const matching = tableScan.blocks.filter((block) => block.standard && block.section === section && block.name === name);
      const key = `${section}:${name}`;
      if (!validName) {
        diagnostics.push({ section, name, reason: 'binding name is not kebab-case' });
      }
      if (matching.length !== 1) {
        diagnostics.push({ section, name, reason: matching.length > 1 ? 'duplicate standard tables' : 'inline or dotted table layout' });
      }
      const row: AgentBindingSummary = {
        section,
        name,
        binding: extractTomlBinding(value, section, name, diagnostics),
        layout: matching.length === 1 && validName ? 'standard' : 'complex',
      };
      (section === 'subagent' ? types : slots).push(row);
      seen.add(key);
    }
  }

  for (const block of tableScan.blocks) {
    if (block.section === null || block.name === undefined) continue;
    const key = `${block.section}:${block.name}`;
    if (seen.has(key)) continue;
    // A standard empty table is still a valid binding row.
    const root = bindingRoot(parsed, block.section);
    const value = getOwn(root, block.name) ?? {};
    const row: AgentBindingSummary = {
      section: block.section,
      name: block.name,
      binding: extractTomlBinding(value, block.section, block.name, diagnostics),
      layout: 'standard',
    };
    (block.section === 'subagent' ? types : slots).push(row);
    seen.add(key);
  }

  types.sort((a, b) => a.name.localeCompare(b.name));
  slots.sort((a, b) => a.name.localeCompare(b.name));
  return {
    types,
    slots,
    diagnostics,
    layout: diagnostics.length === 0 ? 'standard' : 'complex',
    blocks: tableScan.blocks,
    parsed,
  };
}

function parseTomlDocument(raw: string): Record<string, unknown> {
  try {
    const parsed = parseToml(raw) as unknown;
    const record = asRecord(parsed);
    if (record === undefined) throw new Error('TOML root must be a table');
    return record;
  } catch (error) {
    if (error instanceof AgentConfigError) throw error;
    throw new AgentConfigValidationError(`local.toml is invalid TOML: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
}

function tomlScalar(value: string | boolean): string {
  return typeof value === 'boolean' ? (value ? 'true' : 'false') : JSON.stringify(value);
}

function valueCommentParts(value: string): { value: string; suffix: string } {
  let mode: 'none' | 'basic' | 'literal' = 'none';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (mode === 'basic') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        mode = 'none';
      }
      continue;
    }
    if (mode === 'literal') {
      if (character === "'") mode = 'none';
      continue;
    }
    if (character === '"') {
      mode = 'basic';
    } else if (character === "'") {
      mode = 'literal';
    } else if (character === '#') {
      const before = value.slice(0, index);
      const trimmed = before.trimEnd();
      return { value: trimmed, suffix: before.slice(trimmed.length) + value.slice(index) };
    }
  }
  const trimmed = value.trimEnd();
  return { value: trimmed, suffix: value.slice(trimmed.length) };
}

function patchSimpleAssignment(line: string, field: BindingField, value: string | boolean | null): string {
  const match = /^(\s*)(model|thinking_effort|inherit)(\s*=\s*)(.*)$/.exec(line);
  if (match === null || match[2] !== field) return line;
  const oldValue = match[4];
  if (/^\s*(?:"""|''')/.test(oldValue)) {
    throw new AgentConfigLayoutError(`structured binding cannot edit multiline ${field}; use raw local.toml`);
  }
  const parts = valueCommentParts(oldValue);
  if (value === null) return parts.suffix.trimStart();
  return `${match[1]}${match[2]}${match[3]}${tomlScalar(value)}${parts.suffix}`;
}

function hasSimpleAssignment(line: string, field: BindingField): boolean {
  return new RegExp(`^\\s*${field}\\s*=`).test(line);
}

function hasDottedAssignment(line: string): boolean {
  const code = lexTomlLine(line, 'none').code;
  return /^\s*[A-Za-z0-9_-]+\s*\./.test(code);
}

function appendBindingTable(raw: string, section: AgentSection, name: string, patch: BindingPatch): string {
  const newline = preferredNewline(raw);
  const lines: string[] = [];
  for (const field of BINDING_FIELDS) {
    const value = patch[field];
    if (value === undefined || value === null) continue;
    lines.push(`${field} = ${tomlScalar(value)}`);
  }
  if (lines.length === 0) return raw;
  const prefix = raw.length > 0 && !/[\r\n]$/.test(raw) ? newline : '';
  return `${raw}${prefix}[${section}.${name}]${newline}${lines.join(newline)}${newline}`;
}

function checkCanDeleteBinding(section: AgentSection, name: string, parsed: Record<string, unknown>): void {
  const root = bindingRoot(parsed, section);
  const value = getOwn(root, name);
  if (value === undefined) return;
  const record = asRecord(value);
  if (record === undefined) {
    throw new AgentConfigLayoutError(`binding ${section}.${name} is not a table; use raw local.toml`);
  }
  for (const key of Object.keys(record)) {
    if (!(BINDING_FIELDS as readonly string[]).includes(key)) {
      throw new AgentConfigLayoutError(`binding ${section}.${name} contains unknown fields; use raw local.toml`);
    }
  }
}

function deleteBindingText(raw: string, section: AgentSection, name: string, scanned: ScannedToml): string {
  checkCanDeleteBinding(section, name, scanned.parsed);
  const targetBlocks = scanned.blocks.filter((block) => block.standard && block.section === section && block.name === name);
  const parsedRoot = bindingRoot(scanned.parsed, section);
  const parsedValue = getOwn(parsedRoot, name);
  if (targetBlocks.length === 0) {
    if (parsedValue !== undefined) {
      throw new AgentConfigLayoutError(`binding ${section}.${name} uses inline or dotted TOML; use raw local.toml`);
    }
    return raw;
  }
  if (targetBlocks.length !== 1) {
    throw new AgentConfigLayoutError(`binding ${section}.${name} has duplicate TOML tables; use raw local.toml`);
  }
  const block = targetBlocks[0];
  const lines = lineRecords(raw);
  lines.splice(block.start, block.end - block.start);
  return joinLineRecords(lines);
}

function validateBindingChange(value: unknown): BindingChange {
  const record = asRecord(value);
  if (record === undefined) throw new AgentConfigValidationError('change must be an object');
  const section = record.section;
  if (section !== 'subagent' && section !== 'subagent-slot') {
    throw new AgentConfigValidationError('section must be subagent or subagent-slot');
  }
  const name = assertKebabName(record.name, 'binding name');
  let binding: BindingPatch | null = null;
  if (record.binding !== null && record.binding !== undefined) {
    binding = validateBindingPatch(record.binding);
  }
  return { section, name, binding };
}

function patchBindingText(raw: string, section: AgentSection, name: string, patch: BindingPatch, scanned: ScannedToml): string {
  const targetBlocks = scanned.blocks.filter((block) => block.standard && block.section === section && block.name === name);
  const parsedRoot = bindingRoot(scanned.parsed, section);
  const parsedValue = getOwn(parsedRoot, name);
  if (targetBlocks.length === 0) {
    if (parsedValue !== undefined) {
      throw new AgentConfigLayoutError(`binding ${section}.${name} uses inline or dotted TOML; use raw local.toml`);
    }
    return appendBindingTable(raw, section, name, patch);
  }
  if (targetBlocks.length !== 1) {
    throw new AgentConfigLayoutError(`binding ${section}.${name} has duplicate TOML tables; use raw local.toml`);
  }
  const block = targetBlocks[0];
  const lines = lineRecords(raw);
  const newline = preferredNewline(raw);
  const found = new Map<BindingField, number>();
  let mode: TomlLexState['mode'] = 'none';
  for (let index = block.start + 1; index < block.end; index += 1) {
    const lexed = lexTomlLine(lines[index].text, mode);
    if (lexed.stateBefore === 'none') {
      for (const field of BINDING_FIELDS) {
        if (hasSimpleAssignment(lexed.code, field)) {
          if (found.has(field)) throw new AgentConfigLayoutError(`binding ${section}.${name} has duplicate ${field}; use raw local.toml`);
          found.set(field, index);
        } else if (hasDottedAssignment(lexed.code) && parsedValue !== undefined) {
          throw new AgentConfigLayoutError(`binding ${section}.${name} uses dotted keys; use raw local.toml`);
        }
      }
    }
    mode = lexed.stateAfter;
  }
  for (const field of BINDING_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const index = found.get(field);
    if (index === undefined) {
      if (value === null) {
        if (asRecord(parsedValue)?.[field] !== undefined) {
          throw new AgentConfigLayoutError(`binding ${section}.${name} has a non-standard ${field}; use raw local.toml`);
        }
        continue;
      }
      const insertion = block.end;
      const newLine = `${field} = ${tomlScalar(value)}`;
      if (insertion === lines.length) {
        if (lines.length > 0 && lines[lines.length - 1].eol === '') lines[lines.length - 1].eol = newline;
        lines.push({ text: newLine, eol: newline });
      } else {
        if (lines[insertion - 1]?.eol === '') lines[insertion - 1].eol = newline;
        lines.splice(insertion, 0, { text: newLine, eol: lines[insertion - 1]?.eol || newline });
      }
      // block.end is no longer used after all insertions; subsequent missing
      // fields are inserted at the end of the same block by searching again.
      const reparsed = scanTableBlocks(joinLineRecords(lines));
      const refreshed = reparsed.blocks.find((candidate) => candidate.standard && candidate.section === section && candidate.name === name);
      if (refreshed !== undefined) block.end = refreshed.end;
      const insertedIndex = lines.findIndex((line, lineIndex) => lineIndex >= block.start + 1 && line.text === newLine && !found.has(field));
      found.set(field, insertedIndex < 0 ? block.end - 1 : insertedIndex);
    }
    const currentIndex = found.get(field);
    if (currentIndex !== undefined) lines[currentIndex].text = patchSimpleAssignment(lines[currentIndex].text, field, value);
  }
  return joinLineRecords(lines);
}

interface ProjectPaths {
  readonly projectRoot: string;
  readonly configDir: string;
  readonly agentsDir: string;
  readonly localToml: string;
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly content: string;
  readonly hash: string | null;
  readonly size: number;
}

export class WorkspaceAgentConfigService {
  private readonly fs: WorkspaceAgentConfigFileSystem;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(fileSystem: WorkspaceAgentConfigFileSystem = nodeFileSystem) {
    this.fs = fileSystem;
  }

  /** Read the complete management summary. */
  async inspect(workspaceCwd: string): Promise<WorkspaceAgentConfigSnapshot> {
    const paths = await this.projectPaths(workspaceCwd);
    const agents = await this.listAgentSummaries(paths);
    const local = await this.readManagedFile(paths.localToml, AGENT_CONFIG_MAX_LOCAL_TOML_BYTES, paths.configDir);
    let bindings: ScannedToml = {
      types: [],
      slots: [],
      diagnostics: [],
      layout: 'standard',
      blocks: [],
      parsed: {},
    };
    if (local.exists) {
      try {
        bindings = scanToml(local.content, parseTomlDocument(local.content));
      } catch (error) {
        if (!(error instanceof AgentConfigValidationError)) throw error;
        bindings = {
          ...bindings,
          layout: 'complex',
          diagnostics: [{ section: LOCAL_TOML_FILE_NAME, reason: error.message }],
        };
      }
    }
    return {
      projectRoot: paths.projectRoot,
      configDir: paths.configDir,
      agentsDir: paths.agentsDir,
      agents,
      bindings: { types: bindings.types, slots: bindings.slots },
      typeBindings: bindings.types,
      slotBindings: bindings.slots,
      layout: local.exists && bindings.diagnostics.length > 0 ? 'complex' : bindings.layout,
      layoutDiagnostics: bindings.diagnostics,
      localToml: { exists: local.exists, hash: local.hash, size: local.size },
    };
  }

  async readAgent(workspaceCwd: string, name: string): Promise<AgentDocument> {
    const agentName = assertKebabName(name, 'agent name');
    const paths = await this.projectPaths(workspaceCwd);
    const fileName = `${agentName}${AGENT_FILE_SUFFIX}`;
    const snapshot = await this.readManagedFile(join(paths.agentsDir, fileName), AGENT_CONFIG_MAX_FILE_BYTES, paths.agentsDir);
    if (!snapshot.exists) throw new AgentConfigNotFoundError('agent profile not found');
    try {
      const parsed = parseAgentDocument(agentName, fileName, snapshot.content);
      return {
        projectRoot: paths.projectRoot,
        name: agentName,
        fileName,
        content: snapshot.content,
        hash: snapshot.hash as string,
        size: snapshot.size,
        ...parsed,
      };
    } catch (error) {
      return {
        projectRoot: paths.projectRoot,
        name: agentName,
        fileName,
        content: snapshot.content,
        hash: snapshot.hash as string,
        size: snapshot.size,
        valid: false,
        error: error instanceof Error ? error.message : 'invalid agent markdown',
      };
    }
  }

  async saveAgent(
    workspaceCwd: string,
    name: string,
    content: string,
    expectedHash: string | null,
  ): Promise<AgentMutationResult> {
    const agentName = assertKebabName(name, 'agent name');
    if (typeof content !== 'string') throw new AgentConfigValidationError('agent content must be a string');
    if (Buffer.byteLength(content, 'utf8') > AGENT_CONFIG_MAX_FILE_BYTES) {
      throw new AgentConfigValidationError(`agent content exceeds ${AGENT_CONFIG_MAX_FILE_BYTES} bytes`);
    }
    parseAgentDocument(agentName, `${agentName}${AGENT_FILE_SUFFIX}`, content);
    const expected = assertExpectedHash(expectedHash);
    const paths = await this.projectPaths(workspaceCwd);
    const fileName = `${agentName}${AGENT_FILE_SUFFIX}`;
    const filePath = join(paths.agentsDir, fileName);
    return this.withPathQueue(filePath, async () => {
      const current = await this.readManagedFile(filePath, AGENT_CONFIG_MAX_FILE_BYTES, paths.agentsDir);
      assertHashPrecondition(expected, current.hash);
      if (current.exists && current.content === content) {
        return { projectRoot: paths.projectRoot, name: agentName, fileName, hash: current.hash as string, size: current.size, content };
      }
      await this.ensureDirectory(paths.configDir, paths.projectRoot);
      await this.ensureDirectory(paths.agentsDir, paths.projectRoot);
      await this.ensureTargetForWrite(filePath, paths.agentsDir, paths.projectRoot);
      await this.atomicWriteWithCas(filePath, content, current.hash, AGENT_CONFIG_MAX_FILE_BYTES);
      return { projectRoot: paths.projectRoot, name: agentName, fileName, hash: contentHash(content), size: Buffer.byteLength(content, 'utf8'), content };
    });
  }

  async deleteAgent(workspaceCwd: string, name: string, expectedHash: string | null): Promise<AgentDeleteResult> {
    const agentName = assertKebabName(name, 'agent name');
    const expected = assertExpectedHash(expectedHash);
    const paths = await this.projectPaths(workspaceCwd);
    const filePath = join(paths.agentsDir, `${agentName}${AGENT_FILE_SUFFIX}`);
    return this.withPathQueue(filePath, async () => {
      const current = await this.readManagedFile(filePath, AGENT_CONFIG_MAX_FILE_BYTES, paths.agentsDir);
      assertHashPrecondition(expected, current.hash);
      if (!current.exists) return { projectRoot: paths.projectRoot, name: agentName, deleted: false, currentHash: null };
      await this.ensureTargetForWrite(filePath, paths.agentsDir, paths.projectRoot);
      const justBefore = await this.readManagedFile(filePath, AGENT_CONFIG_MAX_FILE_BYTES, paths.agentsDir);
      assertSameHash(current.hash, justBefore.hash);
      try {
        await this.fs.unlink(filePath);
      } catch (error) {
        throw mapFileMutationError(error);
      }
      return { projectRoot: paths.projectRoot, name: agentName, deleted: true, currentHash: null };
    });
  }

  async readLocalToml(workspaceCwd: string): Promise<LocalTomlDocument> {
    const paths = await this.projectPaths(workspaceCwd);
    const snapshot = await this.readManagedFile(paths.localToml, AGENT_CONFIG_MAX_LOCAL_TOML_BYTES, paths.configDir);
    return {
      projectRoot: paths.projectRoot,
      exists: snapshot.exists,
      hash: snapshot.hash,
      size: snapshot.size,
      content: snapshot.content,
    };
  }

  async saveLocalToml(workspaceCwd: string, content: string, expectedHash: string | null): Promise<LocalTomlMutationResult> {
    if (typeof content !== 'string') throw new AgentConfigValidationError('local.toml content must be a string');
    if (Buffer.byteLength(content, 'utf8') > AGENT_CONFIG_MAX_LOCAL_TOML_BYTES) {
      throw new AgentConfigValidationError(`local.toml exceeds ${AGENT_CONFIG_MAX_LOCAL_TOML_BYTES} bytes`);
    }
    parseTomlDocument(content);
    const expected = assertExpectedHash(expectedHash);
    const paths = await this.projectPaths(workspaceCwd);
    return this.withPathQueue(paths.localToml, async () => {
      const current = await this.readManagedFile(paths.localToml, AGENT_CONFIG_MAX_LOCAL_TOML_BYTES, paths.configDir);
      assertHashPrecondition(expected, current.hash);
      if (current.exists && current.content === content) {
        return { projectRoot: paths.projectRoot, hash: current.hash as string, size: current.size, content };
      }
      await this.ensureDirectory(paths.configDir, paths.projectRoot);
      await this.ensureTargetForWrite(paths.localToml, paths.configDir, paths.projectRoot);
      await this.atomicWriteWithCas(paths.localToml, content, current.hash, AGENT_CONFIG_MAX_LOCAL_TOML_BYTES);
      return { projectRoot: paths.projectRoot, hash: contentHash(content), size: Buffer.byteLength(content, 'utf8'), content };
    });
  }

  async saveBindings(
    workspaceCwd: string,
    changes: readonly BindingChange[],
    expectedHash: string | null,
  ): Promise<LocalTomlMutationResult> {
    if (!Array.isArray(changes)) throw new AgentConfigValidationError('changes must be an array');
    const validatedChanges = changes.map(validateBindingChange);
    const expected = assertExpectedHash(expectedHash);
    const paths = await this.projectPaths(workspaceCwd);
    return this.withPathQueue(paths.localToml, async () => {
      const current = await this.readManagedFile(paths.localToml, AGENT_CONFIG_MAX_LOCAL_TOML_BYTES, paths.configDir);
      assertHashPrecondition(expected, current.hash);
      let nextContent = current.content;
      for (const change of validatedChanges) {
        const parsed = parseTomlDocument(nextContent);
        const scanned = scanToml(nextContent, parsed);
        if (change.binding === null) {
          nextContent = deleteBindingText(nextContent, change.section, change.name, scanned);
        } else {
          nextContent = patchBindingText(nextContent, change.section, change.name, change.binding, scanned);
        }
      }
      if (Buffer.byteLength(nextContent, 'utf8') > AGENT_CONFIG_MAX_LOCAL_TOML_BYTES) {
        throw new AgentConfigValidationError(`local.toml exceeds ${AGENT_CONFIG_MAX_LOCAL_TOML_BYTES} bytes`);
      }
      parseTomlDocument(nextContent);
      await this.ensureDirectory(paths.configDir, paths.projectRoot);
      await this.ensureTargetForWrite(paths.localToml, paths.configDir, paths.projectRoot);
      if (nextContent !== current.content) {
        await this.atomicWriteWithCas(paths.localToml, nextContent, current.hash, AGENT_CONFIG_MAX_LOCAL_TOML_BYTES);
      }
      const finalHash = contentHash(nextContent);
      return {
        projectRoot: paths.projectRoot,
        hash: finalHash,
        size: Buffer.byteLength(nextContent, 'utf8'),
        content: nextContent,
      };
    });
  }

  async saveBinding(
    workspaceCwd: string,
    section: AgentSection,
    name: string,
    binding: BindingPatch,
    expectedHash: string | null,
  ): Promise<BindingMutationResult> {
    const res = await this.saveBindings(workspaceCwd, [{ section, name, binding }], expectedHash);
    const parsedNext = parseTomlDocument(res.content);
    const scanned = scanToml(res.content, parsedNext);
    const row = (section === 'subagent' ? scanned.types : scanned.slots).find((item) => item.name === name);
    return {
      projectRoot: res.projectRoot,
      section,
      name,
      binding: row?.binding ?? projectBinding(getOwn(bindingRoot(parsedNext, section), name)),
      hash: res.hash,
      content: res.content,
    };
  }

  private async listAgentSummaries(paths: ProjectPaths): Promise<AgentSummary[]> {
    const exists = await this.ensureDirectory(paths.agentsDir, paths.configDir, true);
    if (!exists) return [];
    let entries: Dirent[];
    try {
      entries = await this.fs.readdir(paths.agentsDir, { withFileTypes: true });
    } catch (error) {
      throw mapReadError(error, 'agent directory could not be read');
    }
    const files = entries.filter((entry) => entry.name.endsWith(AGENT_FILE_SUFFIX));
    if (files.length > AGENT_CONFIG_MAX_AGENT_FILES) {
      throw new AgentConfigValidationError(`agent directory exceeds ${AGENT_CONFIG_MAX_AGENT_FILES} files`);
    }
    const result: AgentSummary[] = [];
    for (const entry of files) {
      const name = entry.name.slice(0, -AGENT_FILE_SUFFIX.length);
      if (!isKebabCaseName(name)) {
        throw new AgentConfigValidationError(`agent filename ${entry.name} is not kebab-case`);
      }
      const filePath = join(paths.agentsDir, entry.name);
      const snapshot = await this.readManagedFile(filePath, AGENT_CONFIG_MAX_FILE_BYTES, paths.agentsDir);
      if (!snapshot.exists) continue;
      try {
        const parsed = parseAgentDocument(name, entry.name, snapshot.content);
        result.push({
          name,
          fileName: entry.name,
          hash: snapshot.hash as string,
          size: snapshot.size,
          valid: true,
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          ...(parsed.slot === undefined ? {} : { slot: parsed.slot }),
        });
      } catch (error) {
        result.push({
          name,
          fileName: entry.name,
          hash: snapshot.hash as string,
          size: snapshot.size,
          valid: false,
          error: error instanceof Error ? error.message : 'invalid agent markdown',
        });
      }
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  private async projectPaths(workspaceCwd: string): Promise<ProjectPaths> {
    const cwd = assertWorkspaceCwd(workspaceCwd);
    let canonicalCwd: string;
    try {
      const stat = await this.fs.lstat(cwd);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AgentConfigUnsafePathError('workspace root is not a real directory');
      canonicalCwd = await this.fs.realpath(cwd);
    } catch (error) {
      if (error instanceof AgentConfigError) throw error;
      throw mapReadError(error, 'workspace root could not be inspected');
    }
    const projectRoot = await this.findProjectRoot(canonicalCwd);
    const configDir = join(projectRoot, KIMI_CONFIG_DIRECTORY_NAME);
    return {
      projectRoot,
      configDir,
      agentsDir: join(configDir, AGENT_DIRECTORY_NAME),
      localToml: join(configDir, LOCAL_TOML_FILE_NAME),
    };
  }

  private async findProjectRoot(cwd: string): Promise<string> {
    let current = cwd;
    while (true) {
      const gitPath = join(current, '.git');
      try {
        const stat = await this.fs.lstat(gitPath);
        if (stat.isSymbolicLink()) throw new AgentConfigUnsafePathError('.git is a symbolic link');
        if (stat.isDirectory() || stat.isFile()) return current;
      } catch (error) {
        if (!isMissing(error)) throw mapReadError(error, 'project root could not be inspected');
      }
      const parent = dirname(current);
      if (samePath(parent, current)) return cwd;
      current = parent;
    }
  }

  /**
   * Check an existing path without following a symbolic link. Missing fixed
   * config directories are allowed because a first save may create them.
   */
  private async existingPath(path: string, expected: 'file' | 'directory', allowMissing: boolean, root: string): Promise<boolean> {
    let stat: Stats;
    try {
      stat = await this.fs.lstat(path);
    } catch (error) {
      if (isMissing(error) && allowMissing) return false;
      throw mapReadError(error, 'project configuration path could not be inspected');
    }
    if (stat.isSymbolicLink()) throw new AgentConfigUnsafePathError();
    if (expected === 'file' && !stat.isFile()) throw new AgentConfigUnsafePathError('configuration target is not a regular file');
    if (expected === 'directory' && !stat.isDirectory()) throw new AgentConfigUnsafePathError('configuration parent is not a directory');
    let physical: string;
    try {
      physical = await this.fs.realpath(path);
    } catch (error) {
      throw mapReadError(error, 'project configuration path could not be resolved');
    }
    if (!isInside(root, physical)) throw new AgentConfigUnsafePathError();
    return true;
  }

  private async ensureDirectory(path: string, root: string, allowMissing = false): Promise<boolean> {
    const exists = await this.existingPath(path, 'directory', true, root);
    if (exists || allowMissing) return exists;
    try {
      await this.fs.mkdir(path, { recursive: true });
    } catch (error) {
      throw mapFileMutationError(error);
    }
    await this.existingPath(path, 'directory', false, root);
    return true;
  }

  private async ensureTargetForWrite(path: string, parent: string, root: string): Promise<void> {
    await this.ensureDirectory(parent, root);
    await this.existingPath(path, 'file', true, root);
  }

  private async readManagedFile(path: string, maxBytes: number, parent: string): Promise<FileSnapshot> {
    // The caller has already resolved the project root. The parent check here
    // rejects an existing symlink but permits an absent .kimi-code directory.
    let parentStat: Stats | undefined;
    let parentPhysical: string | undefined;
    try {
      parentStat = await this.fs.lstat(parent);
    } catch (error) {
      if (!isMissing(error)) throw mapReadError(error, 'configuration parent could not be inspected');
    }
    if (parentStat !== undefined) {
      if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new AgentConfigUnsafePathError();
      try { parentPhysical = await this.fs.realpath(parent); } catch (error) { throw mapReadError(error, 'configuration parent could not be resolved'); }
    }

    let stat: Stats;
    try {
      stat = await this.fs.lstat(path);
    } catch (error) {
      if (isMissing(error)) return { exists: false, content: '', hash: null, size: 0 };
      throw mapReadError(error, 'configuration file could not be inspected');
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new AgentConfigUnsafePathError();
    if (stat.size > maxBytes) throw new AgentConfigValidationError(`configuration file exceeds ${maxBytes} bytes`);
    let content: string;
    try {
      content = await this.fs.readFile(path, 'utf8');
    } catch (error) {
      throw mapReadError(error, 'configuration file could not be read');
    }
    const size = Buffer.byteLength(content, 'utf8');
    if (size > maxBytes) throw new AgentConfigValidationError(`configuration file exceeds ${maxBytes} bytes`);
    try {
      const current = await this.fs.lstat(path);
      if (current.isSymbolicLink() || !current.isFile()) throw new AgentConfigUnsafePathError();
      const physical = await this.fs.realpath(path);
      if (parentPhysical !== undefined && !isInside(parentPhysical, physical)) throw new AgentConfigUnsafePathError();
    } catch (error) {
      if (error instanceof AgentConfigError) throw error;
      throw mapReadError(error, 'configuration file changed while reading');
    }
    return { exists: true, content, hash: contentHash(content), size };
  }

  private async atomicWriteWithCas(path: string, content: string, expectedCurrentHash: string | null, maxBytes: number): Promise<void> {
    const atomic = this.fs.writeFileAtomic ?? writeFileAtomic;
    const options: AtomicWriteOptions = {
      beforeRename: async () => {
        const latest = await this.readManagedFile(path, maxBytes, dirname(path));
        assertSameHash(expectedCurrentHash, latest.hash);
      },
    };
    try {
      await atomic(path, content, options);
    } catch (error) {
      if (error instanceof AgentConfigError) throw error;
      throw mapFileMutationError(error);
    }
  }

  private withPathQueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const marker = next.then(() => undefined, () => undefined);
    this.queues.set(path, marker);
    return next.finally(() => {
      if (this.queues.get(path) === marker) this.queues.delete(path);
    });
  }
}

function assertHashPrecondition(expected: string | null, current: string | null): void {
  if (expected !== current) {
    throw new AgentConfigConflictError('configuration changed; reload the latest file before saving', current);
  }
}

function assertSameHash(expected: string | null, current: string | null): void {
  if (expected !== current) {
    throw new AgentConfigConflictError('configuration changed during save; reload the latest file before saving', current);
  }
}

function mapReadError(error: unknown, fallback: string): AgentConfigError {
  if (error instanceof AgentConfigError) return error;
  if (isBusy(error)) return new AgentConfigBusyError();
  const code = errorCode(error);
  if (code === 'ENOENT') return new AgentConfigNotFoundError(fallback);
  return new AgentConfigError(fallback, 400);
}

function mapFileMutationError(error: unknown): AgentConfigError {
  if (error instanceof AgentConfigError) return error;
  if (isBusy(error)) return new AgentConfigBusyError();
  return new AgentConfigError('configuration file could not be written', 400);
}

interface ParsedAgent {
  readonly valid: true;
  readonly frontmatter: Record<string, unknown>;
  readonly prompt: string;
  readonly description?: string;
  readonly slot?: string;
}

function parseAgentDocument(name: string, fileName: string, content: string): ParsedAgent {
  const lines = lineRecords(content);
  if (lines.length === 0 || !/^\s*---\s*$/.test(lines[0].text)) {
    throw new AgentConfigValidationError(`${fileName} must start with YAML frontmatter`);
  }
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (/^\s*---\s*$/.test(lines[index].text)) {
      closing = index;
      break;
    }
  }
  if (closing < 0) throw new AgentConfigValidationError(`${fileName} has unterminated YAML frontmatter`);
  const frontmatterEnd = lines.slice(0, closing).map((line) => line.text + line.eol).join('').replace(/^\s*---\s*(?:\r\n|\n|\r)/, '');
  let frontmatterValue: unknown;
  try {
    frontmatterValue = parseYaml(frontmatterEnd) as unknown;
  } catch (error) {
    throw new AgentConfigValidationError(`${fileName} has invalid YAML frontmatter: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
  const frontmatter = asRecord(frontmatterValue);
  if (frontmatter === undefined) throw new AgentConfigValidationError(`${fileName} frontmatter must be a YAML object`);
  if (frontmatter.name !== name) throw new AgentConfigValidationError(`${fileName} frontmatter name must be ${name}`);
  const prompt = lines.slice(closing + 1).map((line) => line.text + line.eol).join('').trim();
  if (!prompt) throw new AgentConfigValidationError(`${fileName} prompt must not be empty`);
  if (frontmatter.slot !== undefined) assertKebabName(frontmatter.slot, `${fileName} slot`);
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : undefined;
  const slot = typeof frontmatter.slot === 'string' ? frontmatter.slot : undefined;
  return {
    valid: true,
    frontmatter,
    prompt,
    ...(description === undefined ? {} : { description }),
    ...(slot === undefined ? {} : { slot }),
  };
}
