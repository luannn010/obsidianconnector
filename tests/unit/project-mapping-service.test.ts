import { describe, expect, it } from 'vitest';
import {
  createDefaultProjectMapping,
  flattenProjectMapping,
  parseProjectMapping,
} from '../../src/services/project-mapping-service.js';

describe('project mapping service', () => {
  it('flattens nested documentation groups and preserves semantic aliases', () => {
    const mapping = parseProjectMapping(`
schemaVersion: 1
vault: personal
tree:
  - id: planning
    title: Planning
    type: group
    children:
      - id: task_list
        title: Tasks
        type: note
        path: Planning/Tasks.md
        alias: tasks
      - id: decisions
        title: Decisions
        type: note
        path: Planning/Decisions.md
        alias: decisions
  - id: architecture
    title: Architecture
    type: note
    path: Technical/Architecture.md
`);

    expect(flattenProjectMapping(mapping)).toEqual({
      roles: {
        'planning.task_list': 'Planning/Tasks.md',
        'planning.decisions': 'Planning/Decisions.md',
        architecture: 'Technical/Architecture.md',
      },
      aliases: {
        tasks: 'planning.task_list',
        decisions: 'planning.decisions',
      },
      notes: [
        expect.objectContaining({
          role: 'planning.task_list',
          path: 'Planning/Tasks.md',
        }),
        expect.objectContaining({
          role: 'planning.decisions',
          path: 'Planning/Decisions.md',
        }),
        expect.objectContaining({
          role: 'architecture',
          path: 'Technical/Architecture.md',
        }),
      ],
    });
  });

  it('rejects duplicate ids and unsafe note paths', () => {
    expect(() =>
      parseProjectMapping(`
schemaVersion: 1
vault: personal
tree:
  - id: duplicate
    title: One
    type: note
    path: One.md
  - id: duplicate
    title: Two
    type: note
    path: Two.md
`),
    ).toThrow('duplicate');

    expect(() =>
      parseProjectMapping(`
schemaVersion: 1
vault: personal
tree:
  - id: unsafe
    title: Unsafe
    type: note
    path: ../Unsafe.md
`),
    ).toThrow();
  });

  it('creates the default tree with legacy semantic aliases', () => {
    const mapping = createDefaultProjectMapping('personal');
    const flattened = flattenProjectMapping(mapping);

    expect(flattened.aliases).toMatchObject({
      home: expect.any(String),
      tasks: expect.any(String),
      decisions: expect.any(String),
      risks: expect.any(String),
      changelog: expect.any(String),
    });
    expect(flattened.roles[flattened.aliases.tasks as string]).toBe(
      '06 - Tasks.md',
    );
  });
});
