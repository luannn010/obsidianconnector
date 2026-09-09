export interface ProjectViewData {
  projectId: string;
  projectKey: string;
  dbRevision: number;
  gitRevision: string;
  architecture: Array<{ title: string; body: string; kind?: string }>;
  workItems: Array<{
    title: string;
    status: string;
    verificationStatus: string;
    blocker?: string;
    worktrees: string[];
  }>;
  worktrees: Array<{
    branch: string;
    head: string;
    dirty: boolean;
    registered: boolean;
    freshness: string;
  }>;
  endpoints: Array<{
    service: string;
    method: string;
    route: string;
    description: string;
    auth: unknown;
    request: unknown;
    responses: Record<string, unknown>;
    examples: Array<{
      type: string;
      statusCode?: number;
      title: string;
      payload: unknown;
    }>;
    status: string;
    gitRevision?: string;
    source?: string;
  }>;
  sequences: Array<{
    domain: string;
    name: string;
    status: string;
    participants: Array<{ alias: string; label: string }>;
    steps: Array<{
      source: string;
      target: string;
      message: string;
      response?: boolean;
    }>;
  }>;
  schemas: Array<{
    name: string;
    description?: string;
    tables: Array<{
      name: string;
      description?: string;
      owner?: string;
      migration?: string;
      columns: Array<{
        name: string;
        type: string;
        nullable: boolean;
        default?: string;
      }>;
    }>;
  }>;
  mappings: Array<{
    domain?: string;
    service?: string;
    object?: string;
    symbol?: string;
    target: string;
    access: string;
  }>;
  decisions: Array<{ title: string; body: string; status?: string }>;
  projections: Array<{ path: string; state: string; revision: number }>;
  documentationFreshness: {
    current: number;
    possiblyStale: number;
    stale: number;
    missing: number;
    unverified: number;
  };
  agentTasks: Array<{
    agent: 'codex' | 'claude';
    taskId: string;
    taskName: string;
    status: string;
    worktree: string;
    branch: string;
    startRevision: string;
    currentRevision: string;
    documentationGate: string;
    startedAt: string;
    lastActivityAt: string;
    files: Array<{
      path: string;
      actions: string[];
      accessCount: number;
      firstAccessAt: string;
      lastAccessAt: string;
      changed: boolean;
    }>;
    documentation: Array<{ ref: string; title: string; state: string }>;
    verificationEvidence: Array<{
      locatorType: string;
      path: string;
      sourceRef?: string;
      sourceHash: string;
    }>;
  }>;
  legacyCount: number;
  legacy?: Array<{ id: string; originalPath: string; rawHash: string }>;
  domainSync?: {
    worktreeId: string;
    worktreePath: string;
    branch: string;
    currentCommit: string;
    currentDirtyHash?: string;
    indexedCommit?: string;
    indexedDirtyHash?: string;
    snapshotId?: string;
    domains: Array<{
      name: string;
      notePath: string;
      state:
        | 'current'
        | 'stale'
        | 'possibly_stale'
        | 'unverified'
        | 'missing';
      lastSyncedCommit?: string;
      lastSyncedDirtyHash?: string;
      currentCommit: string;
      currentDirtyHash?: string;
      databaseRevision: number;
      projectionRevision?: number;
      reasons: string[];
      changedPaths: string[];
      evidenceRefs: string[];
    }>;
    unmappedChanges: string[];
  };
}

export interface ProjectView {
  viewId: string;
  viewType: string;
  relativePath: string;
  body: string;
  format?: 'markdown' | 'json';
  metadata?: Record<string, unknown>;
}
const safeName = (value: string) => value.replace(/[<>:"/\\|?*]/gu, '-').trim();
const jsonBlock = (value: unknown) =>
  `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
const architectureGlance = (body?: string) =>
  body
    ? (body
        .replace(/^#.*$/gmu, '')
        .split(/\n\s*\n/u)
        .map((part) => part.trim())
        .find(Boolean)
        ?.slice(0, 600) ?? 'Architecture record pending.')
    : 'Architecture record pending.';
function apiServiceViews(data: ProjectViewData): ProjectView[] {
  const services = [
    ...new Set(data.endpoints.map((endpoint) => endpoint.service)),
  ].sort();
  const views: ProjectView[] = [
    {
      viewId: 'api-index',
      viewType: 'api-index',
      relativePath: 'Published/03 - APIs/00 - API Index.md',
      body: `# API Index\n\n${services.map((service) => `- [[${safeName(service)}/Contracts|${service}]]`).join('\n') || 'No endpoint records have been imported.'}`,
    },
  ];
  for (const service of services) {
    const endpoints = data.endpoints
      .filter((endpoint) => endpoint.service === service)
      .sort((a, b) =>
        `${a.route}:${a.method}`.localeCompare(`${b.route}:${b.method}`),
      );
    const body = [
      `# ${service} API Contracts`,
      '',
      ...endpoints.flatMap((endpoint) => {
        const requestExamples = endpoint.examples.filter(
          (example) => example.type === 'request',
        );
        const responseExamples = endpoint.examples.filter(
          (example) => example.type === 'response',
        );
        return [
          `## ${endpoint.method} \`${endpoint.route}\``,
          '',
          endpoint.description,
          '',
          `- Status: **${endpoint.status}**`,
          `- Verified revision: \`${endpoint.gitRevision ?? 'unverified'}\``,
          `- Source: \`${endpoint.source ?? 'evidence pending'}\``,
          `- Authentication and ownership: ${JSON.stringify(endpoint.auth)}`,
          '',
          '### Request contract',
          jsonBlock(endpoint.request),
          '### Request examples',
          ...(requestExamples.length
            ? requestExamples.flatMap((example) => [
                `#### ${example.title}`,
                jsonBlock(example.payload),
              ])
            : ['Evidence-backed request example is pending.']),
          '### Responses',
          jsonBlock(endpoint.responses),
          '### Response examples',
          ...(responseExamples.length
            ? responseExamples.flatMap((example) => [
                `#### ${example.statusCode ?? ''} ${example.title}`.trim(),
                jsonBlock(example.payload),
              ])
            : ['Evidence-backed response example is pending.']),
        ];
      }),
    ].join('\n');
    views.push({
      viewId: `api-service:${service}`,
      viewType: 'api-contracts',
      relativePath: `Published/03 - APIs/${safeName(service)}/Contracts.md`,
      body,
    });
    const paths: Record<string, Record<string, unknown>> = {};
    for (const endpoint of endpoints) {
      paths[endpoint.route] ??= {};
      paths[endpoint.route]![endpoint.method.toLowerCase()] = {
        summary: endpoint.description,
        responses: endpoint.responses,
        ...(Object.keys((endpoint.request as object) ?? {}).length
          ? {
              requestBody: {
                content: { 'application/json': { schema: endpoint.request } },
              },
            }
          : {}),
        'x-implementation-status': endpoint.status,
        'x-verified-git-revision': endpoint.gitRevision ?? null,
        'x-source-evidence': endpoint.source ?? null,
      };
    }
    views.push({
      viewId: `openapi:${service}`,
      viewType: 'openapi',
      relativePath: `Published/03 - APIs/${safeName(service)}/openapi.json`,
      format: 'json',
      body: `${JSON.stringify({ openapi: '3.1.0', info: { title: `${service} API`, version: data.gitRevision || 'unverified' }, paths }, null, 2)}\n`,
    });
  }
  return views;
}

export function buildProjectViews(data: ProjectViewData): ProjectView[] {
  const verified = data.workItems.filter(
    (item) =>
      item.status === 'completed' && item.verificationStatus !== 'unverified',
  );
  const reported = data.workItems.filter(
    (item) =>
      item.status === 'completed' && item.verificationStatus === 'unverified',
  );
  const active = data.workItems.filter((item) => item.status === 'active');
  const blockers = data.workItems.filter(
    (item) => item.status === 'blocked' || item.blocker,
  );
  const list = (items: typeof data.workItems) =>
    items
      .map((item) => `- ${item.title} — ${item.verificationStatus}`)
      .join('\n') || '- None';
  const dashboard = `# ${data.projectKey} Project Dashboard\n\n## Architecture at a glance\n\n${architectureGlance(data.architecture[0]?.body)}\n\nRead [[01 - Architecture/00 - Architecture Overview|Architecture Overview]] for detail.\n\n## Verified completed\n\n${list(verified)}\n\n## Reported completed\n\n${list(reported)}\n\n## Active work\n\n${list(active)}\n\n## Blockers\n\n${list(blockers)}\n\n## Freshness\n\n- Git: \`${data.gitRevision}\`\n- Knowledge revision: ${data.dbRevision}\n- Required documentation: ${data.documentationFreshness.stale} stale, ${data.documentationFreshness.missing} missing, ${data.documentationFreshness.unverified} unverified\n- Legacy notes accounted for: ${data.legacyCount}\n\n## Navigate\n\n- [[01 - Architecture/00 - Architecture Overview|Architecture Overview]]\n- [[02 - Delivery/00 - Implementation Status|Delivery]]\n- [[03 - APIs/00 - API Index|APIs]]\n- [[04 - Data/00 - Database Map|Data]]\n- [[06 - Operations/00 - Sync Status|Sync]]`;
  const views: ProjectView[] = [
    {
      viewId: 'dashboard',
      viewType: 'dashboard',
      relativePath: 'Published/00 - Project Dashboard.md',
      body: dashboard,
    },
    {
      viewId: 'architecture-overview',
      viewType: 'architecture',
      relativePath: 'Published/01 - Architecture/00 - Architecture Overview.md',
      body: `# Architecture Overview\n\n${data.architecture.map((item) => `## ${item.title}\n\n${item.body}`).join('\n\n') || 'Architecture records pending.'}`,
    },
    {
      viewId: 'system-design',
      viewType: 'system-design',
      relativePath: 'Published/01 - Architecture/01 - System Design.md',
      body: `# System Design\n\n${
        data.architecture
          .filter((item) => item.kind === 'system_design')
          .map((item) => item.body)
          .join('\n\n') || '[[00 - Architecture Overview]]'
      }`,
    },
    {
      viewId: 'service-map',
      viewType: 'service-map',
      relativePath: 'Published/01 - Architecture/02 - Service Map.md',
      body: `# Service Map\n\n${
        data.architecture
          .filter((item) => item.kind === 'service')
          .map((item) => `## ${item.title}\n\n${item.body}`)
          .join('\n\n') || 'Service records pending.'
      }`,
    },
    {
      viewId: 'implementation-status',
      viewType: 'delivery',
      relativePath: 'Published/02 - Delivery/00 - Implementation Status.md',
      body: `# Implementation Status\n\n## Verified done\n${list(verified)}\n\n## Reported done\n${list(reported)}\n\n## Active\n${list(active)}\n\n## Blocked\n${list(blockers)}`,
    },
    {
      viewId: 'active-worktrees',
      viewType: 'worktrees',
      relativePath: 'Published/02 - Delivery/01 - Active Worktrees.md',
      body: `# Active Worktrees\n\n| Branch | HEAD | Dirty | Registered | Index |\n|---|---|---:|---:|---|\n${data.worktrees.map((item) => `| ${item.branch} | \`${item.head}\` | ${item.dirty} | ${item.registered} | ${item.freshness} |`).join('\n')}`,
    },
  ];
  views.push(...apiServiceViews(data));
  const domains = [
    ...new Set([
      ...data.sequences.map((flow) => flow.domain),
      ...(data.domainSync?.domains.map((domain) => domain.name) ?? []),
    ]),
  ].sort();
  const domainRows = data.domainSync?.domains ?? [];
  views.push({
    viewId: 'interaction-index',
    viewType: 'interactions',
    relativePath: 'Published/01 - Architecture/Domains/00 - Domain Index.md',
    body: data.domainSync
      ? `# Domain Sync\n\n- Worktree: \`${data.domainSync.worktreePath}\`\n- Branch: \`${data.domainSync.branch}\`\n- Current commit: \`${data.domainSync.currentCommit}\`\n- Dirty: ${Boolean(data.domainSync.currentDirtyHash)}\n\n| Domain | State | Last synced | Current | Changed paths | Note |\n|---|---|---|---|---:|---|\n${domainRows.map((domain) => `| ${domain.name} | ${domain.state} | \`${domain.lastSyncedCommit ?? 'unindexed'}\` | \`${domain.currentCommit}\` | ${domain.changedPaths.length} | [[${safeName(domain.name)}]] |`).join('\n') || '| No domains registered | missing | | | 0 | |'}`
      : `# Domain Interactions\n\n${domains.map((domain) => `- [[${safeName(domain)}]]`).join('\n') || 'Sequence records pending.'}`,
  });
  for (const domain of domains) {
    const sync = domainRows.find((item) => item.name === domain);
    views.push({
      viewId: `domain:${domain}`,
      viewType: 'domain',
      relativePath: `Published/01 - Architecture/Domains/${safeName(domain)}.md`,
      ...(sync
        ? {
            metadata: {
              branch: data.domainSync!.branch,
              current_commit: sync.currentCommit,
              ...(sync.currentDirtyHash
                ? { current_dirty_hash: sync.currentDirtyHash }
                : {}),
              domain,
              ...(sync.lastSyncedCommit
                ? { last_synced_commit: sync.lastSyncedCommit }
                : {}),
              ...(sync.lastSyncedDirtyHash
                ? { last_synced_dirty_hash: sync.lastSyncedDirtyHash }
                : {}),
              ...(data.domainSync!.snapshotId
                ? { snapshot_id: data.domainSync!.snapshotId }
                : {}),
              sync_status: sync.state,
              worktree: data.domainSync!.worktreePath,
            },
          }
        : {}),
      body: [
        `# ${domain}`,
        ...(sync
          ? [
              '## Sync audit',
              `- State: **${sync.state}**`,
              `- Worktree: \`${data.domainSync!.worktreePath}\``,
              `- Branch: \`${data.domainSync!.branch}\``,
              `- Last synced commit: \`${sync.lastSyncedCommit ?? 'unindexed'}\``,
              `- Current commit: \`${sync.currentCommit}\``,
              `- Dirty fingerprint: \`${sync.currentDirtyHash ?? 'clean'}\``,
              `- Database revision: ${sync.databaseRevision}`,
              `- Projection revision: ${sync.projectionRevision ?? 'missing'}`,
              '',
              '### Reasons',
              ...(sync.reasons.length
                ? sync.reasons.map((reason) => `- ${reason}`)
                : ['- Domain evidence and projection are current.']),
              '',
              '### Changed paths',
              ...(sync.changedPaths.length
                ? sync.changedPaths.map((changedPath) => `- \`${changedPath}\``)
                : ['- None']),
              '',
              '### Evidence',
              ...(sync.evidenceRefs.length
                ? sync.evidenceRefs.map((ref) => `- \`${ref}\``)
                : ['- No linked evidence.']),
            ]
          : []),
        ...data.sequences
          .filter((flow) => flow.domain === domain)
          .flatMap((flow) => [
            `## ${flow.name}`,
            `Status: **${flow.status}**`,
            '```mermaid',
            'sequenceDiagram',
            ...flow.participants.map(
              (participant) =>
                `  participant ${participant.alias} as ${participant.label}`,
            ),
            ...flow.steps.map(
              (step) =>
                `  ${step.source}${step.response ? '-->>' : '->>'}${step.target}: ${step.message}`,
            ),
            '```',
          ]),
      ].join('\n'),
    });
  }
  views.push({
    viewId: 'database-map',
    viewType: 'database-map',
    relativePath: 'Published/04 - Data/00 - Database Map.md',
    body: `# Database Map\n\n| Domain | Service | Object/Symbol | Physical target | Access |\n|---|---|---|---|---|\n${data.mappings.map((item) => `| ${item.domain ?? ''} | ${item.service ?? ''} | ${item.object ?? item.symbol ?? ''} | \`${item.target}\` | ${item.access} |`).join('\n') || '| | | | Mapping pending | |'}`,
  });
  for (const schema of data.schemas)
    views.push({
      viewId: `schema:${schema.name}`,
      viewType: 'database-schema',
      relativePath: `Published/04 - Data/Schemas/${safeName(schema.name)}.md`,
      body: [
        `# Schema: ${schema.name}`,
        schema.description ?? '',
        ...schema.tables.flatMap((table) => [
          `## ${table.name}`,
          table.description ?? '',
          `- Owner: ${table.owner ?? 'unassigned'}`,
          `- Migration: \`${table.migration ?? 'unknown'}\``,
          '| Column | Type | Nullable | Default |',
          '|---|---|---:|---|',
          ...table.columns.map(
            (column) =>
              `| ${column.name} | \`${column.type}\` | ${column.nullable} | ${column.default ?? ''} |`,
          ),
        ]),
      ].join('\n\n'),
    });
  views.push({
    viewId: 'decision-index',
    viewType: 'decisions',
    relativePath: 'Published/05 - Decisions/00 - Decision Index.md',
    body: `# Decision Index\n\n${data.decisions.map((decision) => `- **${decision.title}** (${decision.status ?? 'current'})`).join('\n') || '- No normalized decisions yet.'}`,
  });
  views.push({
    viewId: 'sync-status',
    viewType: 'sync',
    relativePath: 'Published/06 - Operations/00 - Sync Status.md',
    body: `# Sync Status\n\n- Database revision: ${data.dbRevision}\n- Git revision: \`${data.gitRevision}\`\n- Legacy notes: ${data.legacyCount}${data.domainSync ? `\n- Audited worktree: \`${data.domainSync.worktreePath}\`\n- Current worktree commit: \`${data.domainSync.currentCommit}\`\n- Indexed commit: \`${data.domainSync.indexedCommit ?? 'unindexed'}\`` : ''}\n\n## Domain status\n\n| Domain | State | Last synced | Current | Changes |\n|---|---|---|---|---:|\n${domainRows.map((domain) => `| ${domain.name} | ${domain.state} | \`${domain.lastSyncedCommit ?? 'unindexed'}\` | \`${domain.currentCommit}\` | ${domain.changedPaths.length} |`).join('\n') || '| No domain audit available | missing | | | 0 |'}\n\n## Unmapped changes\n\n${data.domainSync?.unmappedChanges.map((changedPath) => `- \`${changedPath}\``).join('\n') || '- None'}\n\n## Projections\n\n| Projection | State | Revision |\n|---|---|---:|\n${data.projections
      .filter((item) => !item.path.endsWith('00 - Sync Status.md'))
      .map((item) =>
        `| ${item.path} | ${item.state} | ${item.state === 'current' ? data.dbRevision : item.revision} |`,
      )
      .join('\n')}`,
  });
  views.push({
    viewId: 'change-history',
    viewType: 'history',
    relativePath: 'Published/06 - Operations/01 - Change History.md',
    body: `# Change History\n\nVersioned status events are retained in PostgreSQL.\n\n## 2026-09-06 — Projection cleanup\n\n- Refreshed the published knowledge set from clean \`${data.gitRevision}\` at database revision ${data.dbRevision}.\n- Domain documentation remains the primary published architecture view.\n- Agent task status remains database-only; retired \`Published/02 - Delivery/Tasks/\` projections are not regenerated.`,
  });
  views.push({
    viewId: 'legacy-manifest',
    viewType: 'legacy-manifest',
    relativePath: 'Published/90 - Reference/Legacy Manifest.md',
    body: `# Legacy Manifest\n\n| Original path | Planned archive path | SQL record | Raw SHA-256 |\n|---|---|---|---|\n${(data.legacy ?? []).map((item) => `| ${item.originalPath} | Archive/Legacy-2026-09-05/${item.originalPath} | \`${item.id}\` | \`${item.rawHash}\` |`).join('\n')}`,
  });
  return views;
}
