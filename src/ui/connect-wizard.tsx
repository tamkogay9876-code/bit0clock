/** Provider connection wizard view. */

import React from 'react';
import { Box, Text } from 'ink';
import type { ProviderType } from '../types/index.js';

export type WizardStep = 'type' | 'base-url' | 'api-key' | 'confirm' | 'running' | 'done';

export interface WizardState {
  step: WizardStep;
  typeIndex: number;
  type: ProviderType | null;
  baseUrl: string;
  /** Masked key input buffer (or env:NAME) */
  keyBuffer: string;
  description: string;
  resultOk: boolean;
  resultMessage: string;
  resultWarnings: string[];
}

export const PROVIDER_TYPE_OPTIONS: Array<{ type: ProviderType; label: string; hint: string }> = [
  { type: 'xkiro', label: 'xKiro', hint: 'first-class provider, model ids are vendor/model' },
  {
    type: 'openai-compatible',
    label: 'OpenAI-compatible',
    hint: 'any /v1/chat/completions endpoint',
  },
  { type: 'anthropic-compatible', label: 'Anthropic-compatible', hint: '/v1/messages endpoints' },
];

export function ConnectWizardView({ state }: { state: WizardState }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="yellow">
        Connection wizard
      </Text>

      {state.step === 'type' && (
        <Box flexDirection="column">
          <Text>Select the provider type (↑/↓, Enter):</Text>
          {PROVIDER_TYPE_OPTIONS.map((option, index) => (
            <Box key={option.type}>
              <Text
                inverse={index === state.typeIndex}
                color={index === state.typeIndex ? 'yellow' : undefined}
              >
                {' '}
                {option.label}{' '}
              </Text>
              <Text dimColor> {option.hint}</Text>
            </Box>
          ))}
          <Text dimColor>Esc cancels.</Text>
        </Box>
      )}

      {state.step === 'base-url' && (
        <Box flexDirection="column">
          <Text>Base URL (Enter to accept):</Text>
          <Text color="yellow">▸ {state.baseUrl || '(required)'}▌</Text>
          <Text dimColor>Esc cancels.</Text>
        </Box>
      )}

      {state.step === 'api-key' && (
        <Box flexDirection="column">
          <Text>
            API key — paste the key, or type <Text color="cyan">env:VAR_NAME</Text> to reference an
            environment variable. Leave empty only if the endpoint needs no key.
          </Text>
          <Text color="yellow">▸ {mask(state.keyBuffer)}▌</Text>
          <Text dimColor>
            Keys are stored in ~/.config/mediaxg/credentials.json (0600) or resolved from the
            environment. Esc cancels.
          </Text>
        </Box>
      )}

      {state.step === 'confirm' && (
        <Box flexDirection="column">
          <Text>Will connect:</Text>
          <Text> type: {state.type}</Text>
          <Text> base URL: {state.baseUrl}</Text>
          <Text>
            {' '}
            credential:{' '}
            {state.keyBuffer
              ? state.keyBuffer.startsWith('env:')
                ? `environment variable ${state.keyBuffer.slice(4)}`
                : 'stored key (masked)'
              : 'none — requests will fail until configured'}
          </Text>
          <Text color="yellow">Enter connects and validates. Esc cancels.</Text>
        </Box>
      )}

      {state.step === 'running' && <Text color="yellow">Validating credentials…</Text>}

      {state.step === 'done' && (
        <Box flexDirection="column">
          <Text color={state.resultOk ? 'green' : 'red'}>
            {state.resultOk ? '✔' : '✖'} {state.resultMessage}
          </Text>
          {state.resultWarnings.map((warning, index) => (
            <Text key={index} color="yellow">
              Warning: {warning}
            </Text>
          ))}
          <Text dimColor>Enter or Esc to close.</Text>
        </Box>
      )}
    </Box>
  );
}

function mask(value: string): string {
  if (value.startsWith('env:')) return value;
  if (value.length === 0) return '';
  return '*'.repeat(Math.min(value.length, 24));
}
