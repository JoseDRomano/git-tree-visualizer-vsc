import * as vscode from 'vscode';
import * as path from 'path';
import {
  findRepoRoot, getCommitDetails, getCommonDir, getMergePreview, getWorktreeChanges, loadSnapshot, MergePreview, performMerge, setGitPath,
} from './git';
import { Worktree } from './types';
import { buildGraph, Mode } from './graph';
import { buildBranchTree } from './tree';

interface ViewOptions {
  view: 'tree' | 'graph';
  mode: Mode;
  remotes: boolean;
  tags: boolean;
  maxCommits: number;
}

interface Repo {
  root: string;
  name: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const configuredGit = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  setGitPath(Array.isArray(configuredGit) ? configuredGit[0] : configuredGit);
  const sidebar = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('gitTreeVisualizer.show', () => GitTreePanel.show(context)),
    vscode.commands.registerCommand('gitTreeVisualizer.refresh', () => {
      GitTreePanel.current?.controller.refresh(true);
      sidebar.controller?.refresh(true);
    }),
    vscode.window.registerWebviewPanelSerializer(GitTreePanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        GitTreePanel.revive(panel, context);
      },
    })
  );
}

export function deactivate(): void {
  GitTreePanel.current?.dispose();
}

const webviewOptions = (context: vscode.ExtensionContext): vscode.WebviewOptions => ({
  enableScripts: true,
  localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
});

/** The tree in the activity bar's own sidebar view. */
class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gitTreeVisualizer.tree';
  controller: TreeController | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.controller?.dispose();
    const controller = new TreeController(view.webview, () => view.visible, this.context, 'sidebar');
    this.controller = controller;
    view.onDidChangeVisibility(() => {
      if (view.visible) controller.onVisible();
    });
    view.onDidDispose(() => {
      controller.dispose();
      if (this.controller === controller) this.controller = undefined;
    });
  }
}

/** The tree in an editor tab, opened with the "Show Git Tree" command. */
class GitTreePanel {
  static readonly viewType = 'gitTreeVisualizer';
  static current: GitTreePanel | undefined;
  readonly controller: TreeController;

  static show(context: vscode.ExtensionContext): void {
    if (GitTreePanel.current) {
      GitTreePanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(GitTreePanel.viewType, 'Git Tree', vscode.ViewColumn.Active, {
      ...webviewOptions(context),
      retainContextWhenHidden: true,
    });
    GitTreePanel.current = new GitTreePanel(panel, context);
  }

  static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): void {
    GitTreePanel.current = new GitTreePanel(panel, context);
  }

  private constructor(private readonly panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    this.controller = new TreeController(panel.webview, () => panel.visible, context, 'panel');
    panel.onDidChangeViewState(e => {
      if (e.webviewPanel.visible) this.controller.onVisible();
    });
    panel.onDidDispose(() => {
      this.controller.dispose();
      GitTreePanel.current = undefined;
    });
  }

  dispose(): void {
    this.panel.dispose();
  }
}

/** Loads the repository, feeds one webview (panel or sidebar) and handles its messages. */
class TreeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private watchedDir: string | undefined;
  private repos: Repo[] = [];
  private activeRoot: string | undefined;
  private options: ViewOptions;
  private refreshTimer: NodeJS.Timeout | undefined;
  private loadSeq = 0;
  private stale = false;
  private lastPayload = '';
  private worktrees: Worktree[] = [];

  constructor(
    private readonly webview: vscode.Webview,
    private readonly isVisible: () => boolean,
    private readonly context: vscode.ExtensionContext,
    private readonly host: 'panel' | 'sidebar'
  ) {
    const cfg = vscode.workspace.getConfiguration('gitTreeVisualizer');
    this.options = {
      view: cfg.get<'tree' | 'graph'>('defaultView', 'tree'),
      mode: cfg.get<Mode>('defaultMode', 'full'),
      remotes: cfg.get<boolean>('showRemoteBranches', true),
      tags: cfg.get<boolean>('showTags', true),
      maxCommits: cfg.get<number>('maxCommits', 1000),
    };

    webview.options = webviewOptions(context);
    webview.html = this.html();
    webview.onDidReceiveMessage(m => this.onMessage(m), null, this.disposables);
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await this.discoverRepos();
      this.refresh(true);
    }, null, this.disposables);
    // Edits saved in any worktree change its "uncommitted changes" count.
    vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh(1000), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('gitTreeVisualizer.productionBranch')) this.refresh();
    }, null, this.disposables);
  }

  /** The production branch configured for a repository, if any (else it is detected). */
  private productionBranch(root: string): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    return vscode.workspace.getConfiguration('gitTreeVisualizer', folder?.uri).get<string>('productionBranch')?.trim() || undefined;
  }

  /** Saves the production branch in the settings of the workspace folder holding the repository. */
  private async setProductionBranch(root: string, name: string | undefined): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    const target = !folder ? vscode.ConfigurationTarget.Global
      : vscode.workspace.workspaceFile ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    try {
      await vscode.workspace.getConfiguration('gitTreeVisualizer', folder?.uri).update('productionBranch', name || undefined, target);
      vscode.window.setStatusBarMessage(name ? `Production branch: ${name}` : 'Production branch: detected automatically', 3000);
    } catch (e) {
      vscode.window.showErrorMessage(`Can't save the production branch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Catch up on changes that happened while hidden. */
  onVisible(): void {
    if (this.stale) this.refresh();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.watcher?.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private post(msg: unknown): void {
    this.webview.postMessage(msg);
  }

  private async discoverRepos(): Promise<void> {
    const dirs = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') dirs.push(path.dirname(active.fsPath));

    const roots = await Promise.all(dirs.map(d => findRepoRoot(d)));
    const seen = new Set<string>();
    this.repos = [];
    for (const root of roots) {
      if (!root || seen.has(root)) continue;
      seen.add(root);
      this.repos.push({ root, name: path.basename(root) });
    }

    if (!this.activeRoot || !seen.has(this.activeRoot)) {
      const activeRoot = active?.scheme === 'file'
        ? this.repos.find(r => active.fsPath.startsWith(r.root + path.sep))?.root
        : undefined;
      this.activeRoot = activeRoot ?? this.repos[0]?.root;
    }
  }

  private scheduleRefresh(delay = 400): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), delay);
  }

  async refresh(force = false): Promise<void> {
    if (!this.isVisible()) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const seq = ++this.loadSeq;
    if (force) this.lastPayload = '';

    if (!this.repos.length) await this.discoverRepos();
    const root = this.activeRoot;
    if (!root) {
      this.post({ type: 'empty', message: 'No git repository found in this workspace.' });
      return;
    }

    this.post({ type: 'loading' });
    try {
      const snap = await loadSnapshot(root, this.options);
      if (seq !== this.loadSeq) return;
      this.worktrees = snap.worktrees;
      const production = this.productionBranch(root);
      const tree = buildBranchTree(snap, production);
      const graph = this.options.view === 'graph' ? buildGraph(snap, this.options.mode) : null;
      const payload = JSON.stringify({
        type: 'data',
        repos: this.repos,
        activeRoot: root,
        options: this.options,
        production: production ?? null,
        snapshot: {
          root: snap.root,
          name: snap.name,
          head: snap.head,
          headBranch: snap.headBranch,
          worktrees: snap.worktrees,
          truncated: snap.truncated,
          commitCount: snap.commits.length,
          branchCount: snap.refs.filter(r => r.kind === 'branch').length,
        },
        tree,
        graph,
      });
      if (payload === this.lastPayload) {
        this.post({ type: 'unchanged' });
      } else {
        this.lastPayload = payload;
        this.post(JSON.parse(payload));
      }
      this.ensureWatcher(root);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async ensureWatcher(root: string): Promise<void> {
    let dir: string;
    try {
      dir = await getCommonDir(root);
    } catch {
      return;
    }
    if (dir === this.watchedDir) return;
    this.watcher?.dispose();
    this.watchedDir = dir;
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '{HEAD,index,packed-refs,refs/**,worktrees/*/HEAD,worktrees/*/index}')
    );
    const onChange = () => this.scheduleRefresh();
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case 'ready':
        await this.discoverRepos();
        this.refresh(true);
        break;
      case 'refresh':
        await this.discoverRepos();
        this.refresh(true);
        break;
      case 'setOptions':
        this.options = { ...this.options, ...m.options };
        this.refresh();
        break;
      case 'selectRepo':
        this.activeRoot = m.root;
        this.refresh(true);
        break;
      case 'setProduction':
        if (this.activeRoot) await this.setProductionBranch(this.activeRoot, m.name);
        break;
      case 'commitDetails':
        if (!this.activeRoot) return;
        try {
          const details = await getCommitDetails(this.activeRoot, m.hash);
          this.post({ type: 'commitDetails', hash: m.hash, details });
        } catch (e) {
          this.post({ type: 'commitDetails', hash: m.hash, error: e instanceof Error ? e.message : String(e) });
        }
        break;
      case 'wipDetails':
        try {
          const files = await getWorktreeChanges(m.path);
          this.post({ type: 'wipDetails', hash: m.hash, files });
        } catch (e) {
          this.post({ type: 'wipDetails', hash: m.hash, error: e instanceof Error ? e.message : String(e) });
        }
        break;
      case 'openWorktree':
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.path), { forceNewWindow: true });
        break;
      case 'mergePreview':
        if (!this.activeRoot) return;
        try {
          const preview = await getMergePreview(this.activeRoot, m.source, m.target, this.worktrees);
          this.post({ type: 'mergePreview', key: m.key, preview });
        } catch (e) {
          this.post({ type: 'mergePreview', key: m.key, error: e instanceof Error ? e.message : String(e) });
        }
        break;
      case 'merge':
        await this.merge(m.key, m.source, m.target);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text));
        vscode.window.setStatusBarMessage(`Copied ${m.text}`, 2000);
        break;
    }
  }

  private async merge(key: string, source: string, target: string): Promise<void> {
    const root = this.activeRoot;
    if (!root) return;
    const done = (result: Record<string, unknown>) => this.post({ type: 'mergeDone', key, ...result });
    let preview: MergePreview;
    try {
      preview = await getMergePreview(root, source, target, this.worktrees);
    } catch (e) {
      vscode.window.showErrorMessage(`Can't merge: ${e instanceof Error ? e.message : String(e)}`);
      return done({ ok: false });
    }

    const how = preview.fastForward
      ? `'${target}' will fast-forward to '${source}' (${preview.incoming} commit${preview.incoming === 1 ? '' : 's'}).`
      : `A merge commit will be created on '${target}', bringing in ${preview.incoming} commit${preview.incoming === 1 ? '' : 's'}.`;
    const where = preview.worktree
      ? `Runs \`git merge\` in the worktree '${preview.worktree.name}', where '${target}' is checked out.` +
        (preview.conflicts?.length ? ` It will stop with conflicts in ${preview.conflicts.length} file(s) for you to resolve there.` : '')
      : `'${target}' isn't checked out anywhere, so the branch is updated directly.`;
    const choice = await vscode.window.showWarningMessage(
      `Merge '${source}' into '${target}'?`, { modal: true, detail: `${how}\n\n${where}` }, 'Merge'
    );
    if (choice !== 'Merge') return done({ ok: false, cancelled: true });

    try {
      const r = await performMerge(root, source, target, this.worktrees);
      if (r.status === 'conflicts') {
        const open = r.worktree && path.resolve(r.worktree) !== path.resolve(root) ? 'Open Worktree' : 'Open Source Control';
        vscode.window.showWarningMessage(
          `Merging '${source}' into '${target}' stopped with conflicts. Resolve them and commit to finish the merge.`, open
        ).then(c => {
          if (c === 'Open Worktree') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(r.worktree!), { forceNewWindow: true });
          else if (c === 'Open Source Control') vscode.commands.executeCommand('workbench.view.scm');
        });
      } else {
        const msg = r.status === 'up-to-date' ? `'${target}' already contains '${source}'.`
          : r.status === 'fast-forward' ? `Fast-forwarded '${target}' to '${source}'.` : `Merged '${source}' into '${target}'.`;
        vscode.window.showInformationMessage(msg);
      }
      done({ ok: true, status: r.status });
    } catch (e) {
      vscode.window.showErrorMessage(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
      done({ ok: false });
    }
    this.refresh(true);
  }

  private html(): string {
    const webview = this.webview;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('main.css')}">
  <title>Git Tree</title>
</head>
<body data-host="${this.host}">
  <div id="app"></div>
  <script nonce="${nonce}" src="${media('particles.js')}"></script>
  <script nonce="${nonce}" src="${media('tree.js')}"></script>
  <script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}
