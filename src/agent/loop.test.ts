/**
 * Agent loop tests (§44): tool execution, permissions, iteration bounds,
 * cancellation, request assembly, and conversation protocol validity.
 *
 * All provider traffic is mocked deterministically — no network is used.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAgentTurn, type AgentEvent } from './loop.js';
import { createTestApp, seedModels, testProvider } from '../app/test-utils.js';
import { mockFetch, openaiSSE, sseResponse } from '../providers/test-utils.js';
import { defaultConfig } from '../config/schema.js';
import type { FetchLike } from '../providers/types.js';

// ============================================================================
// SSE script builders
// ============================================================================

function textChunks(text: string): string[] {
  return openaiSSE([
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]);
}

function toolCallChunks(
  calls: Array<{ id: string; name: string; args?: Record<string, unknown>; raw?: string }>,
): string[] {
  return openaiSSE([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: {
                name: call.name,
                arguments: call.raw ?? JSON.stringify(call.args ?? {}),
              },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
}

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'mediaxg-loop-'));
}

async function makeApp(
  fetchImpl: FetchLike,
  options: { projectPath: string; interactive?: boolean; autoApprove?: boolean },
) {
  const test = createTestApp({
    providers: [testProvider()],
    catalog: { test: seedModels() },
    fetchImpl,
    projectPath: options.projectPath,
    interactive: options.interactive ?? false,
    autoApprove: options.autoApprove ?? false,
  });
  await test.credentials.set('TEST_API_KEY', 'key');
  test.app.selectModel('test', 'vendor/alpha-model');
  return test;
}

function bodyOf(mock: { calls: Array<{ init: RequestInit }> }, index: number): Record<string, any> {
  return JSON.parse(String(mock.calls[index]!.init.body)) as Record<string, any>;
}

function toolNamesIn(body: Record<string, any>): string[] {
  const tools = (body['tools'] ?? []) as Array<Record<string, any>>;
  return tools.map((entry) => entry['function']?.['name'] ?? entry['name']);
}

// ============================================================================
// Tests
// ============================================================================

describe('runAgentTurn — tool execution', () => {
  it('executes a tool call and continues to a final answer', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'hello.txt'), 'file contents here\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'call_1', name: 'read_file', args: { path: 'hello.txt' } }]),
      ),
      sseResponse(textChunks('The file says hello.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    const events: AgentEvent[] = [];
    const result = await runAgentTurn(app, 'Read hello.txt', {
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.cancelled).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.text).toBe('The file says hello.');

    expect(result.toolCallRecords).toHaveLength(1);
    expect(result.toolCallRecords[0]?.name).toBe('read_file');
    expect(result.toolCallRecords[0]?.isError).toBe(false);
    expect(result.toolCallRecords[0]?.result).toContain('file contents here');

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain('iteration-started');
    expect(eventTypes).toContain('tool-started');
    expect(eventTypes.filter((type) => type === 'tool-finished')).toHaveLength(1);
    expect(eventTypes.at(-1)).toBe('completed');

    // Conversation is protocol-valid for the provider
    expect(app.session.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    const assistantWithCall = app.session.messages[1]!;
    expect(assistantWithCall.toolCalls?.[0]?.id).toBe('call_1');
    const toolMessage = app.session.messages[2]!;
    expect(toolMessage.toolResults?.[0]?.toolCallId).toBe('call_1');
    expect(toolMessage.toolResults?.[0]?.isError).toBe(false);

    // Session history recorded the tool call
    expect(app.session.toolHistory).toHaveLength(1);
    expect(app.session.toolHistory?.[0]?.name).toBe('read_file');

    // First request attached native tools + tool rules in the system prompt
    const first = bodyOf(mock, 0);
    expect(toolNamesIn(first)).toContain('read_file');
    expect(toolNamesIn(first)).toContain('edit_file');
    const systemMessage = first['messages'].find(
      (message: Record<string, any>) => message['role'] === 'system',
    );
    expect(systemMessage['content']).toContain('native tools');

    // Second request carried the tool result back to the model
    const second = bodyOf(mock, 1);
    const toolResultMessage = second['messages'].find(
      (message: Record<string, any>) => message['role'] === 'tool',
    );
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage['tool_call_id']).toBe('call_1');
    expect(String(toolResultMessage['content'])).toContain('file contents here');
  });

  it('injects contextPreamble and instruction files into the system prompt', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'MEDIAXG.md'), 'PROJECT RULE: always run tests');

    const mock = mockFetch([sseResponse(textChunks('ok'))]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    await runAgentTurn(app, 'hi', { contextPreamble: 'PREAMBLE_MARK_42' });

    const body = bodyOf(mock, 0);
    const systemMessage = body['messages'].find(
      (message: Record<string, any>) => message['role'] === 'system',
    );
    const system = String(systemMessage['content']);
    expect(system).toContain('PREAMBLE_MARK_42');
    expect(system).toContain('PROJECT RULE: always run tests');
    expect(system).toContain('LOWER TRUST');
  });

  it('omits the tools field when the model does not support tools', async () => {
    const workspace = makeWorkspace();
    const models = seedModels();
    const firstModel = { ...models[0]!, tools: false };

    const mock = mockFetch([sseResponse(textChunks('plain answer'))]);
    const test = createTestApp({
      providers: [testProvider()],
      catalog: { test: [firstModel] },
      fetchImpl: mock.fetchImpl,
      projectPath: workspace,
    });
    await test.credentials.set('TEST_API_KEY', 'key');
    test.app.selectModel('test', 'vendor/alpha-model');

    const result = await runAgentTurn(test.app, 'hi');
    expect(result.text).toBe('plain answer');

    const body = bodyOf(mock, 0);
    expect(body['tools']).toBeUndefined();
    const systemMessage = body['messages'].find(
      (message: Record<string, any>) => message['role'] === 'system',
    );
    expect(String(systemMessage['content'])).not.toContain('You have native tools');
  });

  it('rejects turns without an active model', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([sseResponse(textChunks('nope'))]);
    const test = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl: mock.fetchImpl,
      projectPath: workspace,
    });

    await expect(runAgentTurn(test.app, 'hi')).rejects.toThrow(/No model selected/);
  });
});

describe('runAgentTurn — permissions', () => {
  it('executes write tools after interactive approval and records the audit', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'target.txt'), 'delete me\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'call_del', name: 'delete_file', args: { path: 'target.txt' } }]),
      ),
      sseResponse(textChunks('Deleted.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace, interactive: true });

    const prompts: string[] = [];
    const result = await runAgentTurn(app, 'Delete target.txt', {
      onPermissionRequest: async (request) => {
        prompts.push(request.summary);
        return { decision: 'allow' };
      },
    });

    expect(prompts).toEqual(['DELETE target.txt']);
    expect(existsSync(join(workspace, 'target.txt'))).toBe(false);
    expect(result.toolCallRecords[0]?.isError).toBe(false);
    expect(app.session.permissionAudit).toHaveLength(1);
    expect(app.session.permissionAudit?.[0]?.decision).toBe('approved-once');
  });

  it('records session-wide approvals from allow-session', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'target.txt'), 'delete me\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'c1', name: 'delete_file', args: { path: 'target.txt' } }]),
      ),
      sseResponse(textChunks('done')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace, interactive: true });

    await runAgentTurn(app, 'go', {
      onPermissionRequest: async () => ({ decision: 'allow-session' }),
    });

    expect(app.permissions.approvalCount()).toBe(1);
    expect(app.permissions.activeApprovalKeys()).toEqual(['delete_file']);
    expect(app.session.permissionAudit?.[0]?.decision).toBe('approved-session');
  });

  it('denies consequential tools in non-interactive runs and audits the denial', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'target.txt'), 'keep me\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'c1', name: 'delete_file', args: { path: 'target.txt' } }]),
      ),
      sseResponse(textChunks('I cannot delete that without approval.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    const result = await runAgentTurn(app, 'Delete target.txt');

    expect(existsSync(join(workspace, 'target.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'target.txt'), 'utf8')).toBe('keep me\n');
    expect(result.toolCallRecords[0]?.isError).toBe(true);
    expect(result.toolCallRecords[0]?.result).toContain('Permission denied');
    expect(app.session.permissionAudit).toHaveLength(1);
    expect(app.session.permissionAudit?.[0]?.decision).toBe('deny');
  });

  it('treats a user denial as an error result and stops retrying', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'target.txt'), 'keep me\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'c1', name: 'delete_file', args: { path: 'target.txt' } }]),
      ),
      sseResponse(textChunks('Understood.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace, interactive: true });

    const result = await runAgentTurn(app, 'go', {
      onPermissionRequest: async () => ({ decision: 'deny' }),
    });

    expect(existsSync(join(workspace, 'target.txt'))).toBe(true);
    expect(result.toolCallRecords[0]?.result).toContain('denied by the user');
    expect(app.session.permissionAudit?.[0]?.decision).toBe('deny');
  });

  it('keeps plan mode read-only even when the model requests a write', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'target.txt'), 'keep me\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([{ id: 'c1', name: 'delete_file', args: { path: 'target.txt' } }]),
      ),
      sseResponse(textChunks('Plan mode cannot delete.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, {
      projectPath: workspace,
      autoApprove: true,
    });
    app.setMode('plan');

    const result = await runAgentTurn(app, 'delete it');

    expect(existsSync(join(workspace, 'target.txt'))).toBe(true);
    expect(result.toolCallRecords[0]?.result).toContain('read-only');

    // Read-only modes never advertise mutating tools
    const body = bodyOf(mock, 0);
    const names = toolNamesIn(body);
    expect(names).not.toContain('delete_file');
    expect(names).toContain('read_file');
    expect(names).toContain('run_command');
  });
});

describe('runAgentTurn — invalid and unknown calls', () => {
  it('returns an error result for unknown tools without executing anything', async () => {
    const mock = mockFetch([
      sseResponse(toolCallChunks([{ id: 'c1', name: 'not_a_tool', args: {} }])),
      sseResponse(textChunks('I used a tool that does not exist.')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: makeWorkspace() });

    const result = await runAgentTurn(app, 'go');

    expect(result.toolCallRecords).toHaveLength(1);
    expect(result.toolCallRecords[0]?.isError).toBe(true);
    expect(result.toolCallRecords[0]?.result).toContain('Unknown tool: not_a_tool');
  });

  it('reports invalid arguments without execution', async () => {
    const workspace = makeWorkspace();
    const mock = mockFetch([
      sseResponse(toolCallChunks([{ id: 'c1', name: 'read_file', args: {} }])),
      sseResponse(textChunks('ok')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    const result = await runAgentTurn(app, 'go');

    expect(result.toolCallRecords[0]?.isError).toBe(true);
    expect(result.toolCallRecords[0]?.result).toContain('Invalid arguments for read_file');
  });

  it('never executes partially streamed (malformed) tool arguments', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'hello.txt'), 'data\n');

    const mock = mockFetch([
      sseResponse(toolCallChunks([{ id: 'c1', name: 'read_file', raw: '{"path": "hel' }])),
      sseResponse(textChunks('recovered')),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    const result = await runAgentTurn(app, 'go');

    expect(result.toolCallRecords).toHaveLength(1);
    expect(result.toolCallRecords[0]?.isError).toBe(true);
    expect(result.toolCallRecords[0]?.result).toContain('Invalid tool call arguments');

    // Protocol-valid: the recorded call still has a matching tool result
    const toolMessage = app.session.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.toolResults?.[0]?.toolCallId).toBe('c1');
  });
});

describe('runAgentTurn — bounds and cancellation', () => {
  it('stops at the iteration limit and persists an explicit note', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'hello.txt'), 'data\n');

    const mock = mockFetch([
      sseResponse(toolCallChunks([{ id: 'c1', name: 'read_file', args: { path: 'hello.txt' } }])),
      sseResponse(toolCallChunks([{ id: 'c2', name: 'read_file', args: { path: 'hello.txt' } }])),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    const result = await runAgentTurn(app, 'keep reading', { maxIterations: 2 });

    expect(result.exhausted).toBe(true);
    expect(result.iterations).toBe(2);
    expect(mock.calls).toHaveLength(2);

    const lastMessage = app.session.messages.at(-1)!;
    expect(lastMessage.role).toBe('system');
    expect(lastMessage.content).toContain('iteration limit');
  });

  it('cancels during streaming and keeps partial output', async () => {
    const mock = mockFetch([sseResponse(textChunks('partial answer'))]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: makeWorkspace() });

    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn(app, 'say something', {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'text-delta') controller.abort();
      },
    });

    // The abort may surface as cancellation or as a stream error depending on
    // where it lands mid-stream; both paths keep the partial text and message.
    expect(app.session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const assistant = app.session.messages[1]!;
    expect(assistant.content).toBe('partial answer');
    expect(assistant.error).toContain('Cancelled');
    expect(result.cancelled).toBe(true);
    expect(events.some((event) => event.type === 'cancelled')).toBe(true);

    // The loop always closes with a `completed` summary event for observers.
    expect(events.at(-1)?.type).toBe('completed');
  });

  it('appends cancelled tool results so the conversation stays protocol-valid', async () => {
    const workspace = makeWorkspace();
    writeFileSync(join(workspace, 'hello.txt'), 'data\n');

    const mock = mockFetch([
      sseResponse(
        toolCallChunks([
          { id: 'c1', name: 'read_file', args: { path: 'hello.txt' } },
          { id: 'c2', name: 'read_file', args: { path: 'hello.txt' } },
        ]),
      ),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: workspace });

    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const result = await runAgentTurn(app, 'read twice', {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'tool-started') controller.abort();
      },
    });

    expect(result.cancelled).toBe(true);
    expect(mock.calls).toHaveLength(1); // no further provider requests

    const assistant = app.session.messages[1]!;
    expect(assistant.toolCalls?.map((call) => call.id)).toEqual(['c1', 'c2']);

    const toolMessage = app.session.messages[2]!;
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.toolResults?.map((entry) => entry.toolCallId)).toEqual(['c1', 'c2']);
    expect(toolMessage.toolResults?.every((entry) => entry.isError)).toBe(true);
    expect(String(toolMessage.toolResults?.[1]?.content)).toContain('Cancelled by the user');

    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.at(-1)?.type).toBe('completed');
  });
});

describe('runAgentTurn — context pipeline integration (§23–§30)', () => {
  it('emits context-prepared, persists the report, and counts the estimated input', async () => {
    const mock = mockFetch([sseResponse(textChunks('ready'))]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: makeWorkspace() });

    const events: AgentEvent[] = [];
    await runAgentTurn(app, 'hello there', {
      onEvent: (event) => {
        events.push(event);
      },
    });

    const contextEvent = events.find((event) => event.type === 'context-prepared');
    expect(contextEvent).toBeDefined();
    if (contextEvent?.type === 'context-prepared') {
      expect(contextEvent.gateAction).toBe('allow');
      expect(contextEvent.effectiveBudget).toBe(128_000 - 8_000 - 4_000);
      expect(contextEvent.estimatedInputTokens).toBeGreaterThan(0);
      expect(contextEvent.omittedMessages).toBe(0);
      expect(contextEvent.compactedMessages).toBe(0);
      expect(app.session.lastContextReport?.estimatedInputTokens).toBe(
        contextEvent.estimatedInputTokens,
      );
    }
    expect(app.session.usage.estimatedInputTokens).toBeGreaterThan(0);
    // No provider-reported input yet
    expect(app.session.usage.inputTokens).toBe(0);
  });

  it('records a calibration observation when the provider reports usage', async () => {
    const mock = mockFetch([
      sseResponse(
        openaiSSE([
          { choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5000, completion_tokens: 10 },
          },
          '[DONE]',
        ]),
      ),
    ]);
    const { app } = await makeApp(mock.fetchImpl, { projectPath: makeWorkspace() });

    const events: AgentEvent[] = [];
    await runAgentTurn(app, 'hello', {
      onEvent: (event) => {
        events.push(event);
      },
    });

    const estimate = events.find((event) => event.type === 'context-prepared');
    expect(estimate).toBeDefined();
    if (estimate?.type !== 'context-prepared') throw new Error('unreachable');

    const factor = app.calibration.factorFor('test', 'vendor/alpha-model');
    expect(factor).not.toBeNull();
    expect(factor!.factor).toBeCloseTo(5000 / estimate.estimatedInputTokens, 4);
    expect(factor!.samples).toBe(1);

    expect(app.session.usage.inputTokens).toBe(5000);
    expect(app.session.usage.outputTokens).toBe(10);
    expect(app.session.usage.requests).toBe(1);
    expect(app.session.usage.estimatedCost).toBeGreaterThan(0);
  });

  it('asks for budget confirmation and proceeds when approved', async () => {
    const mock = mockFetch([sseResponse(textChunks('confirmed and done'))]);
    const test = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl: mock.fetchImpl,
      projectPath: makeWorkspace(),
      configOverrides: {
        spendingLimits: {
          ...defaultConfig.spendingLimits,
          largeContextConfirmationThreshold: 1000,
        },
      },
    });
    await test.credentials.set('TEST_API_KEY', 'key');
    test.app.selectModel('test', 'vendor/alpha-model');

    let asked = false;
    const events: AgentEvent[] = [];
    const result = await runAgentTurn(test.app, 'hello', {
      onBudgetConfirm: async (decision) => {
        asked = true;
        expect(decision.action).toBe('confirm');
        return true;
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(asked).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('confirmed and done');
    const contextEvent = events.find((event) => event.type === 'context-prepared');
    expect(contextEvent?.type === 'context-prepared' && contextEvent.gateAction).toBe('confirm');
    expect(mock.calls).toHaveLength(1);
  });

  it('a blocked budget gate ends the turn with an error and sends nothing', async () => {
    const mock = mockFetch([]);
    const test = createTestApp({
      providers: [testProvider()],
      catalog: { test: seedModels() },
      fetchImpl: mock.fetchImpl,
      projectPath: makeWorkspace(),
      configOverrides: {
        spendingLimits: { ...defaultConfig.spendingLimits, maxPerRequest: 0.000001 },
      },
    });
    await test.credentials.set('TEST_API_KEY', 'key');
    test.app.selectModel('test', 'vendor/alpha-model');

    const events: AgentEvent[] = [];
    const result = await runAgentTurn(test.app, 'hello', {
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(mock.calls).toHaveLength(0); // nothing was sent
    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('budget gate blocked');
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)?.type).toBe('completed');
    expect(test.app.session.usage.estimatedInputTokens).toBe(0);
  });
});
