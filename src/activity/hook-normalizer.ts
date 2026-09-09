export type ActivityAgent = 'codex' | 'claude';
export type ActivityAction =
  'read' | 'search' | 'create' | 'edit' | 'delete' | 'open';
export type ActivityLifecycle =
  'session_start' | 'task_name' | 'stop' | 'session_end';

export interface NormalizedActivityEvent {
  action: ActivityAction;
  path: string;
  captureMethod: 'structured_tool' | 'shell_allowlist';
  confidence: 'high' | 'medium' | 'low';
  turnId?: string;
  toolCallId?: string;
}

export interface NormalizedHookPayload {
  agent: ActivityAgent;
  sessionId: string;
  cwd: string;
  lifecycle?: ActivityLifecycle;
  stopHookActive?: boolean;
  taskName?: string;
  events: NormalizedActivityEvent[];
  coverageWarning?: 'unsupported_shell_command';
}

const EXCLUDED_PARTS = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  'target',
  'vendor',
  '.cache',
  'logs',
  'archive',
  'published',
]);

export function deriveTaskName(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, ' '))
    .find(Boolean);
  return (firstLine || 'Untitled task').slice(0, 120);
}

export function shouldRecordActivityPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/gu, '/').trim();
  if (!normalized || /(?:^|\/)\.env(?:\.|$)/iu.test(normalized)) return false;
  if (/(?:credential|secret)/iu.test(normalized)) return false;
  if (/\.(?:tmp|temp|log)$/iu.test(normalized)) return false;
  return !normalized
    .split('/')
    .filter(Boolean)
    .some((part) => EXCLUDED_PARTS.has(part.toLowerCase()));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/gu, '');
}

function shellPaths(command: string): string[] | undefined {
  const patterns = [
    /(?:^|[;&|]\s*)Get-Content\s+(?:-[A-Za-z]+\s+)*((?:'[^']+'|"[^"]+"|[^\s|;&]+))/giu,
    /(?:^|[;&|]\s*)(?:cat|type)\s+((?:'[^']+'|"[^"]+"|[^\s|;&]+))/giu,
    /(?:^|[;&|]\s*)sed\s+(?:-[A-Za-z]+\s+)*(?:'[^']*'|"[^"]*")\s+((?:'[^']+'|"[^"]+"|[^\s|;&]+))/giu,
    /(?:^|[;&|]\s*)rg\s+[^\r\n]*?\s((?:'[^']+'|"[^"]+"|[^\s|;&]+))\s*$/giu,
  ];
  const found = patterns.flatMap((pattern) =>
    [...command.matchAll(pattern)].flatMap((match) =>
      match[1] ? [unquote(match[1])] : [],
    ),
  );
  return found.length ? [...new Set(found)] : undefined;
}

function patchEvents(command: string): Array<{
  action: 'create' | 'edit' | 'delete';
  path: string;
}> {
  const actionByHeader = {
    Add: 'create',
    Update: 'edit',
    Delete: 'delete',
  } as const;
  return [...command.matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(.+)$/gmu)]
    .map((match) => ({
      action: actionByHeader[match[1] as keyof typeof actionByHeader],
      path: match[2]!.trim(),
    }))
    .filter((event) => shouldRecordActivityPath(event.path));
}

function lifecycleFor(eventName: string): ActivityLifecycle | undefined {
  const normalized = eventName.toLowerCase();
  if (normalized === 'sessionstart') return 'session_start';
  if (normalized === 'userpromptsubmit') return 'task_name';
  if (normalized === 'stop') return 'stop';
  if (normalized === 'sessionend') return 'session_end';
  return undefined;
}

export function normalizeHookPayload(
  agent: ActivityAgent,
  input: unknown,
): NormalizedHookPayload {
  const payload = object(input);
  const sessionId =
    string(payload.session_id) ??
    string(payload.sessionId) ??
    'unknown-session';
  const cwd =
    string(payload.cwd) ?? string(payload.project_dir) ?? process.cwd();
  const eventName = string(payload.hook_event_name) ?? '';
  const lifecycle = lifecycleFor(eventName);
  const result: NormalizedHookPayload = {
    agent,
    sessionId,
    cwd,
    ...(lifecycle ? { lifecycle } : {}),
    ...(lifecycle === 'stop' && payload.stop_hook_active === true
      ? { stopHookActive: true }
      : {}),
    events: [],
  };
  if (lifecycle === 'task_name') {
    const prompt = string(payload.prompt) ?? string(payload.user_prompt);
    if (prompt) result.taskName = deriveTaskName(prompt);
  }
  if (eventName.toLowerCase() !== 'posttooluse') return result;

  const toolName = string(payload.tool_name) ?? '';
  const toolInput = object(payload.tool_input);
  const turnId = string(payload.turn_id);
  const toolCallId =
    string(payload.tool_use_id) ?? string(payload.tool_call_id);
  const directPath =
    string(toolInput.file_path) ??
    string(toolInput.path) ??
    string(toolInput.target) ??
    string(object(toolInput.target).path);
  const lowerTool = toolName.toLowerCase();
  if (lowerTool === 'apply_patch') {
    const command = string(toolInput.command) ?? string(toolInput.patch);
    if (command)
      result.events = patchEvents(command).map((event) => ({
        ...event,
        captureMethod: 'structured_tool' as const,
        confidence: 'high' as const,
        ...(turnId ? { turnId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
      }));
    return result;
  }
  let action: ActivityAction | undefined;
  if (/^(read|view_image|mcp__codex_app__open_in_codex)$/u.test(lowerTool))
    action = lowerTool.includes('open') ? 'open' : 'read';
  else if (lowerTool === 'write') action = 'create';
  else if (lowerTool === 'edit') action = 'edit';
  else if (/^(grep|glob|search)$/u.test(lowerTool)) action = 'search';
  if (directPath && action && shouldRecordActivityPath(directPath)) {
    result.events.push({
      action,
      path: directPath,
      captureMethod: 'structured_tool',
      confidence: 'high',
      ...(turnId ? { turnId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    });
    return result;
  }

  if (lowerTool === 'bash' || lowerTool === 'exec_command') {
    const command = string(toolInput.command) ?? string(toolInput.cmd);
    const paths = command ? shellPaths(command) : undefined;
    if (!paths) {
      result.coverageWarning = 'unsupported_shell_command';
      return result;
    }
    result.events = paths.filter(shouldRecordActivityPath).map((path) => ({
      action: 'read' as const,
      path,
      captureMethod: 'shell_allowlist' as const,
      confidence: 'medium' as const,
      ...(turnId ? { turnId } : {}),
      ...(toolCallId ? { toolCallId } : {}),
    }));
  }
  return result;
}
