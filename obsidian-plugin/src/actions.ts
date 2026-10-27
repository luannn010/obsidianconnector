// Card workflow actions: plan with Codex, approve, request changes, start in Claude.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { Notice, type App } from 'obsidian';
import type { Card, PrototypeType } from './model';
import {
  buildBuildPrompt,
  buildClaudeShortPrompt,
  buildClaudeUrl,
  buildCmdFallbackLaunch,
  buildCodexMessage,
  buildPlanPrompt,
  buildTerminalLaunch,
  type LaunchSpec,
  type PromptContext,
} from './prompts';
import type { ProjectBoardSettings } from './settings';
import {
  absolutePath,
  loadProjectInfo,
  readCardBody,
  setCardStatus,
  updateCard,
  writeVaultFile,
} from './vault';

async function promptContext(
  app: App,
  settings: ProjectBoardSettings,
  card: Card,
): Promise<PromptContext | null> {
  const info = await loadProjectInfo(app, settings);
  const projectKey = card.projectKey || info.projectKey;
  if (!info.repoPath || !existsSync(info.repoPath)) {
    new Notice(
      info.repoPath
        ? `Repository path does not exist: ${info.repoPath}`
        : 'No repository path. Check Board/.project.json or the Project Board settings.',
    );
    return null;
  }
  if (!projectKey) {
    new Notice('No project key on the card or in Board/.project.json.');
    return null;
  }
  return {
    card,
    body: await readCardBody(app, card),
    projectKey,
    repoPath: info.repoPath,
    cardFolderAbs: absolutePath(app, card.folder),
  };
}

function launch(spec: LaunchSpec, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(spec.command, spec.args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: spec.verbatim,
      });
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
      child.once('spawn', () => {
        child.unref();
        // wt.exe hands off and exits quickly; treat a running process as success.
        window.setTimeout(() => finish(true), 3000);
      });
    } catch {
      finish(false);
    }
  });
}

export async function setPrototypesRequested(
  app: App,
  card: Card,
  types: PrototypeType[],
): Promise<void> {
  await updateCard(app, card, (frontmatter) => {
    frontmatter.prototypes_requested = types;
  });
}

export async function planWithCodex(
  app: App,
  settings: ProjectBoardSettings,
  card: Card,
): Promise<void> {
  const context = await promptContext(app, settings, card);
  if (!context) return;
  const promptPath = `${card.folder}/prompts/plan.md`;
  await writeVaultFile(app, promptPath, buildPlanPrompt(context));

  const message = buildCodexMessage(
    card.slug,
    context.projectKey,
    absolutePath(app, promptPath),
  );
  const primary = buildTerminalLaunch(
    settings.terminalCommand,
    settings.codexCommand,
    context.repoPath,
    message,
  );
  let ok = await launch(primary, context.repoPath);
  if (!ok)
    ok = await launch(
      buildCmdFallbackLaunch(settings.codexCommand, context.repoPath, message),
      context.repoPath,
    );
  if (!ok) {
    new Notice(
      `Could not start Codex. Run it yourself in ${context.repoPath} with the prompt in ${promptPath}.`,
    );
    return;
  }
  await setCardStatus(app, card, 'planning');
  new Notice(`Codex is planning "${card.title}".`);
}

export async function startInClaude(
  app: App,
  settings: ProjectBoardSettings,
  card: Card,
): Promise<void> {
  const context = await promptContext(app, settings, card);
  if (!context) return;
  await writeVaultFile(
    app,
    `${card.folder}/prompts/build.md`,
    buildBuildPrompt(context),
  );
  const url = buildClaudeUrl(
    buildClaudeShortPrompt(card, context.projectKey, context.cardFolderAbs),
    context.repoPath,
  );
  window.open(url);
  await setCardStatus(app, card, 'building');
  new Notice(
    `Opened Claude for "${card.title}". Confirm the folder and send the prompt.`,
  );
}

export async function approvePlan(app: App, card: Card): Promise<void> {
  await setCardStatus(app, card, 'ready', { review_note: '' });
  new Notice(`Plan approved: "${card.title}" is ready.`);
}

export async function requestChanges(
  app: App,
  card: Card,
  note: string,
): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) throw new Error('A review note is required.');
  await setCardStatus(app, card, 'planning', { review_note: trimmed });
  new Notice(
    `Changes requested on "${card.title}". Re-plan with Codex to apply them.`,
  );
}

export function openFolder(folder: string): void {
  // Electron is provided by Obsidian desktop at runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require('electron') as {
    shell: { openPath(target: string): Promise<string> };
  };
  void shell.openPath(folder).then((error) => {
    if (error) new Notice(`Could not open ${folder}: ${error}`);
  });
}
