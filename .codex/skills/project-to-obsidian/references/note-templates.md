# Project note templates

Use this frontmatter on project notes:

```yaml
---
project_key: myNewProject
project_name: 'My New Project'
type: plan
status: active
created: 2026-07-30
updated: 2026-07-30
tags:
  - project/myNewProject
---
```

## File purposes

- `00 - Project Home.md`: summary, status, navigation links, current focus, and next review date.
- `01 - Brief.md`: problem, users, context, scope, non-goals, and assumptions.
- `02 - Goals & Success Criteria.md`: outcomes, measurable success criteria, and milestones.
- `03 - Requirements.md`: functional requirements, constraints, acceptance criteria, and open questions.
- `04 - Decisions.md`: date, decision, context, alternatives, rationale, and consequences.
- `05 - Plans.md`: phases, sequence, dependencies, and implementation approach.
- `06 - Tasks.md`: task, owner, status, priority, due date, and related notes.
- `07 - Research.md`: findings, sources, evidence, comparisons, and implications.
- `08 - Meeting Notes.md`: date, participants, topics, summary, decisions, and actions.
- `09 - Resources.md`: links, files, tools, references, and contacts.
- `10 - Risks & Issues.md`: risk/issue, impact, likelihood, mitigation, owner, and status.
- `11 - Changelog.md`: date, change, affected notes, and reason.

## Append format

When adding material, use a dated heading and keep entries atomic:

```markdown
## 2026-07-30 — Topic

### Summary

- ...

### Decisions

- ...

### Actions

- [ ] ...
```

Use `Inbox/` for material that cannot yet be classified. Move it later only after the user confirms its destination.
