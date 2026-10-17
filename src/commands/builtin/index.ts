/**
 * Built-in command registration.
 *
 * Every command registered here has a working handler and a real error
 * path. Commands whose subsystems are not implemented yet are deliberately
 * NOT registered — the spec forbids adding commands merely to appear
 * feature-rich.
 */

import type { AppState } from '../../app/state.js';
import type { CommandRegistry } from '../registry.js';
import { createSystemCommands } from './system.js';
import { createProviderCommands } from './providers.js';
import { createModelCommands } from './models.js';
import { createModeCommands } from './modes.js';
import { createReasoningCommands } from './reasoning.js';
import { createSessionCommands } from './sessions.js';
import { createContextCommands } from './context.js';
import { createCompactCommands } from './compact.js';
import { createSkillCommands } from './skills.js';
import { createMemoryCommands } from './memory.js';
import { createMcpCommands } from './mcp.js';
import { createWorkspaceCommands } from './workspace.js';
import { createTestingCommands } from './testing.js';
import { createReviewCommands } from './review.js';
import { createPlanCommands } from './plan.js';
import { createPermissionCommands } from './permissions.js';

export function registerBuiltinCommands(registry: CommandRegistry, app: AppState): void {
  registry.registerAll([
    ...createSystemCommands(app, registry),
    ...createProviderCommands(app),
    ...createModelCommands(app),
    ...createModeCommands(app),
    ...createReasoningCommands(app),
    ...createSessionCommands(app),
    ...createContextCommands(app),
    ...createCompactCommands(app),
    ...createSkillCommands(app),
    ...createMemoryCommands(app),
    ...createMcpCommands(app),
    ...createWorkspaceCommands(app),
    ...createTestingCommands(app),
    ...createReviewCommands(app),
    ...createPlanCommands(app),
    ...createPermissionCommands(app),
  ]);
}
