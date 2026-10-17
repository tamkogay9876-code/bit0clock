/**
 * Tests for type definitions (compile-time checks)
 */

import { describe, it, expect } from 'bun:test';
import type {
  ProviderType,
  ApiProtocol,
  MessageRole,
  AgentMode,
  ReasoningEffort,
  PermissionClass,
  ErrorCategory,
  DiagnosticStatus,
  StreamEventType,
} from './index.js';

describe('Types', () => {
  it('should have valid ProviderType values', () => {
    const types: ProviderType[] = ['openai-compatible', 'anthropic-compatible', 'xkiro'];
    expect(types.length).toBe(3);
  });

  it('should have valid ApiProtocol values', () => {
    const protocols: ApiProtocol[] = ['openai-chat', 'anthropic-messages'];
    expect(protocols.length).toBe(2);
  });

  it('should have valid MessageRole values', () => {
    const roles: MessageRole[] = ['system', 'user', 'assistant', 'tool'];
    expect(roles.length).toBe(4);
  });

  it('should have valid AgentMode values', () => {
    const modes: AgentMode[] = ['plan', 'build', 'review'];
    expect(modes.length).toBe(3);
  });

  it('should have valid ReasoningEffort values', () => {
    const efforts: ReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max', 'auto'];
    expect(efforts.length).toBe(6);
  });

  it('should have valid PermissionClass values', () => {
    const classes: PermissionClass[] = [
      'read',
      'write',
      'execute',
      'network',
      'mcp',
      'config',
      'git',
    ];
    expect(classes.length).toBe(7);
  });

  it('should have valid ErrorCategory values', () => {
    const categories: ErrorCategory[] = [
      'authentication',
      'invalid-model',
      'missing-capability',
      'insufficient-quota',
      'rate-limit',
      'context-overflow',
      'output-limit',
      'network',
      'server',
      'tool-validation',
      'timeout',
      'cancellation',
      'permission-denied',
      'path-traversal',
      'credential-not-found',
      'config-invalid',
      'storage-error',
      'unknown',
    ];
    expect(categories.length).toBe(18);
  });

  it('should have valid DiagnosticStatus values', () => {
    const statuses: DiagnosticStatus[] = [
      'healthy',
      'degraded',
      'unavailable',
      'not-configured',
      'not-verified',
      'blocked',
    ];
    expect(statuses.length).toBe(6);
  });

  it('should have valid StreamEventType values', () => {
    const eventTypes: StreamEventType[] = [
      'response-started',
      'text-delta',
      'reasoning-metadata',
      'tool-call-started',
      'tool-call-arguments',
      'tool-call-completed',
      'usage-updated',
      'response-completed',
      'error',
      'cancelled',
    ];
    expect(eventTypes.length).toBe(10);
  });
});
