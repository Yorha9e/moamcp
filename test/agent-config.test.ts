import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentConfigConflictError,
  AgentConfigLayoutError,
  AGENT_CONFIG_MAX_AGENT_FILES,
  WorkspaceAgentConfigService,
  contentHash,
} from '../src/modules/agentconfig/agent-config.js';

let home: string;
let project: string;

const agent = (name: string, prompt = 'Review the code carefully.'): string => [
  '---',
  `name: ${name}`,
  'description: A test profile',
  'slot: review-slot',
  '# frontmatter comments survive because the editor saves raw text',
  '---',
  '',
  prompt,
  '',
].join('\r\n');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'moamcp-agent-config-'));
  project = join(home, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('WorkspaceAgentConfigService', () => {
  it('creates, reads, reopens, and deletes a validated Agent Markdown file', async () => {
    const service = new WorkspaceAgentConfigService();
    const content = agent('critic');
    const created = await service.saveAgent(project, 'critic', content, null);
    expect(created.hash).toBe(contentHash(content));
    expect((await service.readAgent(project, 'critic')).content).toBe(content);

    const reopened = new WorkspaceAgentConfigService();
    expect((await reopened.inspect(project)).agents).toMatchObject([
      { name: 'critic', valid: true, slot: 'review-slot' },
    ]);
    const deleted = await reopened.deleteAgent(project, 'critic', created.hash);
    expect(deleted).toMatchObject({ deleted: true, currentHash: null });
    expect((await reopened.inspect(project)).agents).toEqual([]);
  });

  it('serializes same-file mutations and returns the current hash on a CAS conflict', async () => {
    const service = new WorkspaceAgentConfigService();
    const first = await service.saveAgent(project, 'critic', agent('critic', 'one'), null);
    const results = await Promise.allSettled([
      service.saveAgent(project, 'critic', agent('critic', 'two'), first.hash),
      service.saveAgent(project, 'critic', agent('critic', 'three'), first.hash),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(AgentConfigConflictError);
      expect(rejected.reason.currentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('patches standard TOML tables line-by-line and keeps comments, unknown data, CRLF, and multiline strings', async () => {
    const service = new WorkspaceAgentConfigService();
    const raw = [
      '# keep this comment',
      '[subagent.critic]',
      'model = "old/model" # keep this trailing comment',
      'unknown = "do not reorder"',
      'thinking_effort = "low"',
      '',
      '[other]',
      'script = """',
      '[not-a-table] stays inside a multiline string',
      '"""',
      '',
      '[subagent-slot.fast]',
      'model = "fast/model"',
      '',
    ].join('\r\n');
    const created = await service.saveLocalToml(project, raw, null);
    const patched = await service.saveBinding(project, 'subagent', 'critic', { model: 'new/model' }, created.hash);
    expect(patched.content).toContain('model = "new/model" # keep this trailing comment');
    expect(patched.content).toContain('unknown = "do not reorder"');
    expect(patched.content).toContain('[not-a-table] stays inside a multiline string');
    expect(patched.content).toContain('\r\n');
    expect(patched.content).not.toContain('\n\n# keep this comment');
    expect(JSON.parse(JSON.stringify((await service.inspect(project)).bindings.types[0].binding))).toEqual({
      model: 'new/model',
      thinking_effort: 'low',
    });
  });

  it('skips assignment-looking multiline text and preserves a valid separator without a final newline', async () => {
    const service = new WorkspaceAgentConfigService();
    const raw = [
      '[subagent.critic]',
      'description = """',
      'model = "inside the multiline string"',
      '"""',
      'unknown = "keep"',
    ].join('\n');
    const saved = await service.saveLocalToml(project, raw, null);
    const patched = await service.saveBinding(project, 'subagent', 'critic', { model: 'new/model' }, saved.hash);
    expect(patched.content).toContain('model = "inside the multiline string"');
    expect(patched.content).toContain('unknown = "keep"\nmodel = "new/model"\n');
  });

  it('rejects inline/dotted structured layouts but accepts the validated raw editor escape hatch', async () => {
    const service = new WorkspaceAgentConfigService();
    const raw = '[subagent]\ncritic = { model = "inline/model", thinking_effort = "high" }\n';
    const saved = await service.saveLocalToml(project, raw, null);
    await expect(service.saveBinding(project, 'subagent', 'critic', { model: 'new/model' }, saved.hash))
      .rejects.toBeInstanceOf(AgentConfigLayoutError);

    const rawEdited = '[subagent]\ncritic = { model = "raw/model", thinking_effort = "low" }\n';
    const result = await service.saveLocalToml(project, rawEdited, saved.hash);
    expect(result.content).toBe(rawEdited);
    expect((await service.inspect(project)).layout).toBe('complex');
  });

  it('rejects symlinked fixed config paths instead of following them', async () => {
    const outside = join(home, 'outside');
    await mkdir(outside);
    await symlink(outside, join(project, '.kimi-code'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(new WorkspaceAgentConfigService().inspect(project)).rejects.toThrow(/symbolic link|unsafe/i);
  });

  it('enforces the Agent count cap', async () => {
    const agentsDir = join(project, '.kimi-code', 'agents');
    await mkdir(agentsDir, { recursive: true });
    for (let index = 0; index <= AGENT_CONFIG_MAX_AGENT_FILES; index += 1) {
      const name = `agent-${String(index).padStart(3, '0')}`;
      await writeFile(join(agentsDir, `${name}.md`), agent(name));
    }
    await expect(new WorkspaceAgentConfigService().inspect(project)).rejects.toThrow(/exceeds/);
  });

  it('detects a last-moment external replacement before rename', async () => {
    const service = new WorkspaceAgentConfigService();
    const first = await service.saveAgent(project, 'critic', agent('critic', 'first'), null);
    const file = join(project, '.kimi-code', 'agents', 'critic.md');
    await writeFile(file, agent('critic', 'external'));
    await expect(service.saveAgent(project, 'critic', agent('critic', 'mine'), first.hash))
      .rejects.toBeInstanceOf(AgentConfigConflictError);
    expect((await readFile(file, 'utf8')).includes('external')).toBe(true);
  });

  it('handles TOML multi-basic string backslash escaping without misidentifying escaped quotes as string end', async () => {
    const service = new WorkspaceAgentConfigService();
    const raw = [
      '[subagent.critic]',
      'model = "old/model"',
      '',
      '[other]',
      'script = """',
      'hello \\""" world',
      'model = "fake"',
      '[subagent.fake]',
      '"""',
      '',
    ].join('\n');
    const saved = await service.saveLocalToml(project, raw, null);
    const patched = await service.saveBindings(project, [{ section: 'subagent', name: 'critic', binding: { model: 'new/model' } }], saved.hash);
    expect(patched.content).toContain('model = "new/model"');
    expect(patched.content).toContain('hello \\""" world');
    expect(patched.content).toContain('model = "fake"');
    expect(patched.content).toContain('[subagent.fake]');
  });

  it('supports batch binding mutations with atomic transaction semantics', async () => {
    const service = new WorkspaceAgentConfigService();
    const raw = '[subagent.critic]\nmodel = "v1"\n\n[subagent-slot.fast]\nmodel = "f1"\n';
    const saved = await service.saveLocalToml(project, raw, null);

    const batchRes = await service.saveBindings(project, [
      { section: 'subagent', name: 'critic', binding: { model: 'v2' } },
      { section: 'subagent-slot', name: 'fast', binding: { model: 'f2' } },
    ], saved.hash);
    expect(batchRes.content).toContain('model = "v2"');
    expect(batchRes.content).toContain('model = "f2"');

    const beforeContent = batchRes.content;
    await expect(service.saveBindings(project, [
      { section: 'subagent', name: 'critic', binding: { model: 'v3' } },
      { section: 'subagent' as any, name: 'invalid-name-!@#$', binding: { model: 'v3' } },
    ], batchRes.hash)).rejects.toThrow();

    const currentLocal = await service.readLocalToml(project);
    expect(currentLocal.content).toBe(beforeContent);
    expect(currentLocal.content).toContain('model = "v2"');
    expect(currentLocal.content).not.toContain('model = "v3"');
  });

  it('deletes standard binding tables when binding is null, but rejects deletion when unknown fields exist', async () => {
    const service = new WorkspaceAgentConfigService();
    const raw = [
      '[subagent.critic]',
      'model = "std/model"',
      '',
      '[subagent.custom]',
      'model = "custom/model"',
      'unknown_field = "keep"',
      '',
    ].join('\n');
    const saved = await service.saveLocalToml(project, raw, null);

    await expect(service.saveBindings(project, [
      { section: 'subagent', name: 'custom', binding: null },
    ], saved.hash)).rejects.toThrow(/unknown fields; use raw local.toml/);

    const deletedRes = await service.saveBindings(project, [
      { section: 'subagent', name: 'critic', binding: null },
    ], saved.hash);
    expect(deletedRes.content).not.toContain('[subagent.critic]');
    expect(deletedRes.content).toContain('[subagent.custom]');
    expect(deletedRes.content).toContain('unknown_field = "keep"');
  });

  it('supports legitimate binding name constructor', async () => {
    const service = new WorkspaceAgentConfigService();
    const saved = await service.saveLocalToml(project, '', null);
    const patched = await service.saveBindings(project, [
      { section: 'subagent', name: 'constructor', binding: { model: 'ctor-model' } },
    ], saved.hash);
    expect(patched.content).toContain('[subagent.constructor]');
    expect(patched.content).toContain('model = "ctor-model"');

    const summary = await service.inspect(project);
    expect(summary.typeBindings.some((b) => b.name === 'constructor')).toBe(true);

    const deleted = await service.saveBindings(project, [
      { section: 'subagent', name: 'constructor', binding: null },
    ], patched.hash);
    expect(deleted.content).not.toContain('[subagent.constructor]');
  });

  it('returns valid:false on readAgent for corrupt frontmatter, rejects corrupt save, and allows saving fixed content', async () => {
    const service = new WorkspaceAgentConfigService();
    const corruptContent = '---\nname: corrupt\ninvalid: : : yaml\n---\nPrompt content';
    const agentsDir = join(project, '.kimi-code', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, 'corrupt.md'), corruptContent);

    const doc = await service.readAgent(project, 'corrupt');
    expect(doc.valid).toBe(false);
    expect(doc.error).toBeDefined();
    expect(doc.content).toBe(corruptContent);
    expect(doc.hash).toBe(contentHash(corruptContent));

    // Saving corrupt content still fails validation
    await expect(service.saveAgent(project, 'corrupt', corruptContent, doc.hash))
      .rejects.toThrow(/invalid YAML frontmatter/);

    // Saving fixed content succeeds
    const fixedContent = agent('corrupt', 'Fixed prompt content');
    const saved = await service.saveAgent(project, 'corrupt', fixedContent, doc.hash);
    expect(saved.hash).toBe(contentHash(fixedContent));

    const reRead = await service.readAgent(project, 'corrupt');
    expect(reRead.valid).toBe(true);
    expect(reRead.content).toBe(fixedContent);
  });

  it('enforces 48KiB max size limits on agent and local.toml files', async () => {
    const service = new WorkspaceAgentConfigService();
    const oversizedAgent = agent('large', 'x'.repeat(48 * 1024));
    await expect(service.saveAgent(project, 'large', oversizedAgent, null))
      .rejects.toThrow(/agent content exceeds 49152 bytes/);

    const oversizedToml = '[subagent.large]\nmodel = "' + 'x'.repeat(48 * 1024) + '"';
    await expect(service.saveLocalToml(project, oversizedToml, null))
      .rejects.toThrow(/local.toml exceeds 49152 bytes/);
  });
});
