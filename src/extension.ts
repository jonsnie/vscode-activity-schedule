import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

type ActivityEntry = {
  id: string;
  projectName: string;
  description: string;
  branchName?: string;
  issueNumber?: number;
  issueTitle?: string;
  issueDescription?: string;
  createdAt: string;
  endedAt?: string;
  taskDurationMs?: number;
  workspaceOpenMs: number;
  typingMs: number;
  aiInterfaceOpenMs?: number;
  aiTypingMs?: number;
};

type IssueContext = {
  branchName: string;
  issueNumber: number;
  issueTitle: string;
  issueDescription: string;
  issueUrl: string;
};

type BranchContext = {
  branchName: string;
  branchTitle: string;
};

type TimerSnapshot = {
  projectName: string;
  currentOpenMs: number;
  todayOpenMs: number;
  totalOpenMs: number;
  openMsByDate: Record<string, number>;
  typingMs: number;
  aiCurrentOpenMs: number;
  aiTotalOpenMs: number;
  aiTypingMs: number;
  aiTotalMs: number;
  entries: ActivityEntry[];
  issueContext?: IssueContext;
  branchContext?: BranchContext;
  suggestedDescription?: string;
};

type OpenTimeState = {
  totalOpenMs: number;
  openMsByDate: Record<string, number>;
};

type AiTimeState = {
  totalOpenMs: number;
  typingMs: number;
};

class AgendaQuickAccessProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem) {
    return element;
  }

  getChildren() {
    return [
      this.createCommandItem('Abrir Agenda', 'activityAgenda.openForm', 'calendar'),
      this.createCommandItem('Exportar JSON', 'activityAgenda.exportEntries', 'export'),
      this.createCommandItem('Reiniciar contadores', 'activityAgenda.resetTimers', 'debug-restart')
    ];
  }

  private createCommandItem(label: string, command: string, iconId: string) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = {
      command,
      title: label
    };
    item.iconPath = new vscode.ThemeIcon(iconId);
    return item;
  }
}

const ENTRIES_KEY = 'activityAgenda.entries';
const PROJECT_NAME_KEY = 'activityAgenda.projectName';
const OPEN_TIME_KEY = 'activityAgenda.openTime';
const AI_TIME_KEY = 'activityAgenda.aiTime';
const IDLE_TYPING_LIMIT_MS = 5000;
const execFileAsync = promisify(execFile);

let workspaceOpenedAt = Date.now();
let typingMs = 0;
let lastTypingAt: number | undefined;
let lastOpenTimeAccountedAt = Date.now();
let openTimeState: OpenTimeState = { totalOpenMs: 0, openMsByDate: {} };
let lastOpenTimePersistedAt = 0;
let aiTimeState: AiTimeState = { totalOpenMs: 0, typingMs: 0 };
let aiInterfaceOpenedAt: number | undefined;
let lastAiOpenTimeAccountedAt: number | undefined;
let lastAiTypingAt: number | undefined;
let lastAiTimePersistedAt = 0;
let activeContext: vscode.ExtensionContext | undefined;
let panel: vscode.WebviewPanel | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let currentBranchContext: BranchContext | undefined;
let currentIssueContext: IssueContext | undefined;

export function activate(context: vscode.ExtensionContext) {
  activeContext = context;
  openTimeState = getOpenTimeState(context);
  aiTimeState = getAiTimeState(context);
  workspaceOpenedAt = Date.now();
  lastOpenTimeAccountedAt = workspaceOpenedAt;

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(calendar) Agenda';
  statusBarItem.tooltip = 'Abrir Agenda de Atividades';
  statusBarItem.command = 'activityAgenda.openForm';
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.window.createTreeView('activityAgenda.quickAccess', {
      treeDataProvider: new AgendaQuickAccessProvider()
    }),
    vscode.workspace.onDidChangeTextDocument(() => {
      registerTyping();
      postSnapshot(context);
    }),
    vscode.commands.registerCommand('activityAgenda.openForm', () => openForm(context)),
    vscode.commands.registerCommand('activityAgenda.resetTimers', () => resetTimers(context)),
    vscode.commands.registerCommand('activityAgenda.exportEntries', () => exportEntries(context))
  );
}

export async function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  await persistOpenTime();
  await persistAiTime();
}

function registerTyping() {
  const now = Date.now();

  if (lastTypingAt !== undefined) {
    const gap = now - lastTypingAt;
    typingMs += Math.min(gap, IDLE_TYPING_LIMIT_MS);
  }

  lastTypingAt = now;
}

function registerAiTyping() {
  const now = Date.now();

  if (lastAiTypingAt !== undefined) {
    const gap = now - lastAiTypingAt;
    aiTimeState.typingMs += Math.min(gap, IDLE_TYPING_LIMIT_MS);
  }

  lastAiTypingAt = now;
}

function openForm(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    updateAiInterfaceVisibility();
    postSnapshot(context);
    refreshIssueContext(context);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'activityAgenda',
    'Agenda de Atividades',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  panel.webview.html = getWebviewHtml(panel.webview);
  updateAiInterfaceVisibility();

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === 'addEntry') {
      await addEntry(context, String(message.description ?? '').trim());
    }

    if (message?.type === 'closeEntry') {
      await closeEntry(context, String(message.id ?? ''));
    }

    if (message?.type === 'resetTimers') {
      await resetTimers(context);
    }

    if (message?.type === 'updateProjectName') {
      await updateProjectName(context, String(message.projectName ?? '').trim());
    }

    if (message?.type === 'refreshIssueContext') {
      await refreshIssueContext(context, true);
    }

    if (message?.type === 'exportEntries') {
      await exportEntries(context);
    }

    if (message?.type === 'aiTyping') {
      registerAiTyping();
      postSnapshot(context);
    }
  });

  panel.onDidChangeViewState(() => {
    updateAiInterfaceVisibility();
    postSnapshot(context);
  });

  panel.onDidDispose(() => {
    stopAiInterfaceTimer();
    panel = undefined;
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  });

  refreshTimer = setInterval(() => postSnapshot(context), 1000);
  postSnapshot(context);
  refreshIssueContext(context);
}

async function addEntry(context: vscode.ExtensionContext, description: string) {
  if (!description) {
    vscode.window.showWarningMessage('Descreva a atividade antes de salvar.');
    return;
  }

  const entries = getEntries(context);
  const entry: ActivityEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    projectName: getProjectName(context),
    description,
    branchName: currentIssueContext?.branchName ?? currentBranchContext?.branchName,
    issueNumber: currentIssueContext?.issueNumber,
    issueTitle: currentIssueContext?.issueTitle,
    issueDescription: currentIssueContext?.issueDescription,
    createdAt: new Date().toISOString(),
    workspaceOpenMs: Date.now() - workspaceOpenedAt,
    typingMs,
    aiInterfaceOpenMs: getCurrentAiOpenMs(),
    aiTypingMs: aiTimeState.typingMs
  };

  await context.workspaceState.update(ENTRIES_KEY, [entry, ...entries]);
  vscode.window.showInformationMessage('Atividade registrada.');
  postSnapshot(context);
}

async function closeEntry(context: vscode.ExtensionContext, id: string) {
  if (!id) {
    return;
  }

  const entries = getEntries(context);
  const now = new Date();
  const updatedEntries = entries.map((entry) => {
    if (entry.id !== id || entry.endedAt) {
      return entry;
    }

    return {
      ...entry,
      endedAt: now.toISOString(),
      taskDurationMs: now.getTime() - new Date(entry.createdAt).getTime()
    };
  });

  await context.workspaceState.update(ENTRIES_KEY, updatedEntries);
  vscode.window.showInformationMessage('Tarefa encerrada.');
  postSnapshot(context);
}

async function resetTimers(context: vscode.ExtensionContext) {
  await persistOpenTime();
  await persistAiTime();
  workspaceOpenedAt = Date.now();
  typingMs = 0;
  lastTypingAt = undefined;
  lastOpenTimeAccountedAt = workspaceOpenedAt;
  aiTimeState = { totalOpenMs: 0, typingMs: 0 };
  aiInterfaceOpenedAt = panel?.visible ? Date.now() : undefined;
  lastAiOpenTimeAccountedAt = aiInterfaceOpenedAt;
  lastAiTypingAt = undefined;
  await saveAiTimeState();
  vscode.window.showInformationMessage('Contadores reiniciados.');
  postSnapshot(context);
}

async function updateProjectName(context: vscode.ExtensionContext, projectName: string) {
  if (!projectName) {
    vscode.window.showWarningMessage('Informe o nome do projeto antes de salvar.');
    return;
  }

  await context.workspaceState.update(PROJECT_NAME_KEY, projectName);
  vscode.window.showInformationMessage('Nome do projeto atualizado.');
  postSnapshot(context);
}

async function exportEntries(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = workspaceFolder
    ? vscode.Uri.joinPath(workspaceFolder, 'agenda-de-atividades.json')
    : undefined;

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { JSON: ['json'] },
    saveLabel: 'Exportar'
  });

  if (!target) {
    return;
  }

  const payload = JSON.stringify(getEntries(context), null, 2);
  await vscode.workspace.fs.writeFile(target, Buffer.from(payload, 'utf8'));
  vscode.window.showInformationMessage(`Registros exportados para ${target.fsPath}.`);
}

async function refreshIssueContext(context: vscode.ExtensionContext, notify = false) {
  currentBranchContext = undefined;
  currentIssueContext = undefined;
  currentIssueContext = await loadIssueContext(context);

  if (notify) {
    if (currentIssueContext) {
      vscode.window.showInformationMessage(`Issue #${currentIssueContext.issueNumber} carregada da branch.`);
    } else if (currentBranchContext) {
      vscode.window.showInformationMessage('Informações da branch carregadas.');
    } else {
      vscode.window.showWarningMessage('Não foi possível encontrar informações da branch atual.');
    }
  }

  postSnapshot(context);
}

async function loadIssueContext(context: vscode.ExtensionContext): Promise<IssueContext | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  if (!workspaceFolder) {
    return undefined;
  }

  try {
    const branchName = await runGit(workspaceFolder.uri.fsPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    currentBranchContext = {
      branchName,
      branchTitle: getBranchTitle(branchName)
    };

    const issueNumber = getIssueNumberFromBranch(branchName);

    if (!issueNumber) {
      return undefined;
    }

    const remoteUrl = await runGit(workspaceFolder.uri.fsPath, ['config', '--get', 'remote.origin.url']);
    const repository = parseGitHubRepository(remoteUrl);

    if (!repository) {
      return undefined;
    }

    const issue = await fetchGitHubIssue(context, repository.owner, repository.repo, issueNumber);

    if (!issue) {
      return undefined;
    }

    return {
      branchName,
      issueNumber,
      issueTitle: issue.title,
      issueDescription: issue.body ?? '',
      issueUrl: issue.html_url
    };
  } catch {
    return undefined;
  }
}

async function runGit(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function getIssueNumberFromBranch(branchName: string) {
  const match = branchName.match(/(?:^|[\/_-])(?:issue|issues|gh)?#?(\d+)(?=$|[\/_-])/i) ?? branchName.match(/#(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function parseGitHubRepository(remoteUrl: string) {
  const normalized = remoteUrl.trim().replace(/\.git$/, '');
  const httpsMatch = normalized.match(/^https:\/\/github\.com\/([^\/]+)\/([^\/]+)$/i);
  const sshMatch = normalized.match(/^git@github\.com:([^\/]+)\/([^\/]+)$/i);
  const match = httpsMatch ?? sshMatch;

  if (!match) {
    return undefined;
  }

  return {
    owner: match[1],
    repo: match[2]
  };
}

async function fetchGitHubIssue(
  context: vscode.ExtensionContext,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<{ title: string; body?: string; html_url: string } | undefined> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'vscode-activity-agenda',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const session = await getGitHubSession(context);

  if (session) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, { headers });

  if (!response.ok) {
    return undefined;
  }

  const payload = (await response.json()) as { title?: string; body?: string; html_url?: string; pull_request?: unknown };

  if (!payload.title || !payload.html_url || payload.pull_request) {
    return undefined;
  }

  return {
    title: payload.title,
    body: payload.body,
    html_url: payload.html_url
  };
}

async function getGitHubSession(context: vscode.ExtensionContext) {
  try {
    return await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: false,
      silent: true
    });
  } catch {
    return undefined;
  }
}

function postSnapshot(context: vscode.ExtensionContext) {
  panel?.webview.postMessage({
    type: 'snapshot',
    snapshot: getSnapshot(context)
  });
}

function getSnapshot(context: vscode.ExtensionContext): TimerSnapshot {
  accrueOpenTime();
  persistOpenTimePeriodically();
  accrueAiOpenTime();
  persistAiTimePeriodically();

  return {
    projectName: getProjectName(context),
    currentOpenMs: Date.now() - workspaceOpenedAt,
    todayOpenMs: getTodayOpenMs(),
    totalOpenMs: openTimeState.totalOpenMs,
    openMsByDate: openTimeState.openMsByDate,
    typingMs,
    aiCurrentOpenMs: getCurrentAiOpenMs(),
    aiTotalOpenMs: aiTimeState.totalOpenMs,
    aiTypingMs: aiTimeState.typingMs,
    aiTotalMs: aiTimeState.totalOpenMs + aiTimeState.typingMs,
    entries: getEntries(context),
    issueContext: currentIssueContext,
    branchContext: currentBranchContext,
    suggestedDescription: getSuggestedDescription()
  };
}

function getOpenTimeState(context: vscode.ExtensionContext): OpenTimeState {
  const state = context.workspaceState.get<OpenTimeState>(OPEN_TIME_KEY);

  return {
    totalOpenMs: state?.totalOpenMs ?? 0,
    openMsByDate: state?.openMsByDate ?? {}
  };
}

function getAiTimeState(context: vscode.ExtensionContext): AiTimeState {
  const state = context.workspaceState.get<AiTimeState>(AI_TIME_KEY);

  return {
    totalOpenMs: state?.totalOpenMs ?? 0,
    typingMs: state?.typingMs ?? 0
  };
}

function updateAiInterfaceVisibility() {
  if (panel?.visible) {
    startAiInterfaceTimer();
    return;
  }

  stopAiInterfaceTimer();
}

function startAiInterfaceTimer() {
  const now = Date.now();

  if (aiInterfaceOpenedAt === undefined) {
    aiInterfaceOpenedAt = now;
  }

  if (lastAiOpenTimeAccountedAt === undefined) {
    lastAiOpenTimeAccountedAt = now;
  }
}

function stopAiInterfaceTimer() {
  accrueAiOpenTime();
  aiInterfaceOpenedAt = undefined;
  lastAiOpenTimeAccountedAt = undefined;
  lastAiTypingAt = undefined;
  void saveAiTimeState();
}

function accrueAiOpenTime() {
  if (lastAiOpenTimeAccountedAt === undefined) {
    return;
  }

  const now = Date.now();

  if (now <= lastAiOpenTimeAccountedAt) {
    return;
  }

  aiTimeState.totalOpenMs += now - lastAiOpenTimeAccountedAt;
  lastAiOpenTimeAccountedAt = now;
}

function getCurrentAiOpenMs() {
  return aiInterfaceOpenedAt === undefined ? 0 : Date.now() - aiInterfaceOpenedAt;
}

function persistAiTimePeriodically() {
  const now = Date.now();

  if (now - lastAiTimePersistedAt < 30000) {
    return;
  }

  lastAiTimePersistedAt = now;
  void saveAiTimeState();
}

async function persistAiTime() {
  accrueAiOpenTime();
  await saveAiTimeState();
}

async function saveAiTimeState() {
  if (!activeContext) {
    return;
  }

  await activeContext.workspaceState.update(AI_TIME_KEY, aiTimeState);
}

function accrueOpenTime() {
  const now = Date.now();

  if (now <= lastOpenTimeAccountedAt) {
    return;
  }

  addOpenTimeRange(lastOpenTimeAccountedAt, now);
  lastOpenTimeAccountedAt = now;
}

function addOpenTimeRange(startMs: number, endMs: number) {
  let cursor = startMs;

  while (cursor < endMs) {
    const nextMidnight = getNextLocalMidnight(cursor);
    const segmentEnd = Math.min(endMs, nextMidnight);
    const segmentMs = segmentEnd - cursor;
    const dateKey = getLocalDateKey(cursor);

    openTimeState.openMsByDate[dateKey] = (openTimeState.openMsByDate[dateKey] ?? 0) + segmentMs;
    openTimeState.totalOpenMs += segmentMs;
    cursor = segmentEnd;
  }
}

function getTodayOpenMs() {
  return openTimeState.openMsByDate[getLocalDateKey(Date.now())] ?? 0;
}

function getLocalDateKey(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getNextLocalMidnight(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function persistOpenTimePeriodically() {
  const now = Date.now();

  if (now - lastOpenTimePersistedAt < 30000) {
    return;
  }

  lastOpenTimePersistedAt = now;
  void saveOpenTimeState();
}

async function persistOpenTime() {
  accrueOpenTime();
  await saveOpenTimeState();
}

async function saveOpenTimeState() {
  if (!activeContext) {
    return;
  }

  await activeContext.workspaceState.update(OPEN_TIME_KEY, openTimeState);
}

function getEntries(context: vscode.ExtensionContext): ActivityEntry[] {
  return context.workspaceState.get<ActivityEntry[]>(ENTRIES_KEY, []);
}

function getProjectName(context: vscode.ExtensionContext) {
  return context.workspaceState.get<string>(PROJECT_NAME_KEY) ?? vscode.workspace.name ?? 'Projeto sem nome';
}

function formatIssueDescription(issueContext: IssueContext) {
  const parts = [`Issue #${issueContext.issueNumber} - ${issueContext.issueTitle}`, issueContext.issueUrl];

  if (issueContext.issueDescription) {
    parts.push('', issueContext.issueDescription);
  }

  return parts.join('\n');
}

function getSuggestedDescription() {
  if (currentIssueContext) {
    return formatIssueDescription(currentIssueContext);
  }

  if (currentBranchContext) {
    return formatBranchDescription(currentBranchContext);
  }

  return undefined;
}

function formatBranchDescription(branchContext: BranchContext) {
  return [`Branch: ${branchContext.branchName}`, branchContext.branchTitle].join('\n');
}

function getBranchTitle(branchName: string) {
  const titleSource = branchName
    .split('/')
    .filter(Boolean)
    .filter((part, index) => index > 0 || !/^(feature|feat|fix|bugfix|hotfix|release|chore|task|issue)$/i.test(part))
    .join(' ')
    .replace(/(?:^|[\s_-])#?\d+(?=$|[\s_-])/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!titleSource) {
    return branchName;
  }

  return titleSource.charAt(0).toUpperCase() + titleSource.slice(1);
}

function getWebviewHtml(webview: vscode.Webview) {
  const nonce = getNonce();
  const styleNonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${styleNonce}'; script-src 'nonce-${nonce}';">
  <title>Agenda de Atividades</title>
  <style nonce="${styleNonce}">
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      --muted: color-mix(in srgb, var(--vscode-foreground) 62%, transparent);
      --panel: var(--vscode-editor-background);
      --control: var(--vscode-input-background);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    main {
      max-width: 980px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      font-weight: 650;
      letter-spacing: 0;
    }

    h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .project-name-form {
      margin-top: 8px;
      gap: 6px;
    }

    .project-name-form label {
      color: var(--muted);
      font-size: 12px;
    }

    .project-name-row {
      display: flex;
      gap: 8px;
      max-width: 460px;
    }

    .project-name-row button {
      flex: none;
      white-space: nowrap;
    }

    input,
    textarea {
      color: var(--vscode-input-foreground);
      background: var(--control);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.45;
    }

    input {
      width: 100%;
      min-height: 32px;
      padding: 6px 10px;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(150px, 1fr));
      gap: 10px;
      min-width: 320px;
    }

    .metric {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      background: var(--panel);
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }

    .metric strong {
      font-size: 20px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
    }

    form {
      display: grid;
      gap: 10px;
    }

    label {
      font-weight: 600;
    }

    textarea {
      width: 100%;
      min-height: 130px;
      resize: vertical;
    }

    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .issue-context {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }

    .issue-context a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .issue-context a:hover {
      text-decoration: underline;
    }

    button {
      min-height: 32px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 6px 12px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      font: inherit;
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .entries {
      display: grid;
      gap: 10px;
    }

    .report {
      display: grid;
      gap: 10px;
    }

    .report-tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
    }

    .report-tab {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      white-space: nowrap;
    }

    .report-tab[aria-selected="true"] {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .chart-panel {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      background: var(--panel);
    }

    .chart-panel[hidden] {
      display: none;
    }

    .chart-panel h3 {
      margin: 0 0 4px;
      font-size: 14px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .chart-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 16px;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 10px;
    }

    .line-chart {
      display: block;
      width: 100%;
      height: 160px;
      overflow: visible;
    }

    .chart-grid {
      stroke: var(--border);
      stroke-width: 1;
    }

    .chart-line {
      fill: none;
      stroke: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      stroke-width: 3;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .chart-point {
      fill: var(--panel);
      stroke: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      stroke-width: 2;
    }

    .chart-label {
      fill: var(--muted);
      font-size: 10px;
    }

    .entry {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      background: var(--panel);
    }

    .entry-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }

    .entry time {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }

    .entry p {
      margin: 0 0 10px;
      white-space: pre-wrap;
      line-height: 1.45;
    }

    .entry-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      color: var(--muted);
      font-size: 12px;
    }

    .entry button {
      flex: none;
    }

    .empty {
      color: var(--muted);
      border: 1px dashed var(--border);
      border-radius: 6px;
      padding: 16px;
      margin: 0;
    }

    @media (max-width: 720px) {
      body {
        padding: 16px;
      }

      header {
        display: grid;
      }

      .metrics {
        min-width: 0;
        grid-template-columns: 1fr;
      }

      .project-name-row {
        display: grid;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Agenda de Atividades</h1>
        <form class="project-name-form" id="projectNameForm">
          <label for="projectName">Nome do projeto</label>
          <div class="project-name-row">
            <input id="projectName" type="text" autocomplete="off" required>
            <button type="submit" class="secondary">Salvar nome</button>
          </div>
        </form>
      </div>
      <section class="metrics" aria-label="Contadores">
        <div class="metric">
          <span>Tempo corrente</span>
          <strong id="currentOpenTime">00:00:00</strong>
        </div>
        <div class="metric">
          <span>Hoje</span>
          <strong id="todayOpenTime">00:00:00</strong>
        </div>
        <div class="metric">
          <span>Total aberto</span>
          <strong id="totalOpenTime">00:00:00</strong>
        </div>
        <div class="metric">
          <span>Digitando código</span>
          <strong id="typingTime">00:00:00</strong>
        </div>
        <div class="metric">
          <span>IA aberta</span>
          <strong id="aiCurrentOpenTime">00:00:00</strong>
        </div>
        <div class="metric">
          <span>Digitando IA</span>
          <strong id="aiTypingTime">00:00:00</strong>
        </div>
        <div class="metric">
          <span>Total IA</span>
          <strong id="aiTotalOpenTime">00:00:00</strong>
        </div>
      </section>
    </header>

    <form id="activityForm">
      <label for="description">Atividade realizada</label>
      <textarea id="description" placeholder="Descreva o que você está fazendo neste projeto..." required></textarea>
      <div class="issue-context" id="issueContext">Buscando dados da branch atual...</div>
      <div class="actions">
        <button type="submit">Salvar atividade</button>
        <button type="button" class="secondary" id="resetTimers">Reiniciar contadores</button>
        <button type="button" class="secondary" id="refreshIssueContext">Buscar dados da branch</button>
        <button type="button" class="secondary" id="exportEntries">Exportar JSON</button>
      </div>
    </form>

    <section class="report" aria-label="Relatório dos últimos 30 dias">
      <h2>Relatório</h2>
      <div class="report-tabs" role="tablist" aria-label="Relatórios">
        <button type="button" class="report-tab" id="openTimeReportTab" role="tab" aria-selected="true" aria-controls="openTimeReportPanel" data-report-tab="openTimeReportPanel">Tempo aberto</button>
        <button type="button" class="report-tab" id="activityReportTab" role="tab" aria-selected="false" aria-controls="activityReportPanel" data-report-tab="activityReportPanel">Atividades</button>
      </div>
      <div class="chart-panel" id="openTimeReportPanel" role="tabpanel" aria-labelledby="openTimeReportTab">
        <h3>Tempo aberto nos últimos 30 dias</h3>
        <div class="chart-summary" id="openTimeChartSummary"></div>
        <svg class="line-chart" id="openTimeChart" viewBox="0 0 720 170" role="img" aria-label="Tempo aberto nos últimos 30 dias"></svg>
      </div>
      <div class="chart-panel" id="activityReportPanel" role="tabpanel" aria-labelledby="activityReportTab" hidden>
        <h3>Atividades nos últimos 30 dias</h3>
        <div class="chart-summary" id="activityChartSummary"></div>
        <svg class="line-chart" id="activityChart" viewBox="0 0 720 170" role="img" aria-label="Atividades nos últimos 30 dias"></svg>
      </div>
    </section>

    <section class="entries" aria-label="Atividades registradas">
      <h2>Registros</h2>
      <div id="entries"></div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('activityForm');
    const projectNameForm = document.getElementById('projectNameForm');
    const description = document.getElementById('description');
    const projectName = document.getElementById('projectName');
    const currentOpenTime = document.getElementById('currentOpenTime');
    const todayOpenTime = document.getElementById('todayOpenTime');
    const totalOpenTime = document.getElementById('totalOpenTime');
    const typingTime = document.getElementById('typingTime');
    const aiCurrentOpenTime = document.getElementById('aiCurrentOpenTime');
    const aiTypingTime = document.getElementById('aiTypingTime');
    const aiTotalOpenTime = document.getElementById('aiTotalOpenTime');
    const entries = document.getElementById('entries');
    const issueContext = document.getElementById('issueContext');
    const openTimeChart = document.getElementById('openTimeChart');
    const openTimeChartSummary = document.getElementById('openTimeChartSummary');
    const activityChart = document.getElementById('activityChart');
    const activityChartSummary = document.getElementById('activityChartSummary');
    let userEditedDescription = false;

    description.addEventListener('input', () => {
      userEditedDescription = true;
      vscode.postMessage({ type: 'aiTyping' });
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'addEntry', description: description.value });
      description.value = '';
      userEditedDescription = false;
      description.focus();
    });

    projectNameForm.addEventListener('submit', (event) => {
      event.preventDefault();
      vscode.postMessage({ type: 'updateProjectName', projectName: projectName.value });
    });

    document.getElementById('resetTimers').addEventListener('click', () => {
      vscode.postMessage({ type: 'resetTimers' });
    });

    document.getElementById('refreshIssueContext').addEventListener('click', () => {
      issueContext.textContent = 'Buscando dados da branch atual...';
      vscode.postMessage({ type: 'refreshIssueContext' });
    });

    document.getElementById('exportEntries').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportEntries' });
    });

    document.querySelectorAll('[data-report-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const selectedPanelId = tab.dataset.reportTab;

        document.querySelectorAll('[data-report-tab]').forEach((item) => {
          item.setAttribute('aria-selected', String(item === tab));
        });

        document.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
          panel.hidden = panel.id !== selectedPanelId;
        });
      });
    });

    entries.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const button = event.target.closest('[data-close-entry-id]');

      if (!button) {
        return;
      }

      vscode.postMessage({ type: 'closeEntry', id: button.dataset.closeEntryId });
    });

    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'snapshot') {
        return;
      }

      renderSnapshot(event.data.snapshot);
    });

    function renderSnapshot(snapshot) {
      if (document.activeElement !== projectName) {
        projectName.value = snapshot.projectName;
      }
      currentOpenTime.textContent = formatDuration(snapshot.currentOpenMs);
      todayOpenTime.textContent = formatDuration(snapshot.todayOpenMs);
      totalOpenTime.textContent = formatDuration(snapshot.totalOpenMs);
      typingTime.textContent = formatDuration(snapshot.typingMs);
      aiCurrentOpenTime.textContent = formatDuration(snapshot.aiCurrentOpenMs);
      aiTypingTime.textContent = formatDuration(snapshot.aiTypingMs);
      aiTotalOpenTime.textContent = formatDuration(snapshot.aiTotalOpenMs);
      entries.innerHTML = '';
      renderIssueContext(snapshot);
      renderOpenTimeChart(snapshot.openMsByDate);
      renderActivityChart(snapshot.entries);

      if (!userEditedDescription && snapshot.suggestedDescription && !description.value.trim()) {
        description.value = snapshot.suggestedDescription;
      }

      if (!snapshot.entries.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Nenhuma atividade registrada neste workspace.';
        entries.appendChild(empty);
        return;
      }

      for (const entry of snapshot.entries) {
        const article = document.createElement('article');
        article.className = 'entry';

        const header = document.createElement('div');
        header.className = 'entry-header';

        const time = document.createElement('time');
        time.dateTime = entry.createdAt;
        time.textContent = new Intl.DateTimeFormat('pt-BR', {
          dateStyle: 'short',
          timeStyle: 'short'
        }).format(new Date(entry.createdAt));
        header.appendChild(time);

        if (!entry.endedAt) {
          const closeButton = document.createElement('button');
          closeButton.type = 'button';
          closeButton.className = 'secondary';
          closeButton.dataset.closeEntryId = entry.id;
          closeButton.textContent = 'Encerrar tarefa';
          header.appendChild(closeButton);
        }

        const text = document.createElement('p');
        text.textContent = entry.description;

        const meta = document.createElement('div');
        meta.className = 'entry-meta';
        const metaItems = [
          metaItem('Projeto aberto: ' + formatDuration(entry.workspaceOpenMs)),
          metaItem('Digitando código: ' + formatDuration(entry.typingMs))
        ];

        if (entry.aiInterfaceOpenMs !== undefined) {
          metaItems.push(metaItem('IA aberta: ' + formatDuration(entry.aiInterfaceOpenMs)));
        }

        if (entry.aiTypingMs !== undefined) {
          metaItems.push(metaItem('Digitando IA: ' + formatDuration(entry.aiTypingMs)));
        }

        if (entry.issueNumber && entry.issueTitle) {
          metaItems.push(metaItem('Issue #' + entry.issueNumber + ': ' + entry.issueTitle));
        }

        if (entry.branchName) {
          metaItems.push(metaItem('Branch: ' + entry.branchName));
        }

        if (entry.endedAt) {
          metaItems.push(metaItem('Encerrada: ' + formatDateTime(entry.endedAt)));
        }

        if (entry.taskDurationMs) {
          metaItems.push(metaItem('Duração da tarefa: ' + formatDuration(entry.taskDurationMs)));
        }

        meta.append(...metaItems);

        article.append(header, text, meta);
        entries.appendChild(article);
      }
    }

    function renderIssueContext(snapshot) {
      issueContext.textContent = '';

      if (!snapshot.issueContext) {
        if (snapshot.branchContext) {
          issueContext.textContent = 'Branch: ' + snapshot.branchContext.branchName + ' | ' + snapshot.branchContext.branchTitle;
          return;
        }

        issueContext.textContent = 'Nenhuma informação detectada na branch atual.';
        return;
      }

      const link = document.createElement('a');
      link.href = snapshot.issueContext.issueUrl;
      link.textContent = 'Issue #' + snapshot.issueContext.issueNumber + ': ' + snapshot.issueContext.issueTitle;

      const branch = document.createElement('span');
      branch.textContent = 'Branch: ' + snapshot.issueContext.branchName;

      issueContext.append(link, document.createTextNode(' | '), branch);
    }

    function renderOpenTimeChart(openMsByDate) {
      const points = getLastThirtyDaysOpenTime(openMsByDate);
      const totalMs = points.reduce((sum, point) => sum + point.value, 0);
      const activeDays = points.filter((point) => point.value > 0).length;
      const maxMs = Math.max(0, ...points.map((point) => point.value));

      openTimeChartSummary.textContent = '';
      openTimeChartSummary.append(
        summaryItem('Período: últimos 30 dias'),
        summaryItem('Tempo aberto: ' + formatDuration(totalMs)),
        summaryItem('Dias abertos: ' + activeDays),
        summaryItem('Maior dia: ' + formatDuration(maxMs))
      );

      renderLineChart(openTimeChart, points, (point) => point.label + ': ' + formatDuration(point.value));
    }

    function renderActivityChart(activityEntries) {
      const points = getLastThirtyDaysActivity(activityEntries);
      const total = points.reduce((sum, point) => sum + point.value, 0);
      const activeDays = points.filter((point) => point.value > 0).length;
      const maxCount = Math.max(0, ...points.map((point) => point.value));

      activityChartSummary.textContent = '';
      activityChartSummary.append(
        summaryItem('Período: últimos 30 dias'),
        summaryItem('Atividades: ' + total),
        summaryItem('Dias com atividade: ' + activeDays),
        summaryItem('Maior dia: ' + maxCount)
      );

      renderLineChart(activityChart, points, (point) => point.label + ': ' + point.value + ' atividade(s)');
    }

    function renderLineChart(chart, points, getTooltip) {
      chart.textContent = '';

      const width = 720;
      const height = 170;
      const padding = { top: 18, right: 20, bottom: 34, left: 34 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = height - padding.top - padding.bottom;
      const maxValue = Math.max(1, ...points.map((point) => point.value));
      const coordinates = points.map((point, index) => {
        const x = padding.left + (chartWidth / (points.length - 1)) * index;
        const y = padding.top + chartHeight - (point.value / maxValue) * chartHeight;
        return { ...point, x, y };
      });

      for (let index = 0; index <= 3; index += 1) {
        const y = padding.top + (chartHeight / 3) * index;
        chart.appendChild(appendSvg('line', {
          x1: padding.left,
          y1: y,
          x2: width - padding.right,
          y2: y,
          class: 'chart-grid'
        }));
      }

      const path = appendSvg('path', {
        d: getSmoothPath(coordinates),
        class: 'chart-line'
      });
      chart.appendChild(path);

      for (const point of coordinates) {
        const circle = appendSvg('circle', {
          cx: point.x,
          cy: point.y,
          r: point.value > 0 ? 4 : 3,
          class: 'chart-point'
        });
        circle.appendChild(appendSvg('title', {}, getTooltip(point)));
        chart.appendChild(circle);
      }

      const first = coordinates[0];
      const middle = coordinates[Math.floor(coordinates.length / 2)];
      const last = coordinates[coordinates.length - 1];

      for (const labelPoint of [first, middle, last]) {
        chart.appendChild(appendSvg('text', {
          x: labelPoint.x,
          y: height - 10,
          'text-anchor': labelPoint === first ? 'start' : labelPoint === last ? 'end' : 'middle',
          class: 'chart-label'
        }, labelPoint.shortLabel));
      }
    }

    function getLastThirtyDaysOpenTime(openMsByDate) {
      return getLastThirtyDays().map((day) => ({
        ...day,
        value: openMsByDate?.[day.key] ?? 0
      }));
    }

    function getLastThirtyDaysActivity(activityEntries) {
      const counts = new Map();

      for (const entry of activityEntries) {
        const date = new Date(entry.createdAt);
        date.setHours(0, 0, 0, 0);
        const key = getDateKey(date);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      return getLastThirtyDays().map((day) => ({
        ...day,
        value: counts.get(day.key) ?? 0
      }));
    }

    function getLastThirtyDays() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      return Array.from({ length: 30 }, (_, index) => {
        const date = new Date(today);
        date.setDate(today.getDate() - 29 + index);
        const key = getDateKey(date);

        return {
          key,
          label: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(date),
          shortLabel: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(date)
        };
      });
    }

    function getSmoothPath(points) {
      if (!points.length) {
        return '';
      }

      if (points.length === 1) {
        return 'M ' + points[0].x + ' ' + points[0].y;
      }

      const path = ['M ' + points[0].x + ' ' + points[0].y];

      for (let index = 0; index < points.length - 1; index += 1) {
        const current = points[index];
        const next = points[index + 1];
        const controlX = (current.x + next.x) / 2;
        path.push('C ' + controlX + ' ' + current.y + ', ' + controlX + ' ' + next.y + ', ' + next.x + ' ' + next.y);
      }

      return path.join(' ');
    }

    function appendSvg(name, attributes, text) {
      const element = document.createElementNS('http://www.w3.org/2000/svg', name);

      for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value));
      }

      if (text !== undefined) {
        element.textContent = text;
      }

      return element;
    }

    function summaryItem(text) {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }

    function getDateKey(date) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return year + '-' + month + '-' + day;
    }

    function metaItem(text) {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }

    function formatDuration(ms) {
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
    }

    function formatDateTime(value) {
      return new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short'
      }).format(new Date(value));
    }
  </script>
</body>
</html>`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
