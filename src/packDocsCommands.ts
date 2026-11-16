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
 * target's documents into the output channel, add a document the packs do not
 * ship (through the document service, or CMSIS Solution's *Add Document*
 * where it exists), and open the Pack Docs and knowledge panels. Available
 * whether or not the MCP tools are enabled — the handlers exist in every
 * window.
 *
 * CMSIS Solution's *Add Document* answers nothing; the documents it added are
 * found by comparing the target's listing before and after, and indexed.
 */

import * as vscode from 'vscode';

import { errorText, textOf, toToolError } from './core/toolResult';
import { PackDocsHandlers } from './packDocsDispatch';
import { KnowledgePanel } from './knowledgePanel';
import { PackDocsPanel } from './packDocsPanel';
import { addDocument } from './targetDocsView';
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

        vscode.commands.registerCommand(`${CONFIG}.importUserDoc`, async () => {
            // The document service takes every attribution and the project scope; CMSIS Solution's Add Document is offered beside it.
            if ((await vscode.commands.getCommands(true)).includes(SOLUTION_ADD_DOCUMENT)) {
                const picked = await vscode.window.showQuickPick([
                    { label: '$(add) Add to the target\'s documents', description: 'device, board, core, pack, vendor or all targets; for you or the project', route: 'service' },
                    { label: '$(list-tree) Add in the CMSIS view', description: 'CMSIS Solution\'s Add Document: the active target\'s board or device', route: 'solution' },
                ], { title: 'Import Document for Current Target' });
                if (picked === undefined) { return; }
                return picked.route === 'solution' ? addThroughSolution(handlers) : addDocument(handlers);
            }
            return addDocument(handlers);
        }),

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
