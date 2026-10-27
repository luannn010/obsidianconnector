import {
  MarkdownView,
  Notice,
  Plugin,
  TFile,
  type WorkspaceLeaf,
} from 'obsidian';
import { startInClaude } from './actions';
import { BoardView, VIEW_TYPE_BOARD } from './board-view';
import { GalleryView, VIEW_TYPE_GALLERY } from './gallery-view';
import { BOARD_DIR } from './model';
import {
  DEFAULT_SETTINGS,
  ProjectBoardSettingTab,
  type ProjectBoardSettings,
} from './settings';
import { cardForFile } from './vault';

const BOARD_VIEWS: Record<string, string> = {
  ideas: VIEW_TYPE_BOARD,
  prototypes: VIEW_TYPE_GALLERY,
};

export default class ProjectBoardPlugin extends Plugin {
  override settings: ProjectBoardSettings = { ...DEFAULT_SETTINGS };

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_BOARD, (leaf) => new BoardView(leaf, this));
    this.registerView(VIEW_TYPE_GALLERY, (leaf) => new GalleryView(leaf, this));
    this.addSettingTab(new ProjectBoardSettingTab(this.app, this));

    this.addRibbonIcon(
      'kanban-square',
      'Open project board',
      () => void this.activateBoard(),
    );

    this.addCommand({
      id: 'open-board',
      name: 'Open project board',
      callback: () => void this.activateBoard(),
    });
    this.addCommand({
      id: 'open-gallery',
      name: 'Open prototype gallery',
      callback: () => void this.activateGallery(),
    });
    this.addCommand({
      id: 'start-current-card-in-claude',
      name: 'Start current card in Claude',
      checkCallback: (checking) => {
        const card = cardForFile(this.app, this.app.workspace.getActiveFile());
        if (!card) return false;
        if (!checking) {
          if (card.status !== 'ready') {
            new Notice(
              `"${card.title}" is ${card.status}. Approve its plan before starting it in Claude.`,
            );
          } else {
            void startInClaude(this.app, this.settings, card);
          }
        }
        return true;
      },
    });

    // Board/Board.md (`board: ideas`) and Board/Prototypes.md (`board: prototypes`) open as views.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) =>
        this.redirectBoardNote(file),
      ),
    );
  }

  private redirectBoardNote(file: TFile | null): void {
    if (!file || !file.path.startsWith(`${BOARD_DIR}/`)) return;
    const kind: unknown =
      this.app.metadataCache.getFileCache(file)?.frontmatter?.board;
    const viewType = typeof kind === 'string' ? BOARD_VIEWS[kind] : undefined;
    if (!viewType) return;
    const leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
    if (!leaf || (leaf.view as MarkdownView).file?.path !== file.path) return;
    // Defer so Obsidian finishes opening the note before the leaf switches view.
    window.setTimeout(
      () => void leaf.setViewState({ type: viewType, active: true }),
      0,
    );
  }

  async activateBoard(): Promise<void> {
    await this.activateView(VIEW_TYPE_BOARD);
  }

  async activateGallery(): Promise<void> {
    await this.activateView(VIEW_TYPE_GALLERY);
  }

  private async activateView(viewType: string): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(viewType)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: viewType, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  async loadSettings(): Promise<void> {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as Partial<ProjectBoardSettings> | null),
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
