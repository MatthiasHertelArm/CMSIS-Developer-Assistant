/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The Target Documents view (2.9.2, goal 3): the current target's documents
 * in one tree — the packs', the Arm catalogue's, CMSIS Solution's inventory,
 * the document service's user and project documents, the workspace folders —
 * each with its state, and a warning on what the agent asked for and could
 * not get. The view's badge counts those requests. Its actions are what the
 * CMSIS view should offer once CMSIS Solution provides the document service:
 * Download, Import a file the user downloaded by hand, Open, Remove, and Add
 * a document to a device, board, core, pack, vendor or every target, for
 * this user or the project.
 *
 * The view is a client of the document service and of the documentation
 * handler, which keeps the indexing.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DocParent, DocScope, parentKey } from './docService/contract';
import { LISTED_SOLUTION_GLOB } from './core/bootstrapState';
import { BUILD_TASK_TYPE } from './core/cmsisTasks';
import { docState, DocRef, isReadable } from './core/packDocs';
import { textOf, errorText, toToolError } from './core/toolResult';
import type { PackDocsHandlers } from './packDocsDispatch';
import { logger } from './utils/logger';

export const TARGET_DOCS_VIEW = 'cmsisDeveloperAssistant.targetDocuments';
const COMMAND = 'cmsis-developer-assistant.targetDocs';

/** A group of the tree. */
interface Group {
    kind: 'group';
    label: string;
    docs: DocRef[];
}

/** A document of the tree. */
interface Item {
    kind: 'doc';
    doc: DocRef;
}

type Node = Group | Item;

const GROUPS: readonly { label: string; scopes: readonly DocRef['scope'][] }[] = [
    { label: 'Device', scopes: ['device', 'subFamily', 'family'] },
    { label: 'Board', scopes: ['board'] },
    { label: 'Project (.cmsis/docs.yml)', scopes: ['project'] },
    { label: 'Added by you', scopes: ['user'] },
    { label: 'Arm documents', scopes: ['arm'] },
    { label: 'Workspace folders', scopes: ['workspace'] },
    { label: 'Other PDFs in the packs', scopes: ['unlisted'] },
];

/** Whether the agent asked for the document and has no copy: the warning (G10). */
export function needsAttention(doc: DocRef): boolean {
    return !doc.cached && doc.source === 'web' && (doc.service?.requested !== undefined || doc.fetchFailure !== undefined);
}

class TargetDocsProvider implements vscode.TreeDataProvider<Node> {
    private readonly changed = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private docs: DocRef[] = [];
    private note: string | undefined;
    view: vscode.TreeView<Node> | undefined;

    constructor(private readonly handlers: PackDocsHandlers) {}

    async reload(): Promise<void> {
        try {
            const target = await this.handlers.docs.inspectTarget({});
            this.docs = target.docs;
            this.note = target.error;
        } catch (caught) {
            this.docs = [];
            this.note = caught instanceof Error ? caught.message : String(caught);
        }
        const open = this.docs.filter(needsAttention).length;
        if (this.view) {
            this.view.badge = open > 0 ? { value: open, tooltip: `${open} document${open === 1 ? '' : 's'} the agent asked for` } : undefined;
            this.view.message = this.note ? `No target: ${this.note.split('\n')[0]}` : undefined;
        }
        this.changed.fire(undefined);
    }

    find(id: string): DocRef | undefined {
        return this.docs.find((doc) => doc.id === id);
    }

    getChildren(node?: Node): Node[] {
        if (!node) {
            return GROUPS.map((group) => ({ kind: 'group' as const, label: group.label, docs: this.docs.filter((doc) => group.scopes.includes(doc.scope)) }))
                .filter((group) => group.docs.length > 0);
        }
        return node.kind === 'group' ? node.docs.map((doc) => ({ kind: 'doc' as const, doc })) : [];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'group') {
            const open = node.docs.filter(needsAttention).length;
            const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
            item.description = `${node.docs.length}${open ? ` · ${open} needed` : ''}`;
            if (open) { item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')); }
            return item;
        }
        const doc = node.doc;
        const state = docState(doc);
        const item = new vscode.TreeItem(doc.title, vscode.TreeItemCollapsibleState.None);
        item.id = doc.id;
        item.description = state;
        item.tooltip = new vscode.MarkdownString(`**${doc.title}**\n\n\`${doc.id}\`\n\n${state}${doc.url ? `\n\n${doc.url}` : ''}${doc.path ? `\n\n${doc.path}` : ''}`);
        item.iconPath = needsAttention(doc) ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
            : doc.indexed ? new vscode.ThemeIcon('pass')
                : doc.source === 'web' && !doc.cached ? new vscode.ThemeIcon('cloud-download')
                    : new vscode.ThemeIcon('file-pdf');
        const flags = [
            'doc',
            doc.source === 'web' && !doc.cached ? 'web' : '',
            doc.path ? 'local' : '',
            doc.service && (doc.service.scope === 'project' || doc.scope === 'user') ? 'removable' : '',
            doc.source === 'web' ? 'importable' : '',
            needsAttention(doc) ? 'requested' : '',
            doc.service?.requested ? 'dismissable' : '',
        ].filter(Boolean);
        item.contextValue = flags.join(' ');
        if (doc.path && isReadable(doc)) {
            item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(doc.path)] };
        }
        return item;
    }
}

/** The parents a document can be added to, as quick-pick items. */
function parentItems(parents: readonly DocParent[]): (vscode.QuickPickItem & { parent: DocParent })[] {
    const describe: Record<string, string> = {
        device: 'this device', board: 'this board', core: 'every target with this core', pack: 'every target using this pack, any version',
        vendor: 'every target with a pack of this vendor', all: 'every target',
    };
    return parents.map((parent) => {
        const kind = 'all' in parent ? 'all' : Object.keys(parent)[0];
        return { label: 'all' in parent ? 'All targets' : `${kind[0].toUpperCase()}${kind.slice(1)} ${parentKey(parent).slice(kind.length + 1)}`, description: describe[kind], parent };
    });
}

/** What the view asks of the workspace to know whether a csolution is there: `vscode.workspace` in the extension. */
export interface SolutionSearch {
    findFiles(include: string, exclude: string, maxResults: number): PromiseLike<readonly unknown[]>;
    /** Absent in a host without file watchers: the search then runs for the folders that come and go only. */
    createFileSystemWatcher?(glob: string, ignoreCreate: boolean, ignoreChange: boolean, ignoreDelete: boolean): {
        onDidCreate(listener: () => void): { dispose(): void };
        onDidDelete(listener: () => void): { dispose(): void };
        dispose(): void;
    };
    onDidChangeWorkspaceFolders?(listener: () => void): { dispose(): void };
}

/**
 * Tell `set` whether the workspace holds a csolution, in either spelling
 * CMSIS Solution lists (`*.csolution.yml`, `*.csolution.yaml`): now, and
 * again whenever one is created or deleted or a workspace folder comes or
 * goes, so that a solution made after activation shows the view. Only the
 * newest search answers. What is returned ends the watching.
 */
export function followSolutions(workspace: SolutionSearch, set: (present: boolean) => void): { dispose(): void }[] {
    let newest = 0;
    const look = (): void => {
        const mine = ++newest;
        workspace.findFiles(LISTED_SOLUTION_GLOB, '**/node_modules/**', 1).then(
            (found) => { if (mine === newest) { set(found.length > 0); } },
            (failure: unknown) => logger.debug('Target Documents: the search for a csolution failed', failure));
    };
    const watching: { dispose(): void }[] = [];
    const files = workspace.createFileSystemWatcher?.(LISTED_SOLUTION_GLOB, false, true, false);
    if (files) {
        watching.push(files, files.onDidCreate(look), files.onDidDelete(look));
    }
    const folders = workspace.onDidChangeWorkspaceFolders?.(look);
    if (folders) {
        watching.push(folders);
    }
    look();
    return watching;
}

/**
 * Whether the end of `task` can mean another active target. CMSIS Solution
 * has no event for a target switch, but it runs a task of its build type
 * (`cbuild setup`) after a solution load, a target switch and a refresh.
 */
export function mayChangeTarget(task: { definition?: { type?: unknown } } | undefined): boolean {
    return task?.definition?.type === BUILD_TASK_TYPE;
}

/** Register the view and its commands. */
export function registerTargetDocsView(context: vscode.ExtensionContext, handlers: PackDocsHandlers): void {
    const provider = new TargetDocsProvider(handlers);
    const view = vscode.window.createTreeView(TARGET_DOCS_VIEW, { treeDataProvider: provider, showCollapseAll: true });
    provider.view = view;
    const refresh = (): void => { void provider.reload(); };
    let serviceListener: vscode.Disposable | undefined;
    const subscribe = async (): Promise<void> => {
        serviceListener?.dispose();
        const service = (await handlers.docs.serviceContext())?.service;
        serviceListener = service ? service.onDidChangeDocuments(refresh) : undefined;
    };
    const docOf = (node: unknown): DocRef | undefined => (node && (node as Item).kind === 'doc' ? provider.find((node as Item).doc.id) ?? (node as Item).doc : undefined);
    const report = (title: string, text: string): void => {
        logger.info(`${title}:\n  ${text.split('\n').join('\n  ')}`);
        void vscode.window.showInformationMessage(text.split('\n')[0]);
    };

    context.subscriptions.push(
        view,
        { dispose: () => serviceListener?.dispose() },
        view.onDidChangeVisibility((change) => { if (change.visible) { void subscribe().then(refresh); } }),
        vscode.commands.registerCommand(`${COMMAND}.refresh`, () => { void subscribe().then(refresh); }),

        vscode.commands.registerCommand(`${COMMAND}.download`, async (node: unknown) => {
            const doc = docOf(node);
            if (!doc) { return; }
            const reply = await vscode.window.withProgress({ location: { viewId: TARGET_DOCS_VIEW }, title: `Downloading ${doc.title}` },
                () => handlers.docs.handleFetchDoc({ doc: doc.id, timeoutMs: 600_000 }).then(textOf, (failure: unknown) => errorText(toToolError(failure))));
            report(`download ${doc.id}`, reply);
            refresh();
        }),

        vscode.commands.registerCommand(`${COMMAND}.import`, async (node: unknown) => {
            const doc = docOf(node);
            const context = await handlers.docs.serviceContext();
            if (!doc || !context) { return; }
            const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'PDF documents': ['pdf'] }, openLabel: 'Import',
                title: `The file you downloaded for "${doc.title}"` });
            if (!files?.length) { return; }
            const entry = await handlers.docs.serviceEntry(doc);
            if (!entry) { return; }
            const info = await context.service.importDocument(entry.parent, entry.name, files[0].fsPath, entry.solution);
            if (info.path) {
                await handlers.docs.indexDocument({ ...doc, path: info.path, cached: true, service: { ...(doc.service ?? { scope: info.scope, view: context.view }), parent: entry.parent, name: entry.name, scope: info.scope, copy: info.path, view: context.view } })
                    .catch((failure: unknown) => logger.warn(`indexing ${doc.id} failed`, failure));
            }
            report(`import ${doc.id}`, `Imported ${path.basename(files[0].fsPath)} for ${doc.title}; the agent can search it now.`);
            refresh();
        }),

        vscode.commands.registerCommand(`${COMMAND}.openSource`, async (node: unknown) => {
            const doc = docOf(node);
            if (doc?.url) { await vscode.env.openExternal(vscode.Uri.parse(doc.url)); }
        }),

        vscode.commands.registerCommand(`${COMMAND}.remove`, async (node: unknown) => {
            const doc = docOf(node);
            const context = await handlers.docs.serviceContext();
            if (!doc?.service || !context) { return; }
            const answer = await vscode.window.showWarningMessage(`Remove "${doc.title}" from the target's documents?`, {
                modal: true,
                detail: doc.service.scope === 'project' ? 'The entry is removed from the project\'s .cmsis/docs.yml. The file itself stays where it is.'
                    : 'The entry and the copy the extension keeps are removed. A file you added stays where it was.',
            }, 'Remove');
            if (answer !== 'Remove') { return; }
            await context.service.removeDocument(doc.service.parent, doc.service.name, doc.service.scope === 'project' ? context.solution : undefined);
            refresh();
        }),

        vscode.commands.registerCommand(`${COMMAND}.dismiss`, async (node: unknown) => {
            const doc = docOf(node);
            const context = await handlers.docs.serviceContext();
            if (!doc?.service || !context) { return; }
            await context.service.clearRequest(doc.service.parent, doc.service.name, doc.service.scope === 'project' ? context.solution : undefined);
            refresh();
        }),

        vscode.commands.registerCommand(`${COMMAND}.add`, () => addDocument(handlers).then(refresh)),
    );
    // The view shows only in a workspace with a csolution, also one that is made later.
    context.subscriptions.push(...followSolutions(vscode.workspace, (present) => {
        void vscode.commands.executeCommand('setContext', 'cmsisDeveloperAssistant.hasSolution', present);
    }));
    // The shown view follows the active target: the documents are read again when a task that may have changed it ends.
    const tasks = vscode.tasks as Partial<typeof vscode.tasks> | undefined;
    if (tasks?.onDidEndTask) {
        context.subscriptions.push(tasks.onDidEndTask((ended) => {
            if (view.visible && mayChangeTarget(ended.execution.task)) {
                void subscribe().then(refresh);
            }
        }));
    }
    // Read the target only while the view is shown: activation does no document work for a hidden view.
    if (view.visible) {
        void subscribe().then(refresh);
    }
}

/**
 * Add a document to the target: a file or a URL, its parent (device, board,
 * core, pack, vendor, all targets), and for a file inside the project or a
 * URL the scope (this user, or the project's `.cmsis/docs.yml`); then index
 * it. The flow of *Import Document for Current Target* and of the view's +.
 */
export async function addDocument(handlers: PackDocsHandlers): Promise<void> {
    const context = await handlers.docs.serviceContext();
    if (!context) {
        void vscode.window.showWarningMessage('CMSIS Developer Assistant: no target resolves in this window, or the document service is off (setting packDocs.documentService).');
        return;
    }
    const what = await vscode.window.showQuickPick([
        { label: '$(file-pdf) A file', file: true },
        { label: '$(link) A URL', description: 'a reference; downloaded when the agent or you need it', file: false },
    ], { title: 'Add a document to the target' });
    if (!what) { return; }
    let source: string | undefined;
    if (what.file) {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Documents: ['pdf', 'md', 'txt'] }, openLabel: 'Add' });
        source = files?.[0]?.fsPath;
    } else {
        source = (await vscode.window.showInputBox({ title: 'URL of the document', prompt: 'https://…', validateInput: (v) => (/^https?:\/\//i.test(v.trim()) ? undefined : 'An http(s) URL') }))?.trim();
    }
    if (!source) { return; }
    const parent = await vscode.window.showQuickPick(parentItems(context.parents), { title: 'Which targets should see it?' });
    if (!parent) { return; }
    let scope: DocScope = 'user';
    const projectDir = context.solution ? path.dirname(context.solution) : undefined;
    const insideProject = projectDir !== undefined && (!what.file || !path.relative(projectDir, source).startsWith('..'));
    if (insideProject) {
        const picked = await vscode.window.showQuickPick([
            { label: 'For me', description: 'this machine only (default)', scope: 'user' as DocScope },
            { label: 'For the project', description: 'listed in .cmsis/docs.yml, shared with the project', scope: 'project' as DocScope },
        ], { title: 'Who should see it?' });
        if (!picked) { return; }
        scope = picked.scope;
    }
    const title = await vscode.window.showInputBox({ title: 'Title', value: what.file ? path.basename(source).replace(/\.[^.]+$/, '') : '', prompt: 'Shown in listings and citations' });
    if (title === undefined) { return; }
    const category = await vscode.window.showQuickPick(['manual', 'overview', 'schematic', 'setup', 'other'], { title: 'Category' });
    if (!category) { return; }
    try {
        const info = await context.service.addDocument(parent.parent, source, { title: title.trim() || undefined, category, scope, ...(scope === 'project' ? { solution: context.solution } : {}) });
        const listed = (await handlers.docs.inspectTarget({})).docs.find((doc) => doc.service?.name === info.name && parentKey(doc.service.parent) === parentKey(info.parent));
        if (listed && listed.path && !listed.unsupported) {
            const loaded = await handlers.docs.indexDocument(listed);
            void vscode.window.showInformationMessage(`Added and indexed "${listed.title}" (${loaded.meta.pageCount} pages); the agent finds it as ${listed.id}.`);
        } else {
            void vscode.window.showInformationMessage(`Added "${info.title}"${info.location === 'web' ? '; it is downloaded when needed' : ''}.`);
        }
    } catch (caught) {
        void vscode.window.showErrorMessage(`Adding the document failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
}
