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
 * The output of a CMSIS Run task as its terminal received it, and how a
 * reply shows it (#134).
 *
 * `TerminalOutput` keeps what arrives — raw terminal data, escape sequences
 * and all — within `OUTPUT_KEPT_CHARS`, and counts what it drops;
 * `terminalLines` turns that data into the lines a reader of the terminal
 * sees; `renderOutput` and `outputData` are the block and the `data` of a
 * reply. `commandLineMatches` tells whether the command line VS Code reports
 * for a task terminal is the one a task's command words make: that is how
 * `src/runOutputCapture.ts` finds the terminal of a CMSIS Run task.
 *
 * Pure: no `vscode`.
 */

import { clipValue } from './textBudget';
import type { JsonObject } from './toolResult';

/** A Run's output is kept up to this many characters as received; the oldest are dropped and counted. */
export const OUTPUT_KEPT_CHARS = 64 * 1024;
/**
 * The result of a run shows at most this many of the last lines, and this
 * many characters of them: the budget of a failed build's error lines, since
 * clients that repeat `structuredContent` beside the text double it.
 */
export const RESULT_LINES = 30;
export const RESULT_CHARS = 3_000;
/** `status` shows fewer: it lists the other jobs too. */
export const STATUS_LINES = 20;
export const STATUS_CHARS = 2_000;
/** A longer line is clipped, with the clipped length stated. */
const LINE_CHARS = 300;

/** OSC, DCS, SOS, PM and APC strings, ended by BEL or ST — or by the end of the data, for one still arriving. */
const STRING_SEQUENCE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g;
/** CSI sequences: ESC [, parameter bytes, intermediate bytes, a final byte. */
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** Any other escape (ESC, intermediates, a final byte), or a lone ESC at the end of the data. */
const OTHER_ESCAPE = /\x1b(?:[ -/]*[0-~]|$)/g;
/** C0 controls but tab, line feed and carriage return, and DEL: the EOT an FVP shuts down on, BEL, backspace. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** What a reply shows of an output. */
export interface OutputView {
    /** The last lines as a reader of the terminal sees them, oldest first. */
    lines: string[];
    /** Lines received in all. */
    totalLines: number;
    /** Characters received in all, and how many of the first of them were not kept. */
    receivedChars: number;
    droppedChars: number;
    /** All of it arrived: VS Code reported the end of the terminal's command. */
    complete: boolean;
}

/**
 * The lines a reader of the terminal sees in `raw`, the data a terminal
 * received: escape sequences and control characters removed, CRLF and a
 * line ending in carriage returns as one line break, and of a line that a
 * carriage return rewrote (a progress counter) the text written last. A last
 * line without its line break is kept.
 */
export function terminalLines(raw: string): string[] {
    const text = raw.replace(STRING_SEQUENCE, '').replace(CSI_SEQUENCE, '').replace(OTHER_ESCAPE, '');
    const lines = text.split('\n').map((line) => {
        const bare = line.replace(/\r+$/, '');
        return bare.slice(bare.lastIndexOf('\r') + 1).replace(CONTROL, '');
    });
    if (lines[lines.length - 1] === '') {
        lines.pop();
    }
    return lines;
}

/** The last of `lines` that fit `maxLines` and `maxChars`, each clipped at `LINE_CHARS`; at least one when there is one. */
function lastLines(lines: readonly string[], maxLines: number, maxChars: number): string[] {
    const shown: string[] = [];
    let chars = 0;
    for (let index = lines.length - 1; index >= 0 && shown.length < maxLines; index--) {
        const line = clipValue(lines[index], LINE_CHARS);
        if (shown.length > 0 && chars + line.length + 1 > maxChars) {
            break;
        }
        shown.unshift(line);
        chars += line.length + 1;
    }
    return shown;
}

/**
 * The output of one task terminal: the data as it arrives, the last
 * `OUTPUT_KEPT_CHARS` of it kept, with counts of what arrived and what was
 * dropped. `finish` marks the end, after which `complete` holds.
 */
export class TerminalOutput {
    private kept = '';
    private dropped = 0;
    private received = 0;
    private breaks = 0;
    private endsWithBreak = true;
    private ended = false;

    append(chunk: string): void {
        if (chunk.length === 0) {
            return;
        }
        this.received += chunk.length;
        this.breaks += chunk.split('\n').length - 1;
        this.endsWithBreak = chunk.endsWith('\n');
        this.kept += chunk;
        const over = this.kept.length - OUTPUT_KEPT_CHARS;
        if (over > 0) {
            this.kept = this.kept.slice(over);
            this.dropped += over;
        }
    }

    /** All of the output has arrived. */
    finish(): void {
        this.ended = true;
    }

    get complete(): boolean {
        return this.ended;
    }

    /** The last lines that fit `maxLines` and `maxChars`, and the counts; the first kept line is left out once data was dropped, as it is cut. */
    view(maxLines: number, maxChars: number): OutputView {
        const lines = terminalLines(this.kept);
        const whole = this.dropped > 0 ? lines.slice(1) : lines;
        const shown = lastLines(whole, maxLines, maxChars);
        const totalLines = this.breaks + (this.received > 0 && !this.endsWithBreak ? 1 : 0);
        return { lines: shown, totalLines: Math.max(totalLines, shown.length), receivedChars: this.received, droppedChars: this.dropped, complete: this.ended };
    }
}

/** `1 line`, `7 lines`. */
function lineCount(count: number): string {
    return `${count} line${count === 1 ? '' : 's'}`;
}

/** `730 characters`, `12 kB`. */
function sizeOf(chars: number): string {
    return chars < 1024 ? `${chars} characters` : `${Math.round(chars / 1024)} kB`;
}

/**
 * The block a reply shows: which lines of `task`'s output these are, then the
 * lines. `running` for a task that is still alive; for one that ended, an
 * output whose end VS Code did not report may lack its last lines.
 */
export function renderOutput(task: string, view: OutputView, running: boolean): string {
    if (view.receivedChars === 0) {
        return running ? `'${task}' has printed nothing yet.` : `'${task}' printed nothing${view.complete ? '' : ' that reached this window'}.`;
    }
    const shown = view.lines.length;
    const which = view.totalLines > shown ? `the last ${shown} of ${view.totalLines} lines` : lineCount(shown);
    const notKept = view.droppedChars > 0 ? `; the first ${sizeOf(view.droppedChars)} were not kept` : '';
    const end = running || view.complete ? '' : '; VS Code reported no end of it, so the last lines may be missing';
    return `Output of '${task}'${running ? ' so far' : ''} (${which}${notKept}${end}):\n${view.lines.join('\n')}`;
}

/** The output as `data` of a reply carries it: the counts; the lines are in the text, which `structuredContent.message` carries too. */
export function outputData(task: string, view: OutputView): JsonObject {
    return {
        task,
        shownLines: view.lines.length,
        totalLines: view.totalLines,
        receivedChars: view.receivedChars,
        droppedChars: view.droppedChars,
        complete: view.complete,
    };
}

/** A VS Code variable in a task's words (`${command:cmsis-csolution.getCbuildRunFile}`), resolved before the task runs. */
const VARIABLE = /\$\{[^}]*\}/;

/** Without quotes and the backslashes that escape a space or a quote; white space as single spaces. */
function unquoted(text: string): string {
    return text.replace(/\\(?=[\s"'])/g, '').replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a task terminal's command line is the one `words` make, the
 * program and arguments of a task (`taskCommandWords`). VS Code writes a
 * shell task's command and arguments, quoted for its shell, as the command
 * line of the terminal's command, and a process task's after an "Executing
 * task:" text: the words end the command line. Quotes and the backslashes
 * that escape spaces or quotes are ignored, and a VS Code variable in a word
 * matches any text.
 */
export function commandLineMatches(commandLine: string, words: readonly string[]): boolean {
    const parts = words.map(unquoted).filter((word) => word.length > 0);
    if (parts.length === 0) {
        return false;
    }
    const pattern = parts.map((word) => word.split(VARIABLE).map(escapeRegExp).join('.*?').replace(/ /g, '\\s+')).join('\\s+');
    return new RegExp(`(?:^|\\s)${pattern}$`).test(unquoted(commandLine));
}
