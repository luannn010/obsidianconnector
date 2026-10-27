// Card panel modal: plan, prototype, and spike tabs plus status-dependent actions.

import {
  Component,
  MarkdownRenderer,
  Modal,
  Notice,
  setIcon,
  type App,
} from 'obsidian';
import {
  PROTOTYPE_TYPES,
  STATUS_LABELS,
  cardPrototypes,
  planPath,
  type Card,
  type Prototype,
  type PrototypeType,
} from './model';
import {
  approvePlan,
  openFolder,
  planWithCodex,
  requestChanges,
  setPrototypesRequested,
  startInClaude,
} from './actions';
import type ProjectBoardPlugin from './main';
import { findCard, loadProjectInfo, readIfExists } from './vault';

/** Renders HTML in a sandboxed iframe: scripts run, but without same-origin access to Obsidian. */
export function sandboxedFrame(
  parent: HTMLElement,
  html: string,
  cls: string,
): HTMLIFrameElement {
  const frame = parent.createEl('iframe', { cls });
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = html;
  return frame;
}

export async function renderPrototype(
  app: App,
  plugin: ProjectBoardPlugin,
  prototype: Prototype,
  el: HTMLElement,
  component: Component,
): Promise<void> {
  if (prototype.kind === 'spike') {
    el.createEl('p', { text: 'Code spike branch:' });
    el.createEl('code', {
      text: prototype.branch ?? '(none)',
      cls: 'project-board-branch',
    });
    const info = await loadProjectInfo(app, plugin.settings);
    const row = el.createDiv({ cls: 'project-board-actions' });
    const button = row.createEl('button', { text: 'Open repository folder' });
    button.disabled = !info.repoPath;
    button.onclick = () => openFolder(info.repoPath);
    if (prototype.branch) {
      const copy = row.createEl('button', { text: 'Copy branch name' });
      copy.onclick = () => {
        void navigator.clipboard.writeText(prototype.branch ?? '');
        new Notice('Branch name copied.');
      };
    }
    return;
  }
  if (!prototype.vaultPath) return;
  if (prototype.kind === 'svg') {
    // An <img> never runs scripts embedded in the SVG.
    el.createEl('img', {
      cls: 'project-board-svg',
      attr: {
        src: app.vault.adapter.getResourcePath(prototype.vaultPath),
        alt: prototype.title,
      },
    });
    return;
  }
  const text = await readIfExists(app, prototype.vaultPath);
  if (text === null) {
    el.createEl('p', {
      text: `Missing file: ${prototype.vaultPath}`,
      cls: 'project-board-muted',
    });
    return;
  }
  if (prototype.kind === 'html') {
    sandboxedFrame(el, text, 'project-board-frame');
  } else if (prototype.kind === 'mermaid') {
    await MarkdownRenderer.render(
      app,
      '```mermaid\n' + text.trim() + '\n```',
      el,
      prototype.vaultPath,
      component,
    );
  } else if (prototype.kind === 'markdown') {
    await MarkdownRenderer.render(
      app,
      text,
      el,
      prototype.vaultPath,
      component,
    );
  } else {
    el.createEl('pre', { text });
  }
}

export class RequestChangesModal extends Modal {
  constructor(
    app: App,
    private readonly card: Card,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(`Request changes: ${this.card.title}`);
    const input = this.contentEl.createEl('textarea', {
      cls: 'project-board-note',
      attr: {
        rows: '6',
        placeholder: 'What should change in the plan or prototypes? (required)',
      },
    });
    const row = this.contentEl.createDiv({ cls: 'project-board-actions' });
    const submit = row.createEl('button', {
      text: 'Send back to planning',
      cls: 'mod-warning',
    });
    submit.disabled = true;
    input.oninput = () => {
      submit.disabled = input.value.trim().length === 0;
    };
    submit.onclick = async () => {
      if (!input.value.trim()) return;
      await requestChanges(this.app, this.card, input.value);
      this.close();
    };
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    input.focus();
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

export class CardPanelModal extends Modal {
  private component = new Component();
  private renderToken = 0;
  private card: Card;
  private activeTab: number;

  constructor(
    app: App,
    private readonly plugin: ProjectBoardPlugin,
    card: Card,
    initialPrototype?: Prototype,
  ) {
    super(app);
    this.card = card;
    const prototypes = cardPrototypes(card);
    const index = initialPrototype
      ? prototypes.findIndex(
          (item) =>
            item.vaultPath === initialPrototype.vaultPath &&
            item.branch === initialPrototype.branch,
        )
      : -1;
    this.activeTab = index + 1; // tab 0 is the plan
  }

  override onOpen(): void {
    this.modalEl.addClass('project-board-panel-modal');
    void this.render();
  }

  override onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    // Child components from MarkdownRenderer belong to the previous render.
    this.component.unload();
    this.component = new Component();
    this.component.load();
    this.component.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (file.path !== this.card.filePath) return;
        const updated = findCard(this.app, file.path);
        if (updated) {
          this.card = updated;
          void this.render();
        }
      }),
    );

    const { card, contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(card.title);

    const meta = contentEl.createDiv({ cls: 'project-board-meta' });
    meta.createSpan({
      text: STATUS_LABELS[card.status],
      cls: `project-board-status status-${card.status}`,
    });
    if (card.priority)
      meta.createSpan({ text: card.priority, cls: 'project-board-priority' });
    if (card.reviewNote)
      meta.createDiv({
        text: `Review note: ${card.reviewNote}`,
        cls: 'project-board-review-note',
      });

    this.renderActions(contentEl.createDiv({ cls: 'project-board-actions' }));

    const prototypes = cardPrototypes(card);
    const tabs = contentEl.createDiv({ cls: 'project-board-tabs' });
    const labels = [
      'Plan',
      ...prototypes.map((item) =>
        item.kind === 'spike' ? `Spike` : item.title,
      ),
    ];
    if (this.activeTab >= labels.length) this.activeTab = 0;
    labels.forEach((label, index) => {
      const tab = tabs.createEl('button', {
        text: label,
        cls: 'project-board-tab',
      });
      if (index === this.activeTab) tab.addClass('is-active');
      tab.onclick = () => {
        this.activeTab = index;
        void this.render();
      };
    });

    const body = contentEl.createDiv({ cls: 'project-board-tab-body' });
    if (this.activeTab === 0) {
      const plan = await readIfExists(this.app, planPath(card));
      if (token !== this.renderToken) return;
      if (plan === null) {
        body.createEl('p', {
          text: 'No plan yet.',
          cls: 'project-board-muted',
        });
      } else {
        await MarkdownRenderer.render(
          this.app,
          plan,
          body,
          planPath(card),
          this.component,
        );
      }
    } else {
      const prototype = prototypes[this.activeTab - 1];
      if (prototype)
        await renderPrototype(
          this.app,
          this.plugin,
          prototype,
          body,
          this.component,
        );
    }
  }

  private renderActions(row: HTMLElement): void {
    const { app, card } = this;
    const settings = this.plugin.settings;
    const button = (
      text: string,
      onClick: () => Promise<void> | void,
      cls?: string,
    ): HTMLButtonElement => {
      const element = row.createEl('button', { text, ...(cls ? { cls } : {}) });
      element.onclick = async () => {
        element.disabled = true;
        try {
          await onClick();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          element.disabled = false;
        }
      };
      return element;
    };

    if (card.status === 'backlog' || card.status === 'planning') {
      const picker = row.createDiv({ cls: 'project-board-prototype-picker' });
      picker.createSpan({ text: 'Prototypes:' });
      for (const type of PROTOTYPE_TYPES) {
        const label = picker.createEl('label');
        const checkbox = label.createEl('input', {
          attr: { type: 'checkbox' },
        });
        checkbox.checked = card.prototypesRequested.includes(type);
        label.appendText(` ${type}`);
        checkbox.onchange = async () => {
          const selected = new Set<PrototypeType>(card.prototypesRequested);
          if (checkbox.checked) selected.add(type);
          else selected.delete(type);
          await setPrototypesRequested(
            app,
            card,
            PROTOTYPE_TYPES.filter((item) => selected.has(item)),
          );
        };
      }
      button(
        card.status === 'backlog' ? 'Plan with Codex' : 'Re-plan with Codex',
        () => planWithCodex(app, settings, card),
        'mod-cta',
      );
    }
    if (card.status === 'plan-review') {
      button('Approve plan', () => approvePlan(app, card), 'mod-cta');
      button('Request changes', () =>
        new RequestChangesModal(app, card).open(),
      );
    }
    if (card.status === 'ready') {
      button(
        'Start in Claude',
        () => startInClaude(app, settings, card),
        'mod-cta',
      );
    }
    const open = button('Open card note', async () => {
      await app.workspace.openLinkText(card.filePath, '', 'tab');
      this.close();
    });
    setIcon(open.createSpan({ cls: 'project-board-icon' }), 'file-text');
  }
}
