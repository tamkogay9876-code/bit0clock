/**
 * Native tool registry (§40).
 *
 * Single place where tools are registered with their schemas, permission
 * classes, timeouts, and output budgets. No other module hard-codes tool
 * names or definitions.
 */

import { MODES } from '../modes/index.js';
import type { AgentMode } from '../types/index.js';
import type { ToolSchema } from '../providers/types.js';
import type { RegisteredTool } from './types.js';
import { createFsTools } from './fs-tools.js';
import { createWriteTools, type ChangeJournal } from './write-tools.js';
import { createExecTools } from './exec-tools.js';
import { createGitTools } from './git-tools.js';
import { createPlanTools, type PlanStore } from './plan-tools.js';
import type { WorkspacePaths } from './paths.js';
import type { ChangeRecord } from './ledger.js';

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names(): string[] {
    return this.list().map((tool) => tool.name);
  }

  /**
   * Tools attachable in a mode. Read-only modes keep read-only tools and
   * tools with per-call classification (run_command decides per call);
   * statically mutating tools are not offered at all.
   */
  availableForMode(mode: AgentMode): RegisteredTool[] {
    if (!MODES[mode].readOnly) return this.list();
    return this.list().filter(
      (tool) => !tool.mutating || tool.dynamicPermissionClass !== undefined,
    );
  }

  providerToolsForMode(mode: AgentMode): ToolSchema[] {
    return this.availableForMode(mode).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}

export interface ToolRegistryOptions {
  paths: WorkspacePaths;
  changeJournal: ChangeJournal;
  /** Plan storage (update_plan tool); omit to disable the tool */
  planStore?: PlanStore;
  /** Session ledger accessor for the non-git diff fallback */
  ledgerRecords?: () => ChangeRecord[];
}

export function createDefaultToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const registry = new ToolRegistry();
  const { paths, changeJournal } = options;

  registry.registerAll(createFsTools(paths));
  registry.registerAll(createWriteTools(paths, changeJournal));
  registry.registerAll(createExecTools(paths));
  registry.registerAll(createGitTools(paths, options.ledgerRecords ?? (() => [])));
  if (options.planStore) {
    registry.registerAll(createPlanTools(options.planStore));
  }

  return registry;
}
