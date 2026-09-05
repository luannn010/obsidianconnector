import { describe, expect, it } from 'vitest';
import {
  deriveTaskName,
  normalizeHookPayload,
  shouldRecordActivityPath,
} from '../../src/activity/hook-normalizer.js';

describe('agent activity hook normalization', () => {
  it('derives a bounded task name without retaining the full prompt', () => {
    expect(
      deriveTaskName(
        `  Fix observer database grants\n\n${'private detail '.repeat(40)}`,
      ),
    ).toBe('Fix observer database grants');
    expect(deriveTaskName('x'.repeat(200))).toHaveLength(120);
  });

  it('excludes secrets, dependencies, generated output, logs, and temporary files', () => {
    for (const path of [
      '.env',
      'node_modules/pg/index.js',
      'dist/server.js',
      'logs/worker.log',
      'Archive/old.md',
      'data/world.zip.tmp',
      'credential-notes.md',
    ]) {
      expect(shouldRecordActivityPath(path), path).toBe(false);
    }
    expect(
      shouldRecordActivityPath('services/observer/server/database.js'),
    ).toBe(true);
  });

  it('maps structured Claude reads to a task-scoped read event', () => {
    expect(
      normalizeHookPayload('claude', {
        session_id: 'claude-session',
        cwd: 'C:/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_use_id: 'tool-1',
        tool_input: {
          file_path: 'C:/repo/services/observer/server/database.js',
        },
      }),
    ).toMatchObject({
      agent: 'claude',
      sessionId: 'claude-session',
      cwd: 'C:/repo',
      events: [
        {
          action: 'read',
          path: 'C:/repo/services/observer/server/database.js',
          captureMethod: 'structured_tool',
          confidence: 'high',
        },
      ],
    });
  });

  it('parses only supported shell reads and does not guess unsupported commands', () => {
    const supported = normalizeHookPayload('codex', {
      session_id: 'codex-session',
      cwd: 'C:/repo',
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_use_id: 'tool-2',
      tool_input: {
        command:
          "Get-Content 'services/observer/server/database.js' | Select-Object -First 20",
      },
    });
    expect(supported.events).toEqual([
      expect.objectContaining({
        action: 'read',
        path: 'services/observer/server/database.js',
        captureMethod: 'shell_allowlist',
        confidence: 'medium',
      }),
    ]);

    const unsupported = normalizeHookPayload('codex', {
      session_id: 'codex-session',
      cwd: 'C:/repo',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tool-3',
      tool_input: { command: 'custom-reader --everything' },
    });
    expect(unsupported.events).toEqual([]);
    expect(unsupported.coverageWarning).toBe('unsupported_shell_command');
  });

  it('captures each Codex apply_patch target with its write action', () => {
    const result = normalizeHookPayload('codex', {
      session_id: 'codex-session',
      cwd: 'C:/repo',
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-1',
      tool_name: 'apply_patch',
      tool_use_id: 'tool-patch',
      tool_input: {
        command:
          '*** Begin Patch\n*** Update File: services/observer/server/database.js\n*** Add File: services/observer/server/new.js\n*** Delete File: services/observer/server/old.js\n*** End Patch',
      },
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        action: 'edit',
        path: 'services/observer/server/database.js',
      }),
      expect.objectContaining({
        action: 'create',
        path: 'services/observer/server/new.js',
      }),
      expect.objectContaining({
        action: 'delete',
        path: 'services/observer/server/old.js',
      }),
    ]);
  });

  it('records task lifecycle without preserving prompt content', () => {
    expect(
      normalizeHookPayload('codex', {
        session_id: 'task-123',
        cwd: 'C:/repo',
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Update the observer grants\nDo not save this detail',
      }),
    ).toEqual({
      agent: 'codex',
      sessionId: 'task-123',
      cwd: 'C:/repo',
      lifecycle: 'task_name',
      taskName: 'Update the observer grants',
      events: [],
    });
  });
});
