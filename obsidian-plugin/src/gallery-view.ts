// Grid of every prototype across cards, with status/type filters and review actions.

import { ItemView, debounce, setIcon, type WorkspaceLeaf } from 'obsidian';
import { approvePlan } from './actions';
import {
  CardPanelModal,
  RequestChangesModal,
  sandboxedFrame,
} from './card-panel';
import type ProjectBoardPlugin from './main';
import {
  CARDS_DIR,
  STATUSES,
  STATUS_LABELS,
  cardPrototypes,
  type CardStatus,
  type PrototypeKind,
} from './model';
import { collectCards, readIfExists } from './vault';

export const VIEW_TYPE_GALLERY = 'project-board-prototypes';

const KIND_ICONS: Record<PrototypeKind, string> = {
  html: 'layout-template',
  mermaid: 'git-fork',
  svg: 'image',
  markdown: 'file-text',
  spike: 'git-branch',
  other: 'file',
};

const KIND_LABELS: Record<PrototypeKind, string> = {
  html: 'HTML',
  mermaid: 'Diagram',
  svg: 'SVG',
  markdown: 'Markdown',
  spike: 'Spike',
  other: 'Other',
};

export class GalleryView extends ItemView {
  private statusFilter: CardStatus | 'all' = 'all';
  private kindFilter: PrototypeKind | 'all' = 'all';
  private renderToken = 0;
  private readonly refresh = debounce(() => void this.render(), 250, true);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ProjectBoardPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_GALLERY;
  }

  override getDisplayText(): string {
    return 'Prototype gallery';
  }

  override getIcon(): string {
    return 'layout-grid';
  }

  override async onOpen(): Promise<void> {
    const isCardPath = (path: string): boolean =>
      path.startsWith(`${CARDS_DIR}/`);
    this.registerEvent(
      this.app.metadataCache.on(
        'changed',
        (file) => isCardPath(file.path) && this.refresh(),
      ),
    );
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => this.refresh()),
    );
    this.registerEvent(
      this.app.vault.on(
        'modify',
        (file) => isCardPath(file.path) && this.refresh(),
      ),
    );
    this.registerEvent(
      this.app.vault.on(
        'delete',
        (file) => isCardPath(file.path) && this.refresh(),
      ),
    );
    await this.render();
  }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const root = this.contentEl;
    root.empty();
    root.addClass('project-board-root');

    const header = root.createDiv({ cls: 'project-board-header' });
    header.createEl('h3', { text: 'Prototype gallery' });
    const statusSelect = header.createEl('select', { cls: 'dropdown' });
    statusSelect.createEl('option', { text: 'All statuses', value: 'all' });
    for (const status of STATUSES)
      statusSelect.createEl('option', {
        text: STATUS_LABELS[status],
        value: status,
      });
    statusSelect.value = this.statusFilter;
    statusSelect.onchange = () => {
      this.statusFilter = statusSelect.value as CardStatus | 'all';
      void this.render();
    };
    const kindSelect = header.createEl('select', { cls: 'dropdown' });
    kindSelect.createEl('option', { text: 'All types', value: 'all' });
    for (const kind of Object.keys(KIND_LABELS) as PrototypeKind[]) {
      kindSelect.createEl('option', { text: KIND_LABELS[kind], value: kind });
    }
    kindSelect.value = this.kindFilter;
    kindSelect.onchange = () => {
      this.kindFilter = kindSelect.value as PrototypeKind | 'all';
      void this.render();
    };
    header.createEl('button', { text: 'Board' }).onclick = () =>
      void this.plugin.activateBoard();

    const grid = root.createDiv({ cls: 'project-board-gallery' });
    let shown = 0;
    for (const card of collectCards(this.app)) {
      if (this.statusFilter !== 'all' && card.status !== this.statusFilter)
        continue;
      for (const prototype of cardPrototypes(card)) {
        if (this.kindFilter !== 'all' && prototype.kind !== this.kindFilter)
          continue;
        shown += 1;
        const tile = grid.createDiv({ cls: 'project-board-tile' });
        const preview = tile.createDiv({ cls: 'project-board-tile-preview' });
        const open = (): void =>
          new CardPanelModal(this.app, this.plugin, card, prototype).open();
        preview.onclick = open;

        if (prototype.kind === 'html' && prototype.vaultPath) {
          const html = await readIfExists(this.app, prototype.vaultPath);
          if (token !== this.renderToken) return;
          if (html !== null) {
            sandboxedFrame(preview, html, 'project-board-thumb');
            // The iframe swallows clicks; an overlay keeps the tile clickable.
            preview.createDiv({ cls: 'project-board-thumb-overlay' }).onclick =
              open;
          }
        } else {
          setIcon(
            preview.createDiv({ cls: 'project-board-tile-icon' }),
            KIND_ICONS[prototype.kind],
          );
        }

        const info = tile.createDiv({ cls: 'project-board-tile-info' });
        info.createDiv({
          text: prototype.title,
          cls: 'project-board-tile-title',
        });
        const meta = info.createDiv({ cls: 'project-board-tile-meta' });
        meta.createSpan({ text: card.title });
        meta.createSpan({
          text: STATUS_LABELS[card.status],
          cls: `project-board-status status-${card.status}`,
        });
        meta.createSpan({
          text: KIND_LABELS[prototype.kind],
          cls: 'project-board-kind',
        });

        if (card.status === 'plan-review') {
          const actions = info.createDiv({ cls: 'project-board-actions' });
          actions.createEl('button', {
            text: 'Approve',
            cls: 'mod-cta',
          }).onclick = () => void approvePlan(this.app, card);
          actions.createEl('button', { text: 'Request changes' }).onclick =
            () => new RequestChangesModal(this.app, card).open();
        }
      }
    }
    if (shown === 0)
      root.createEl('p', {
        text: 'No prototypes match these filters.',
        cls: 'project-board-muted',
      });
  }
}
