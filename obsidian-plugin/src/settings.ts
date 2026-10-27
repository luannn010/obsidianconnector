import { PluginSettingTab, Setting, type App } from 'obsidian';
import type ProjectBoardPlugin from './main';
import { loadProjectInfo } from './vault';

export interface ProjectBoardSettings {
  /** Overrides `repoPath` from `Board/.project.json` for this vault. */
  repoPathOverride: string;
  terminalCommand: string;
  codexCommand: string;
}

export const DEFAULT_SETTINGS: ProjectBoardSettings = {
  repoPathOverride: '',
  terminalCommand: 'wt.exe',
  codexCommand: 'codex',
};

export class ProjectBoardSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ProjectBoardPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const detected = containerEl.createEl('p', {
      cls: 'setting-item-description',
    });
    void loadProjectInfo(this.app, {
      ...this.plugin.settings,
      repoPathOverride: '',
    }).then((info) => {
      detected.setText(
        info.projectKey || info.repoPath
          ? `From Board/.project.json: project "${info.projectKey || '?'}", repository ${info.repoPath || '(none)'}`
          : 'Board/.project.json was not found. Run project setup or set the repository path below.',
      );
    });

    new Setting(containerEl)
      .setName('Repository path override')
      .setDesc('Leave empty to use repoPath from Board/.project.json.')
      .addText((text) =>
        text
          .setPlaceholder('C:\\Users\\me\\Repos\\Project')
          .setValue(this.plugin.settings.repoPathOverride)
          .onChange(async (value) => {
            this.plugin.settings.repoPathOverride = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Terminal command')
      .setDesc(
        'Windows Terminal executable used for "Plan with Codex". Falls back to cmd start when it fails.',
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.terminalCommand)
          .onChange(async (value) => {
            this.plugin.settings.terminalCommand =
              value.trim() || DEFAULT_SETTINGS.terminalCommand;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Codex command')
      .setDesc(
        'Command that starts Codex, resolved on PATH (a path without spaces).',
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.codexCommand)
          .onChange(async (value) => {
            this.plugin.settings.codexCommand =
              value.trim() || DEFAULT_SETTINGS.codexCommand;
            await this.plugin.saveSettings();
          }),
      );
  }
}
