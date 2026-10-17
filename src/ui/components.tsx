/**
 * Presentational TUI components (Ink).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { TranscriptEntry, SuggestionItem, PickerItem, StatusParts } from './model.js';
import type { BudgetGateDecision } from '../budget/gate.js';

// ============================================================================
// Status bar
// ============================================================================

export function StatusBar({
  status,
  generation,
  spinner,
}: {
  status: StatusParts;
  generation: string | null;
  spinner: string;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">
          mediaXG
        </Text>
        <Text dimColor> │ </Text>
        <Text color="magenta">{status.provider}</Text>
        <Text dimColor> │ </Text>
        <Text color="blue">{status.model}</Text>
        <Text dimColor> │ </Text>
        <Text bold color={status.mode === 'PLAN' || status.mode === 'REVIEW' ? 'yellow' : 'green'}>
          {status.mode}
        </Text>
        <Text dimColor> │ </Text>
        <Text bold={status.auto === 'AUTO ON'} color={status.auto === 'AUTO ON' ? 'red' : 'gray'}>
          {status.auto}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          {status.think} │ {status.context} │ {status.cost} │ session {status.session}
        </Text>
      </Box>
      {generation && (
        <Box>
          <Text color="yellow">
            {spinner} {generation}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ============================================================================
// Transcript
// ============================================================================

const MAX_ENTRIES = 24;

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  if (entries.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>
          Type a message to start. Type / for commands, /help for the full list, Esc to cancel a
          response, Ctrl+C to exit.
        </Text>
      </Box>
    );
  }

  const visible = entries.slice(-MAX_ENTRIES);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {entries.length > MAX_ENTRIES && (
        <Text dimColor>
          … {entries.length - MAX_ENTRIES} earlier entries hidden (full history: /session export)
        </Text>
      )}
      {visible.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === 'user') {
    return (
      <Box marginBottom={0}>
        <Text color="green" bold>
          &gt;{' '}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text>{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <Box flexDirection="column" marginBottom={0}>
        {entry.reasoning !== undefined && entry.reasoning.length > 0 && (
          <Box>
            <Text dimColor>⋯ reasoning: {truncate(entry.reasoning, 400)}</Text>
          </Box>
        )}
        <Box>
          <Text color="blue" bold>
            ◈{' '}
          </Text>
          <Box flexDirection="column" flexGrow={1}>
            <Text>
              {entry.content}
              {entry.streaming ? '▌' : ''}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (entry.role === 'error') {
    return (
      <Box marginBottom={0}>
        <Text color="red" bold>
          ✖{' '}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text color="red">{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.role === 'tool') {
    const status = entry.tool?.status ?? 'ok';
    const icon = status === 'running' ? '…' : status === 'ok' ? '✔' : '✖';
    const color = status === 'running' ? 'yellow' : status === 'ok' ? 'green' : 'red';
    const duration = entry.tool?.durationMs !== undefined ? ` ${entry.tool.durationMs}ms` : '';
    return (
      <Box flexDirection="column" marginBottom={0}>
        <Box>
          <Text color={color} bold>
            ⚙ {icon}{' '}
          </Text>
          <Text bold>{entry.tool?.name ?? 'tool'}</Text>
          <Text dimColor>{duration}</Text>
        </Box>
        {entry.content !== '' && status !== 'running' && (
          <Box marginLeft={2} flexDirection="column">
            <Text dimColor={status === 'ok'} color={status === 'error' ? 'red' : undefined}>
              {truncate(entry.content.split('\n').slice(0, 4).join('\n'), 500)}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box marginBottom={0}>
      <Text dimColor>• {entry.content}</Text>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ============================================================================
// Input
// ============================================================================

export function InputBar({
  value,
  suggestions,
  selectedIndex,
  busy,
}: {
  value: string;
  suggestions: SuggestionItem[];
  selectedIndex: number;
  busy: boolean;
}) {
  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box flexDirection="column" marginBottom={0}>
          {suggestions.map((suggestion, index) => (
            <Box key={suggestion.insert}>
              <Text
                color={index === selectedIndex ? 'cyan' : undefined}
                inverse={index === selectedIndex}
              >
                {' '}
                {suggestion.display}
              </Text>
              <Text dimColor>
                {' '}
                {suggestion.usage ?? ''} {suggestion.description}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box borderStyle="round" borderColor={busy ? 'yellow' : 'green'} paddingX={1}>
        <Text color={busy ? 'yellow' : 'green'}>{busy ? '◌' : '>'}</Text>
        <Text> {value.length > 0 ? value : ''}</Text>
        {value.length === 0 && (
          <Text dimColor>
            {' '}
            {busy ? 'streaming — Esc to cancel' : 'message or /command (Tab completes)'}
          </Text>
        )}
        <Text>▌</Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// Pickers
// ============================================================================

const MAX_PICKER_ROWS = 12;

export function PickerView({
  title,
  items,
  selectedIndex,
  filter,
  emptyMessage,
  hint,
}: {
  title: string;
  items: PickerItem[];
  selectedIndex: number;
  filter?: string;
  emptyMessage: string;
  hint: string;
}) {
  // Keep the selected row visible
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(MAX_PICKER_ROWS / 2), items.length - MAX_PICKER_ROWS),
  );
  const visible = items.slice(start, start + MAX_PICKER_ROWS);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold color="cyan">
          {title}
        </Text>
        {filter !== undefined && <Text dimColor> filter: {filter || '(type to filter)'}</Text>}
      </Box>
      {items.length === 0 ? (
        <Text dimColor>{emptyMessage}</Text>
      ) : (
        <>
          {start > 0 && <Text dimColor> … {start} above</Text>}
          {visible.map((item, index) => {
            const absolute = start + index;
            const selected = absolute === selectedIndex;
            return (
              <Box key={item.key}>
                <Text color={selected ? 'cyan' : undefined} inverse={selected}>
                  {' '}
                  {item.active ? '*' : ' '} {item.label}
                </Text>
                <Text dimColor> {item.detail}</Text>
              </Box>
            );
          })}
          {start + MAX_PICKER_ROWS < items.length && (
            <Text dimColor> … {items.length - (start + MAX_PICKER_ROWS)} below</Text>
          )}
        </>
      )}
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

// ============================================================================
// Permission prompt
// ============================================================================

export function PermissionView({
  summary,
  detail,
  permissionClass,
  destructive,
}: {
  summary: string;
  detail?: string;
  permissionClass: string;
  destructive?: boolean;
}) {
  const accent = destructive ? 'red' : 'yellow';
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color={accent}>
        {destructive ? '⚠ Destructive action requires approval' : 'Permission required'}
      </Text>
      <Text>{summary}</Text>
      {detail !== undefined && detail !== summary && <Text dimColor>{detail}</Text>}
      <Text dimColor>
        class: {permissionClass}
        {destructive ? ' · destructive' : ''}
      </Text>
      <Text>
        <Text color="green" bold>
          y
        </Text>{' '}
        allow once ·{' '}
        <Text color="cyan" bold>
          a
        </Text>{' '}
        allow for session ·{' '}
        <Text color="red" bold>
          n
        </Text>
        /Esc deny
      </Text>
    </Box>
  );
}

// ============================================================================
// Budget gate confirmation (§30)
// ============================================================================

export function BudgetGateView({ decision }: { decision: BudgetGateDecision }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="yellow">
        Budget gate requires confirmation
      </Text>
      {decision.reasons.map((reason, index) => (
        <Text key={index}>⚠ {reason}</Text>
      ))}
      <Text dimColor>
        est. {decision.estimate.inputTokens} input tokens
        {decision.estimate.estimatedCost !== undefined
          ? ` · ~$${decision.estimate.estimatedCost.toFixed(4)} ${decision.estimate.currency} (local estimate, worst case)`
          : ' · cost unknown (no pricing snapshot)'}
      </Text>
      <Text>
        <Text color="green" bold>
          y
        </Text>{' '}
        approve this request once ·{' '}
        <Text color="red" bold>
          n
        </Text>{' '}
        deny (nothing is sent) · Esc deny · Ctrl+C cancel the turn
      </Text>
    </Box>
  );
}
