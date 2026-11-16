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
 * The palette commands of the documentation tools: list and index the current
 * target's documents into the output channel, import PDFs the packs do not
 * ship, open the user documents folder, move that folder's documents into
 * CMSIS Solution's inventory, and open the Pack Docs panel. Available whether
 * or not the MCP tools are enabled — the handlers exist in every window.
 *
 * Import goes through CMSIS Solution's *Add Document* when it has one
 * (after 1.72.0): its file picker, attributed to the active target's board
 * or device, into `~/.cmsis/docs`; the documents it added are found by
 * comparing the target's listing before and after, and indexed. With
 * 1.72.0 the wizard of the user documents folder stays.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { BookCategory, DocRef, UserScope, importUserDoc, resolveUserDocsDir } from './core/packDocs';
import { errorText, textOf, toToolError } from './core/toolResult';
import { PackDocsHandlers } from './packDocsDispatch';
import { readPackDocsSettings } from './packDocsHost';
import { KnowledgePanel } from './knowledgePanel';
import { PackDocsPanel } from './packDocsPanel';
import { SOLUTION_EXTENSION_ID } from './core/bootstrapState';
import { documentApiOf, ProposedDocParent } from './core/packDocs/documentApi';
import { peekSolutionApi } from './core/solutionApi';
import { logger } from './utils/logger';

/** CMSIS Solution's command that adds a document to the active target's board or device (after 1.72.0). */
const SOLUTION_ADD_DOCUMENT = 'cmsis-csolution.addDocument';

const CONFIG = 'cmsis-developer-assistant';

/** A multi-line tool result under one heading in the output channel. */
function logBlock(title: string, body: string, maxLines: number): void {
    const lines = body.split('\n');
    const shown = lines.slice(0, maxLines);
    logger.info(`${title}:\n  ${shown.join('\n  ')}${lines.length > maxLines ? `\n  … ${lines.length - maxLines} more lines` : ''}`);
}

export function registerPackDocsCommands(context: vscode.ExtensionContext, handlers: PackDocsHandlers): void {
    const { docs } = handlers;
    context.subscriptions.push(
        vscode.commands.registerCommand(`${CONFIG}.listTargetDocs`, async () => {
            logger.show();
            const listing = await docs.handleListTargetDocs({}).then(textOf, (failure: unknown) => errorText(toToolError(failure)));
            logBlock('list_target_docs (command)', listing, 200);
        }),

        vscode.commands.registerCommand(`${CONFIG}.indexTargetDocs`, async () => {
            logger.show();
            const summary = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CMSIS Developer Assistant: indexing target documentation', cancellable: false },
                (progress) => docs.indexTarget({}, (message) => progress.report({ message })),
            );
            logBlock('index (command)', summary, 100);
            vscode.window.showInformationMessage(summary.split('\n').slice(-1)[0]);
        }),

        vscode.commands.registerCommand(`${CONFIG}.openUserDocsFolder`, async () => {
            const dir = resolveUserDocsDir(readPackDocsSettings().userDocsDir);
            fs.mkdirSync(dir, { recursive: true });
            await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }),

        vscode.commands.registerCommand(`${CONFIG}.importUserDoc`, async () => {
            if ((await vscode.commands.getCommands(true)).includes(SOLUTION_ADD_DOCUMENT)) {
                const route = await vscode.window.showQuickPick([
                    { label: '$(add) Add to the CMSIS view', description: 'CMSIS Solution\'s Add Document: the active target\'s board or device', solution: true },
                    { label: '$(folder) Import into the user documents folder', description: 'attribute to a pack, device family, board, core or all targets', solution: false },
                ], { title: 'Import Document for Current Target', placeHolder: 'Where should the document go?' });
                if (route === undefined) { return; }
                return route.solution ? addThroughSolution(handlers) : importUserDocuments(handlers);
            }
            return importUserDocuments(handlers);
        }),

        vscode.commands.registerCommand(`${CONFIG}.migrateUserDocs`, () => migrateUserDocuments(handlers)),

        vscode.commands.registerCommand(`${CONFIG}.openPackDocsPanel`, () => {
            PackDocsPanel.show(context, handlers.docs, handlers.build, logger);
        }),

        vscode.commands.registerCommand(`${CONFIG}.openKnowledgePanel`, () => {
            if (handlers.knowledge === undefined) {
                void vscode.window.showInformationMessage('CMSIS Developer Assistant: this window has no knowledge handler.');
                return;
            }
            KnowledgePanel.show(context, handlers.knowledge, logger);
        }),
    );
}

/**
 * Add a document through CMSIS Solution's *Add Document* (its picker, its
 * folder, its inventory), then index what it added for the current target.
 * The command answers nothing, so the target's listing before and after
 * tells which documents are new.
 */
async function addThroughSolution(handlers: PackDocsHandlers): Promise<void> {
    const { docs } = handlers;
    const before = new Set((await docs.inspectTarget({})).docs.map((doc) => doc.id));
    await vscode.commands.executeCommand(SOLUTION_ADD_DOCUMENT);
    const after = await docs.inspectTarget({});
    const added = after.docs.filter((doc) => !before.has(doc.id) && doc.path !== undefined && !doc.unsupported && !doc.missing);
    if (added.length === 0) {
        logger.info('import: CMSIS Solution added no document for the current target (cancelled, or attributed elsewhere)');
        return;
    }
    const lines: string[] = [];
    for (const doc of added) {
        try {
            const loaded = await docs.indexDocument(doc);
            lines.push(`${doc.id}: ${loaded.meta.pageCount} pages — ${doc.path}`);
        } catch (e) {
            lines.push(`${doc.id}: added by CMSIS Solution, indexing failed — ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    logBlock('import through CMSIS Solution (command)', lines.join('\n'), 50);
    void vscode.window.showInformationMessage(`Added through the CMSIS view and indexed: ${lines.join('; ')}`);
}

/**
 * Move the current target's documents of the legacy user documents folder
 * into CMSIS Solution's inventory, through the proposed `addDocument` of its
 * API (2.9.2 stage 3; inert until CMSIS Solution ships it). Documents under
 * `devices/` go to the target's device, under `boards/` to its board; those
 * attributed to a pack, vendor, core or every target wait for those
 * attributions in CMSIS Solution (gap G2). Nothing is copied or deleted
 * here: CMSIS Solution copies the file, the legacy folder stays as it is.
 */
async function migrateUserDocuments(handlers: PackDocsHandlers): Promise<void> {
    const { docs } = handlers;
    const api = readPackDocsSettings().proposedDocumentApi === true
        ? documentApiOf(peekSolutionApi(vscode.extensions.getExtension(SOLUTION_EXTENSION_ID))) : {};
    if (api.addDocument === undefined) {
        void vscode.window.showInformationMessage('CMSIS Developer Assistant: moving the user documents needs a CMSIS Solution whose API can add documents '
            + '(proposed, not released yet; setting packDocs.proposedDocumentApi). The folder stays a source of the documentation tools meanwhile.');
        return;
    }
    const target = await docs.inspectTarget({});
    const keys = docs.targetKeys();
    const root = resolveUserDocsDir(readPackDocsSettings().userDocsDir);
    const legacy = target.docs.filter((doc) => doc.source === 'user' && doc.inventory === undefined && doc.path !== undefined);
    if (legacy.length === 0) {
        void vscode.window.showInformationMessage('CMSIS Developer Assistant: the user documents folder holds nothing for the current target.');
        return;
    }
    const done: string[] = [];
    const left: string[] = [];
    for (const doc of legacy) {
        const top = path.relative(root, doc.path!).split(path.sep)[0];
        const parent: ProposedDocParent | undefined = top === 'devices' && keys.device ? { device: keys.device }
            : top === 'boards' && keys.board ? { board: keys.board } : undefined;
        if (parent === undefined) {
            left.push(`${doc.id} (attributed to a pack, vendor, core or every target: CMSIS Solution has no such attribution yet)`);
            continue;
        }
        try {
            await api.addDocument(parent, doc.path!, { title: doc.title, ...(doc.category ? { category: doc.category } : {}) });
            done.push(doc.id);
        } catch (e) {
            left.push(`${doc.id} (${e instanceof Error ? e.message : String(e)})`);
        }
    }
    logBlock('move user documents into the CMSIS view (command)', [...done.map((id) => `added: ${id}`), ...left.map((why) => `left: ${why}`)].join('\n'), 100);
    void vscode.window.showInformationMessage(`CMSIS Developer Assistant: ${done.length} document(s) added to the CMSIS view, ${left.length} left in ${root}.`);
}

/**
 * Import PDFs the packs do not ship (NDA manuals, portal downloads) into the
 * user documents folder, attributed to the current target's pack, device,
 * board or core, and index them right away.
 */
async function importUserDocuments(handlers: PackDocsHandlers): Promise<void> {
    const { docs } = handlers;
    const root = resolveUserDocsDir(readPackDocsSettings().userDocsDir);
    const files = await vscode.window.showOpenDialog({
        canSelectMany: true, canSelectFolders: false, filters: { 'PDF documents': ['pdf'] }, openLabel: 'Import',
        title: 'Import documents into the user documents folder',
    });
    if (!files?.length) { return; }

    const t = await docs.inspectTarget({});
    const scopes: (vscode.QuickPickItem & { scope: UserScope })[] = [];
    if (t.devicePack) {
        const [vendor, rest] = t.devicePack.split('::');
        scopes.push({ label: `$(package) Pack ${vendor}::${rest.split('@')[0]}`, description: 'every target using this device pack, any version', scope: { kind: 'pack', vendor, name: rest.split('@')[0] } });
    }
    if (t.device) {
        scopes.push({ label: `$(chip) Device ${t.device}`, description: 'this device only', scope: { kind: 'device', pattern: t.device } });
        const family = t.device.replace(/[A-Z0-9]{2,}$/i, '').replace(/[^A-Za-z0-9]+$/, '');
        if (family.length >= 5 && family !== t.device) {
            scopes.push({ label: `$(chip) Devices ${family}*`, description: 'the device family (glob)', scope: { kind: 'device', pattern: `${family}*` } });
        }
    }
    if (t.boardPack) {
        const [vendor, rest] = t.boardPack.split('::');
        scopes.push({ label: `$(circuit-board) Board pack ${vendor}::${rest.split('@')[0]}`, description: 'every target using this board pack', scope: { kind: 'pack', vendor, name: rest.split('@')[0] } });
    }
    if (t.board) { scopes.push({ label: `$(circuit-board) Board ${t.board}`, description: 'this board only', scope: { kind: 'board', pattern: t.board } }); }
    for (const core of new Set(t.cores)) { scopes.push({ label: `$(cpu) Core ${core}`, description: 'every target with this core', scope: { kind: 'core', core } }); }
    scopes.push({ label: '$(globe) All targets', description: 'listed for every target', scope: { kind: 'all' } });
    scopes.push({ label: '$(edit) Device pattern…', description: 'a glob such as STM32U5*', scope: { kind: 'device', pattern: '' } });
    const picked = await vscode.window.showQuickPick(scopes, {
        title: t.error ? 'No target resolved in this workspace — attribute the document by hand' : `Attribute to … (target: ${t.device ?? '?'}, ${t.devicePack ?? '?'})`,
        placeHolder: 'Which targets should see this document?',
    });
    if (!picked) { return; }
    let scope = picked.scope;
    if (scope.kind === 'device' && !scope.pattern) {
        const pattern = await vscode.window.showInputBox({ title: 'Device pattern', prompt: 'Device name or glob, e.g. STM32U585AIIx or STM32U5*', value: t.device ?? '' });
        if (!pattern?.trim()) { return; }
        scope = { kind: 'device', pattern: pattern.trim() };
    }
    const categories: (vscode.QuickPickItem & { category?: BookCategory })[] = [
        { label: 'manual', description: 'reference manual, user manual, TRM — ranked first in search', category: 'manual' },
        { label: 'overview', description: 'datasheet, product brief', category: 'overview' },
        { label: 'schematic', category: 'schematic' },
        { label: 'setup', description: 'getting started, board setup', category: 'setup' },
        { label: 'other', category: 'other' },
    ];

    const imported: { doc: DocRef; dest: string; replaced: boolean }[] = [];
    for (const uri of files) {
        const name = path.basename(uri.fsPath);
        const title = await vscode.window.showInputBox({ title: `Title for ${name}`, value: name.replace(/\.pdf$/i, ''), prompt: 'Shown in listings and citations' });
        if (title === undefined) { return; }
        const category = await vscode.window.showQuickPick(categories, { title: `Category for ${name}`, placeHolder: 'manual' });
        if (!category) { return; }
        const revision = await vscode.window.showInputBox({ title: `Edition of ${name} (optional)`, prompt: 'e.g. Rev 2, printed with every citation', value: '' });
        if (revision === undefined) { return; }
        const r = importUserDoc(root, scope, uri.fsPath, { title, category: category.category, revision });
        const doc: DocRef = {
            id: r.id, title: title.trim() || name, ...(category.category ? { category: category.category } : {}), ...(revision.trim() ? { revision: revision.trim() } : {}),
            scope: 'user', source: 'user', path: r.dest, sizeBytes: fs.statSync(r.dest).size, cached: false, indexed: false,
        };
        imported.push({ doc, dest: r.dest, replaced: r.replaced });
        logger.info(`imported ${uri.fsPath} → ${r.dest} (${JSON.stringify(scope)})`);
    }

    const summary = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CMSIS Developer Assistant: indexing imported documents', cancellable: false },
        async (progress) => {
            const lines: string[] = [];
            for (const { doc, dest, replaced } of imported) {
                progress.report({ message: doc.id });
                try {
                    const loaded = await docs.indexDocument(doc);
                    lines.push(`${doc.id}: ${loaded.meta.pageCount} pages${replaced ? ' (replaced)' : ''} — ${dest}`);
                } catch (e) {
                    lines.push(`${doc.id}: copied to ${dest}, indexing failed — ${e instanceof Error ? e.message : e}`);
                }
            }
            return lines;
        },
    );
    logBlock('import (command)', summary.join('\n'), 50);
    const open = 'Open folder';
    const choice = await vscode.window.showInformationMessage(`Imported ${imported.length} document${imported.length === 1 ? '' : 's'}: ${summary.join('; ')}`, open);
    if (choice === open) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(imported[0].dest)); }
}
