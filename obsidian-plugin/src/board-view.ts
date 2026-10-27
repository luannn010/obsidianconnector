// Kanban board of idea cards, one column per status.

import {
  ItemView,
  Notice,
  debounce,
  setIcon,
  type WorkspaceLeaf,
} from 'obsidian';
import { CardPanelModal } from './card-panel';
import type ProjectBoardPlugin from './main';
import {
  CARDS_DIR,
  STATUSES,
  STATUS_LABELS,
  cardPrototypes,
  groupByStatus,
  isStatus,
} from './model';
import { collectCards, findCard, setCardStatus } from './vault';

export const VIEW_TYPE_BOARD = 'project-board-ideas';

const DRAG_TYPE = 'application/x-project-board-card';

export class BoardView extends ItemView {
  private readonly refresh = debounce(() => this.render(), 150, true);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ProjectBoardPlugin,
  ) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_BOARD;
  }

  override getDisplayText(): string {
    return 'Project board';
  }

  override getIcon(): string {
    return 'kanban-square';
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
        'delete',
        (file) => isCardPath(file.path) && this.refresh(),
      ),
    );
    this.registerEvent(
      this.app.vault.on(
        'rename',
        (file, oldPath) =>
          (isCardPath(file.path) || isCardPath(oldPath)) && this.refresh(),
      ),
    );
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('project-board-root');

    const header = root.createDiv({ cls: 'project-board-header' });
    header.createEl('h3', { text: 'Ideas board' });
    const gallery = header.createEl('button', { text: 'Prototype gallery' });
    gallery.onclick = () => void this.plugin.activateGallery();

    const cards = collectCards(this.app);
    const columns = groupByStatus(cards);
    const board = root.createDiv({ cls: 'project-board-columns' });

    for (const status of STATUSES) {
      const column = board.createDiv({
        cls: `project-board-column status-${status}`,
      });
      const title = column.createDiv({ cls: 'project-board-column-title' });
      title.createSpan({ text: STATUS_LABELS[status] });
      title.createSpan({
        text: String(columns[status].length),
        cls: 'project-board-count',
      });
      const list = column.createDiv({ cls: 'project-board-card-list' });

      column.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        column.addClass('is-drop-target');
      });
      column.addEventListener('dragleave', (event) => {
        if (!column.contains(event.relatedTarget as Node | null))
          column.removeClass('is-drop-target');
      });
      column.addEventListener('drop', (event) => {
        event.preventDefault();
        column.removeClass('is-drop-target');
        const path = event.dataTransfer?.getData(DRAG_TYPE);
        const card = path ? findCard(this.app, path) : null;
        if (!card || card.status === status || !isStatus(status)) return;
        setCardStatus(this.app, card, status).catch(
          (error: unknown) =>
            new Notice(
              `Could not move card: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
      });

      for (const card of columns[status]) {
        const item = list.createDiv({
          cls: 'project-board-card',
          attr: { draggable: 'true' },
        });
        item.createDiv({ text: card.title, cls: 'project-board-card-title' });
        const footer = item.createDiv({ cls: 'project-board-card-footer' });
        if (card.priority)
          footer.createSpan({
            text: card.priority,
            cls: 'project-board-priority',
          });
        const count = cardPrototypes(card).length;
        if (count > 0) {
          const badge = footer.createSpan({
            cls: 'project-board-proto-count',
            attr: { title: 'Prototypes' },
          });
          setIcon(badge.createSpan(), 'layout-template');
          badge.appendText(String(count));
        }
        if (card.reviewNote)
          footer.createSpan({
            text: 'changes requested',
            cls: 'project-board-flag',
          });

        item.addEventListener('dragstart', (event) => {
          event.dataTransfer?.setData(DRAG_TYPE, card.filePath);
          event.dataTransfer?.setData('text/plain', card.title);
          item.addClass('is-dragging');
        });
        item.addEventListener('dragend', () => item.removeClass('is-dragging'));
        item.addEventListener('click', () =>
          new CardPanelModal(this.app, this.plugin, card).open(),
        );
      }
    }

    if (cards.length === 0) {
      root.createEl('p', {
        cls: 'project-board-muted',
        text: 'No cards yet. Write ideas in Ideas.md and ask an agent to triage them into cards.',
      });
    }
  }
}
