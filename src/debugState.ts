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
 * Where the debugger is right now, as a plain value: session, configuration,
 * source location with a short look-ahead, DAP frame and thread, call stack and
 * the window's breakpoints. `DebuggingExecutor` fills one per query;
 * `DebuggingHandler` returns it to the agent in a full form (session start) or
 * a compact form (after every step, continue, pause and wait).
 *
 * No imports, `vscode` included, so it is unit-testable outside the host.
 */

export interface StackFrame {
    name: string;
    source?: string;
    line?: number;
    column?: number;
    frameId?: number;
}

/**
 * The parts of a VS Code breakpoint that change when it fires. Source and
 * function breakpoints are passed in structurally.
 */
export interface BreakpointModifiers {
    condition?: string;
    logMessage?: string;
    hitCondition?: string;
    enabled?: boolean;
}

/**
 * A breakpoint's modifiers as a suffix such as ` [when: n > 0, disabled]`, or
 * '' for a plain enabled breakpoint. An absent `enabled` counts as enabled.
 * Values go in verbatim.
 */
export function formatBreakpointModifiers(bp: BreakpointModifiers): string {
    const parts: string[] = [];
    if (bp.condition) { parts.push(`when: ${bp.condition}`); }
    if (bp.logMessage) { parts.push(`log: ${bp.logMessage}`); }
    if (bp.hitCondition) { parts.push(`hits: ${bp.hitCondition}`); }
    if (bp.enabled === false) { parts.push('disabled'); }
    return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

/** The data members of a DebugState: what `reset()` restores and the serialisers pick from. */
type StateField =
    | 'sessionActive' | 'configurationName' | 'stackTrace' | 'breakpoints'
    | 'fileFullPath' | 'fileName' | 'currentLine' | 'currentLineContent' | 'nextLines'
    | 'frameId' | 'threadId' | 'frameName';

/** Key order of `toString()`. */
const FULL_KEYS: readonly StateField[] = [
    'sessionActive', 'configurationName', 'stackTrace', 'breakpoints',
    'fileFullPath', 'fileName', 'currentLine', 'currentLineContent', 'nextLines',
    'frameId', 'threadId', 'frameName',
];

/** Key order of `toCompactString()` up to the stack; the stack and the breakpoint entry follow. */
const COMPACT_LEAD_KEYS: readonly StateField[] = [
    'sessionActive', 'frameName', 'fileFullPath', 'currentLine', 'currentLineContent', 'nextLines',
    'frameId', 'threadId',
];

/** Frames the compact form lists before collapsing the rest into one marker. */
const COMPACT_FRAMES_DEFAULT = 5;

type Entry = [key: string, value: unknown];

/** Both forms: two-space JSON with the keys in the order given. */
function toJson(entries: Entry[]): string {
    return JSON.stringify(Object.fromEntries(entries), null, 2);
}

/** `name:line`, with `?` for a missing (or zero) line. */
function frameLabel(frame: StackFrame): string {
    const where = frame.line ? String(frame.line) : '?';
    return `${frame.name}:${where}`;
}

function initialFields(): Pick<DebugState, StateField> {
    return {
        sessionActive: false,
        configurationName: null,
        stackTrace: [],
        breakpoints: [],
        fileFullPath: null,
        fileName: null,
        currentLine: null,
        currentLineContent: null,
        nextLines: [],
        frameId: null,
        threadId: null,
        frameName: null,
    };
}

export class DebugState {
    /** A debug session is active; when false, the serialised forms carry nothing else. */
    sessionActive!: boolean;
    /** Absolute path of the source file of the top frame. */
    fileFullPath!: string | null;
    /** Base name of `fileFullPath`. */
    fileName!: string | null;
    /** 1-based line of the top frame. */
    currentLine!: number | null;
    /** That line's text, trimmed. */
    currentLineContent!: string | null;
    /** The next few non-empty source lines after it. */
    nextLines!: string[];
    frameId!: number | null;
    threadId!: number | null;
    /** Function name of the top frame. */
    frameName!: string | null;
    stackTrace!: StackFrame[];
    /** Name of the launch configuration the session runs. */
    configurationName!: string | null;
    /** `<fileName>:<line>` plus the `formatBreakpointModifiers` suffix, by convention. */
    breakpoints!: string[];

    constructor() {
        this.reset();
    }

    /** Back to what a new instance holds, with fresh empty arrays. */
    reset(): void {
        Object.assign(this, initialFields());
    }

    /** Session active and both DAP ids known (0 is a valid id). */
    hasValidContext(): boolean {
        if (!this.sessionActive) {
            return false;
        }
        return [this.frameId, this.threadId].every(id => id !== null);
    }

    /** File and line are both known; the session flag is not consulted. */
    hasLocationInfo(): boolean {
        return ![this.fileName, this.currentLine].includes(null);
    }

    /** A frame name is known; the empty string counts. */
    hasFrameName(): boolean {
        return typeof this.frameName === 'string';
    }

    updateContext(frame: number, thread: number): void {
        this.frameId = frame;
        this.threadId = thread;
    }

    updateLocation(fullPath: string, baseName: string, line: number, lineText: string, following: string[]): void {
        this.fileFullPath = fullPath;
        this.fileName = baseName;
        this.currentLine = line;
        this.currentLineContent = lineText;
        this.nextLines = following.slice();
    }

    updateFrameName(name: string | null): void {
        this.frameName = name;
    }

    /** Keeps a copy of the array; the frame objects themselves are shared. */
    updateStackTrace(frames: StackFrame[]): void {
        this.stackTrace = frames.slice();
    }

    updateConfigurationName(name: string | null): void {
        this.configurationName = name;
    }

    updateBreakpoints(list: string[]): void {
        this.breakpoints = list.slice();
    }

    /** Field-for-field copy with its own arrays (frame objects shared). */
    clone(): DebugState {
        const twin = Object.assign(new DebugState(), this);
        twin.nextLines = this.nextLines.slice();
        twin.stackTrace = this.stackTrace.slice();
        twin.breakpoints = this.breakpoints.slice();
        return twin;
    }

    /** Full form: every field, every frame, every breakpoint. */
    toString(): string {
        if (!this.sessionActive) {
            return toJson([['sessionActive', false]]);
        }
        return toJson(FULL_KEYS.map((key): Entry =>
            [key, key === 'stackTrace' ? this.stackTrace.map(frameLabel) : this[key]]));
    }

    /**
     * Compact form for motion tools: no configuration or base file name, the
     * stack cut to `maxFrames` (default 5) plus a marker pointing to
     * get_call_stack, and the breakpoint list only when the caller says it
     * changed — otherwise just its length.
     */
    toCompactString(options: { includeBreakpoints: boolean; maxFrames?: number }): string {
        if (!this.sessionActive) {
            return toJson([['sessionActive', false]]);
        }
        const entries: Entry[] = COMPACT_LEAD_KEYS.map((key): Entry => [key, this[key]]);
        entries.push(['stackTrace', this.abridgedStack(options.maxFrames ?? COMPACT_FRAMES_DEFAULT)]);
        entries.push(options.includeBreakpoints
            ? ['breakpoints', this.breakpoints]
            : ['breakpointsUnchanged', this.breakpoints.length]);
        return toJson(entries);
    }

    private abridgedStack(limit: number): string[] {
        const labels = this.stackTrace.map(frameLabel);
        if (labels.length <= limit) {
            return labels;
        }
        const omitted = labels.length - limit;
        return [...labels.slice(0, limit), `… ${omitted} more — get_call_stack`];
    }
}
