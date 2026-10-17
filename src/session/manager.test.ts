import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionManager } from './manager.js';
import { SESSION_SCHEMA_VERSION, emptyUsage, addUsage, type SessionData } from './types.js';

function createManager(overrides: { ids?: string[]; nowMs?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mediaxg-sessions-'));
  const ids = overrides.ids ? [...overrides.ids] : undefined;
  const manager = new SessionManager({
    directory: dir,
    projectPath: '/tmp/project',
    ...(overrides.nowMs ? { now: () => new Date(overrides.nowMs!()) } : {}),
    ...(ids ? { idFactory: () => ids.shift() ?? 'overflow-id' } : {}),
  });
  return { manager, dir };
}

describe('SessionManager basics', () => {
  it('creates and persists a session', () => {
    const { manager, dir } = createManager();
    const session = manager.create({ name: 'First' });

    expect(session.version).toBe(SESSION_SCHEMA_VERSION);
    expect(session.name).toBe('First');
    expect(session.messages).toEqual([]);
    expect(existsSync(join(dir, `${session.id}.json`))).toBe(true);
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
  });

  it('loads a session back', () => {
    const { manager } = createManager();
    const created = manager.create({ name: 'Roundtrip' });
    const loaded = manager.load(created.id);
    expect(loaded?.id).toBe(created.id);
    expect(loaded?.name).toBe('Roundtrip');
  });

  it('returns null for unknown ids', () => {
    const { manager } = createManager();
    expect(manager.load('nope')).toBeNull();
  });

  it('lists sessions most recent first', () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const { manager } = createManager({ nowMs: () => now });
    const first = manager.create({ name: 'First' });
    now += 60_000;
    const second = manager.create({ name: 'Second' });

    const list = manager.list();
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it('finds sessions by unique id prefix', () => {
    const { manager } = createManager({ ids: ['aaa11111', 'aaa22222', 'bbb33333'] });
    manager.create({ name: 'One' });
    manager.create({ name: 'Two' });
    manager.create({ name: 'Three' });

    expect(manager.loadByPrefix('bbb').name).toBe('Three');
    expect(manager.loadByPrefix('aaa')).toBeNull(); // ambiguous
  });

  it('renames a session', () => {
    const { manager } = createManager();
    const session = manager.create({ name: 'Old' });
    const renamed = manager.rename(session.id, 'New');
    expect(renamed?.name).toBe('New');
    expect(manager.load(session.id)?.name).toBe('New');
    expect(manager.list()[0]?.name).toBe('New');
  });

  it('deletes a session and its index entry', () => {
    const { manager, dir } = createManager();
    const session = manager.create();
    expect(manager.delete(session.id)).toBe(true);
    expect(manager.load(session.id)).toBeNull();
    expect(existsSync(join(dir, `${session.id}.json`))).toBe(false);
    expect(manager.list().find((s) => s.id === session.id)).toBeUndefined();
  });
});

describe('SessionManager search and export', () => {
  it('searches by name', () => {
    const { manager } = createManager();
    manager.create({ name: 'Provider refactor work' });
    manager.create({ name: 'Something else' });

    const results = manager.search('refactor');
    expect(results).toHaveLength(1);
    expect(results[0]?.matchContext).toContain('Provider refactor work');
  });

  it('searches by message content with context', () => {
    const { manager } = createManager();
    const session = manager.create({ name: 'Chat' });
    session.messages.push({
      id: 'm1',
      role: 'user',
      content: 'Please fix the streaming parser overflow bug',
      timestamp: new Date().toISOString(),
    });
    manager.save(session);

    const results = manager.search('overflow');
    expect(results).toHaveLength(1);
    expect(results[0]?.matchContext).toContain('overflow');
  });

  it('exports a session to a file', () => {
    const { manager } = createManager();
    const session = manager.create({ name: 'Export me' });
    const target = join(mkdtempSync(join(tmpdir(), 'mediaxg-export-')), 'out.json');

    const result = manager.export(session.id, target);
    expect(result.ok).toBe(true);

    const parsed = JSON.parse(readFileSync(target, 'utf-8')) as {
      exportedBy: string;
      session: SessionData;
    };
    expect(parsed.exportedBy).toBe('mediaXG');
    expect(parsed.session.id).toBe(session.id);
  });

  it('fails to export a missing session', () => {
    const { manager } = createManager();
    const result = manager.export('missing', '/tmp/whatever.json');
    expect(result.ok).toBe(false);
  });
});

describe('SessionManager resilience', () => {
  it('skips corrupted session files when rebuilding the index', () => {
    const { manager, dir } = createManager();
    const good = manager.create({ name: 'Good' });

    // Write a corrupted session file and delete the index
    writeFileSync(join(dir, 'corrupt.json'), '{not valid json', 'utf-8');
    writeFileSync(join(dir, 'index.json'), 'garbage', 'utf-8');

    const list = manager.list();
    expect(list.map((s) => s.id)).toEqual([good.id]);
  });

  it('loads records without an envelope (early format)', () => {
    const { manager, dir } = createManager();
    const session = manager.create({ name: 'Legacy' });
    const raw = JSON.parse(readFileSync(join(dir, `${session.id}.json`), 'utf-8')) as {
      session: SessionData;
    };
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(raw.session), 'utf-8');

    const loaded = manager.load(session.id);
    expect(loaded?.id).toBe(session.id);
  });

  it('backfills missing fields on load', () => {
    const { manager, dir } = createManager();
    const session = manager.create();
    const envelope = JSON.parse(readFileSync(join(dir, `${session.id}.json`), 'utf-8')) as {
      session: Record<string, unknown>;
    };
    delete envelope.session['usage'];
    delete envelope.session['reasoning'];
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(envelope), 'utf-8');

    const loaded = manager.load(session.id);
    expect(loaded?.usage).toEqual(emptyUsage());
    expect(loaded?.reasoning).toEqual({ effort: 'medium' });
  });

  it('writes atomically (no .tmp files remain)', () => {
    const { manager, dir } = createManager();
    const session = manager.create();
    manager.save(session);
    expect(existsSync(join(dir, `${session.id}.json.tmp`))).toBe(false);
    expect(existsSync(join(dir, 'index.json.tmp'))).toBe(false);
  });
});

describe('SessionManager spend tracking', () => {
  it('sums estimated cost for sessions updated within a window', () => {
    let now = Date.parse('2026-03-10T10:00:00Z');
    const { manager } = createManager({ nowMs: () => now });

    const old = manager.create({ name: 'Old' });
    old.usage = addUsage(emptyUsage(), { estimatedCost: 1, currency: 'USD' });
    manager.save(old);

    now = Date.parse('2026-03-12T10:00:00Z');
    const recent = manager.create({ name: 'Recent' });
    recent.usage = addUsage(emptyUsage(), { estimatedCost: 2, currency: 'USD' });
    manager.save(recent);

    const since = manager.spendSince('2026-03-11T00:00:00Z');
    expect(since.total).toBeCloseTo(2);
    expect(since.sessionCount).toBe(1);

    const all = manager.spendSince('2026-01-01T00:00:00Z');
    expect(all.total).toBeCloseTo(3);
    expect(all.sessionCount).toBe(2);
  });
});

describe('SessionManager migration', () => {
  it('migrates v1 sessions to the current schema with empty v2 fields', () => {
    const { manager, dir } = createManager();
    const session = manager.create({ name: 'Legacy v1' });
    const envelope = JSON.parse(readFileSync(join(dir, `${session.id}.json`), 'utf-8')) as {
      version: number;
      session: Record<string, unknown>;
    };

    // Simulate a record written by the previous schema version
    envelope.version = 1;
    envelope.session['version'] = 1;
    delete envelope.session['plan'];
    delete envelope.session['changeLedger'];
    delete envelope.session['toolHistory'];
    delete envelope.session['permissionAudit'];
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(envelope), 'utf-8');

    const loaded = manager.load(session.id);
    expect(loaded?.version).toBe(SESSION_SCHEMA_VERSION);
    expect(loaded?.plan).toBeNull();
    expect(loaded?.changeLedger).toEqual([]);
    expect(loaded?.toolHistory).toEqual([]);
    expect(loaded?.permissionAudit).toEqual([]);
  });

  it('persists plan, tool history, change ledger, and permission audit', () => {
    const { manager } = createManager();
    const session = manager.create({ name: 'v2 state' });

    session.plan = {
      id: 'plan-1',
      goal: 'Ship Phase D',
      constraints: ['no new dependencies'],
      relevantFiles: ['src/agent/loop.ts'],
      proposedSteps: [
        { id: 's1', description: 'Write tests', status: 'in-progress', toolCalls: [] },
      ],
      risks: ['flaky tests'],
      requiredPermissions: ['write', 'execute'],
      verificationPlan: 'bun test',
      currentStepIndex: 0,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    session.toolHistory = [
      {
        id: 'call-1',
        name: 'read_file',
        arguments: { path: 'a.ts' },
        result: 'contents',
        isError: false,
        durationMs: 3,
        executedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    session.permissionAudit = [
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        action: 'edit_file',
        permissionClass: 'write',
        decision: 'deny',
        reason: 'non-interactive run',
      },
    ];
    session.changeLedger = [
      {
        id: 'change-1',
        kind: 'create',
        path: 'new.txt',
        afterContent: 'hello',
        afterHash: 'abc',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    manager.save(session);

    const loaded = manager.load(session.id);
    expect(loaded?.plan?.goal).toBe('Ship Phase D');
    expect(loaded?.plan?.proposedSteps[0]?.status).toBe('in-progress');
    expect(loaded?.toolHistory?.[0]?.name).toBe('read_file');
    expect(loaded?.permissionAudit?.[0]?.decision).toBe('deny');
    expect(loaded?.changeLedger?.[0]?.path).toBe('new.txt');
  });
});

describe('SessionManager Phase E fields (§23–§31)', () => {
  it('fills defensive defaults for records written before Phase E', () => {
    const { manager, dir } = createManager();
    const session = manager.create({ name: 'Pre-Phase E' });
    const envelope = JSON.parse(readFileSync(join(dir, `${session.id}.json`), 'utf-8')) as {
      version: number;
      session: Record<string, unknown>;
    };

    // A Phase D record: no estimatedInputTokens, summaries, or chunks
    const usage = envelope.session['usage'] as Record<string, unknown>;
    delete usage['estimatedInputTokens'];
    delete envelope.session['summaries'];
    delete envelope.session['compactedChunks'];
    delete envelope.session['retrievalEnabled'];
    delete envelope.session['lastContextReport'];
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(envelope), 'utf-8');

    const loaded = manager.load(session.id);
    expect(loaded?.usage.estimatedInputTokens).toBe(0);
    expect(loaded?.summaries).toEqual([]);
    expect(loaded?.compactedChunks).toEqual([]);
    // Absent optional fields stay absent (no invented values)
    expect(loaded?.retrievalEnabled).toBeUndefined();
    expect(loaded?.lastContextReport).toBeUndefined();
  });

  it('round-trips retrieval, summaries, chunks, and the last context report', () => {
    const { manager } = createManager();
    const session = manager.create({ name: 'Phase E state' });
    session.retrievalEnabled = true;
    session.usage.estimatedInputTokens = 1234;
    session.summaries = [
      {
        id: 'sum-1',
        level: 1,
        at: '2026-01-01T00:00:00.000Z',
        coversMessages: 12,
        tokens: 300,
        summaryMessageId: 'msg-1',
      },
    ];
    session.compactedChunks = [
      {
        id: 'sum-1',
        at: '2026-01-01T00:00:00.000Z',
        level: 1,
        summaryMessageId: 'msg-1',
        payloadRetained: false,
        messages: [],
      },
    ];
    session.lastContextReport = {
      at: '2026-01-01T00:00:00.000Z',
      estimatedInputTokens: 1200,
      estimateSource: 'calibrated-local',
      requestedTokens: 128000,
      requestOrigin: 'profile',
      reservedOutputTokens: 8000,
      safetyMargin: 4000,
      effectiveBudget: 116000,
      remainingHeadroom: 114800,
      capabilitySource: 'test [provider-api, unverified]',
      capabilityVerified: false,
      items: [],
      omittedMessages: 0,
      compactedMessages: 0,
      retrievalFiles: [],
      gateAction: 'allow',
      notes: [],
    };
    manager.save(session);

    const loaded = manager.load(session.id);
    expect(loaded?.retrievalEnabled).toBe(true);
    expect(loaded?.usage.estimatedInputTokens).toBe(1234);
    expect(loaded?.summaries?.[0]?.summaryMessageId).toBe('msg-1');
    expect(loaded?.compactedChunks?.[0]?.payloadRetained).toBe(false);
    expect(loaded?.lastContextReport?.estimateSource).toBe('calibrated-local');
    expect(loaded?.lastContextReport?.effectiveBudget).toBe(116000);
  });
});
