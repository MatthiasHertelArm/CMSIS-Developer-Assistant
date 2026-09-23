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

// DAP scenario oracle.
//
// Drives the real MCP server (single-window default constructor) over HTTP
// against a SCRIPTED gdbtarget debug session and records, per tool call, the
// reply the agent sees and the traffic the call caused: DAP requests sent
// through session.customRequest, VS Code commands executed, debug API calls
// (breakpoints, start/stop), and the adapter events the script emitted.
//
//   node test/transport/dap-scenarios.js                 compare with the snapshot
//   node test/transport/dap-scenarios.js --update        rewrite the snapshot
//   node test/transport/dap-scenarios.js --only=<name>   run one scenario, print it, compare nothing
//
// No VS Code window, network, probe or GDB is involved: `vscode` is the stub
// from vscode-stub.js, extended below with a fake debug session, adapter
// tracker, breakpoint model, tasks and command log.
//
// The scripted adapter answers the way cdt-gdb-adapter (the adapter behind
// `gdbtarget`) answers today, including where that exposes bugs in the code
// under test. In particular only REPL input starting with '>' is a GDB CLI
// command; an evaluate of `-exec <cmd>` is handed to GDB as an expression,
// -var-create fails, and the adapter answers SUCCESS with the result text
// "Error: could not evaluate expression". So every `-exec break/clear/delete/
// dprintf/monitor ...` the code sends does nothing on a real gdbtarget
// session, and the snapshot pins exactly that. Other fidelity choices:
//   - frame handles are 1000 + level (thread 1), as the adapter's first
//     allocation after a stop; they are invalid while the target runs;
//   - registers evaluate in GDB's natural format for pyOCD's target
//     description: r0-r12, lr, xpsr, control, ... are `int` (signed decimal,
//     so EXC_RETURN 0xfffffff9 reads "-7"), sp/msp/psp are `void *`, pc is a
//     code pointer "0x80002fe <main+22>", an unknown `$name` is `void`;
//   - an inaccessible -data-read-memory-bytes fails "Unable to read memory.";
//     GDB MI commands on a running all-stop remote target fail with GDB's
//     "Cannot execute this command while the target is running." text;
//   - a `monitor ...` reset never reaches GDB, so no stopped event follows.
// VS Code itself is modelled only as far as the code under test can see it:
// after a stopped event `activeStackItem` becomes frame 1000 of the focused
// session at once, a continued event clears it; VS Code's own DAP traffic
// (its stackTrace after a stop, setBreakpoints for the breakpoint model) is
// not modelled; the breakpoint model is a plain list without de-duplication.
//
// Scenarios are independent: each gets a fresh server, a fresh fake session
// and an empty breakpoint model. Module-level state in the code under test
// (the session tracker's diagnostics ring, the pack-root answer, the parsed
// SVD cache) persists across scenarios as it does across sessions in one
// extension host; `cmsis-csolution.getPackRootPath` is answered but not
// logged, because it is asked once per process and would otherwise tie the
// log of one scenario to the order they run in.
//
// A refactoring or rewrite that is meant to change no behaviour must leave
// the replies identical; the traffic lists show what a changed reply was
// built from. A deliberate change updates the snapshot in the same commit.

const stub = require('./vscode-stub.js');

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const OUT = path.resolve(__dirname, '..', '..', 'out', 'src');
const SNAPSHOT = path.join(__dirname, 'dap-scenarios.snapshot.json');
const CALL_TIMEOUT_MS = 90_000;

// ── Stub extensions ────────────────────────────────────────────────────────

function emitter() {
    const listeners = new Set();
    return {
        event: (fn) => { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
        fire: (e) => { for (const l of [...listeners]) { l(e); } },
    };
}

const bus = {
    didStart: emitter(),
    didTerminate: emitter(),
    didChangeActiveSession: emitter(),
    didChangeStackItem: emitter(),
    taskStart: emitter(),
    taskEnd: emitter(),
};
const trackerFactories = [];

/** The scenario being recorded; the stub hooks delegate to it. */
let current = null;

function describeBreakpoint(bp) {
    const where = `${bp.location.uri.fsPath}:${bp.location.range.start.line + 1}`;
    const mods = [];
    if (bp.condition) { mods.push(`when: ${bp.condition}`); }
    if (bp.logMessage) { mods.push(`log: ${bp.logMessage}`); }
    return mods.length ? `${where} [${mods.join(', ')}]` : where;
}

Object.assign(stub.debug, {
    breakpoints: [],
    registerDebugAdapterTrackerFactory(_type, factory) {
        trackerFactories.push(factory);
        return { dispose() { trackerFactories.splice(trackerFactories.indexOf(factory), 1); } };
    },
    onDidStartDebugSession: bus.didStart.event,
    onDidTerminateDebugSession: bus.didTerminate.event,
    onDidChangeActiveDebugSession: bus.didChangeActiveSession.event,
    onDidChangeActiveStackItem: bus.didChangeStackItem.event,
    async startDebugging(folder, nameOrConfig) {
        const name = typeof nameOrConfig === 'string' ? nameOrConfig : nameOrConfig?.name;
        current.record(`vscode: debug.startDebugging folder=${folder?.uri?.fsPath ?? '<none>'} configuration=${JSON.stringify(name)}`);
        return current.startDebugging(name);
    },
    async stopDebugging(session) {
        current.record(`vscode: debug.stopDebugging session=${JSON.stringify(session?.name ?? null)}`);
        if (session) { current.endSession(session); }
    },
    addBreakpoints(bps) {
        current.record(`vscode: debug.addBreakpoints ${bps.map(describeBreakpoint).join(', ')}`);
        stub.debug.breakpoints = [...stub.debug.breakpoints, ...bps];
    },
    removeBreakpoints(bps) {
        current.record(`vscode: debug.removeBreakpoints ${bps.map(describeBreakpoint).join(', ')}`);
        stub.debug.breakpoints = stub.debug.breakpoints.filter((bp) => !bps.includes(bp));
    },
});

stub.tasks = { onDidStartTaskProcess: bus.taskStart.event, onDidEndTaskProcess: bus.taskEnd.event };

// Real files, read the way VS Code's TextDocument exposes them.
stub.workspace.openTextDocument = async (uri) => {
    const fsPath = uri.fsPath;
    let text;
    try {
        text = fs.readFileSync(fsPath, 'utf8');
    } catch {
        throw new Error(`cannot open ${uri.toString()}. Detail: Unable to read file '${fsPath}' ` +
            `(Error: Unable to resolve nonexistent file '${fsPath}')`);
    }
    const lines = text.split(/\r?\n/);
    return { uri, lineCount: lines.length, lineAt: (i) => ({ text: lines[i] }), getText: () => text };
};

// Asked once per process and cached by the code under test — see the header.
const UNLOGGED_COMMANDS = new Set(['cmsis-csolution.getPackRootPath']);

stub.commands.executeCommand = async (command, ...args) => {
    if (!current) { return undefined; }
    if (!UNLOGGED_COMMANDS.has(command)) {
        current.record(`command: ${command}${args.length ? ` ${JSON.stringify(args)}` : ''}`);
    }
    const handler = current.commands[command];
    return handler ? handler(current, ...args) : undefined;
};

// ── The scripted target ────────────────────────────────────────────────────

const RUNNING_MSG = 'Cannot execute this command while the target is running.\n' +
    'Use the "interrupt" command to stop the target\nand then try again.';
const NOT_EVALUATED = 'Error: could not evaluate expression';
const GDB_BANNER = '\nIn the Debug Console view you can interact directly with GDB.\n' +
    'To display the value of an expression, type that expression which can reference\n' +
    "variables that are in scope. For example type '2 + 3' or the name of a variable.\n" +
    "Arbitrary commands can be sent to GDB by prefixing the input with a '>',\n" +
    "for example type '>show version' or '>help'.\n\n";

const FUNCTIONS = [
    ['Reset_Handler', 0x08000198], ['NMI_Handler', 0x080001a0], ['HardFault_Handler', 0x080001a4],
    ['delay_ms', 0x08000248], ['led_init', 0x08000260], ['led_toggle', 0x08000268], ['main', 0x080002e8],
    ['parse_node', 0x08000480], ['sensor_task', 0x08000540], ['osRtxIdleThread', 0x08001a30],
];

function symbolise(addr) {
    let best = null;
    for (const [name, start] of FUNCTIONS) {
        if (start <= addr && (!best || start > best[1])) { best = [name, start]; }
    }
    if (!best || addr - best[1] > 0x100) { return `0x${addr.toString(16)}`; }
    const off = addr - best[1];
    return `0x${addr.toString(16)} <${best[0]}${off ? `+${off}` : ''}>`;
}

const hex = (n) => `0x${(n >>> 0).toString(16)}`;

/** Where the target can stop. `file` is a project-relative source, or null for no debug info. */
function frame(fn, file, line, addr) { return { fn, file, line, addr }; }
const LOCATIONS = {
    main29: [frame('main', 'main.c', 29, 0x080002f4)],
    main31: [frame('main', 'main.c', 31, 0x080002fe)],
    main32: [frame('main', 'main.c', 32, 0x08000302)],
    ledToggle17: [frame('led_toggle', 'led.c', 17, 0x0800026c), frame('main', 'main.c', 31, 0x08000302)],
    ledToggle18: [frame('led_toggle', 'led.c', 18, 0x08000276), frame('main', 'main.c', 31, 0x08000302)],
    delayLoop: [frame('delay_ms', 'main.c', 17, 0x08000256), frame('main', 'main.c', 32, 0x08000306)],
    hardFault: [
        frame('HardFault_Handler', null, 0, 0x080001a4), frame('<signal handler called>', null, 0, 0xfffffff9),
        frame('led_toggle', 'led.c', 18, 0x0800027a), frame('main', 'main.c', 31, 0x08000302),
    ],
    resetHandler: [frame('Reset_Handler', null, 0, 0x08000198)],
};

const BASE_REGS = {
    r0: 0x2a, r1: 0x40020000, r2: 0x20, r3: 0x20000010, r4: 0x1f4, r5: 0, r6: 0, r7: 0x20017fd0,
    r8: 0, r9: 0, r10: 0, r11: 0, r12: 0x08000f10, sp: 0x20017fd0, lr: 0x080001b1,
    xpsr: 0x61000000, psp: 0, primask: 0, basepri: 0, faultmask: 0, control: 0,
};
const REG_OVERRIDES = {
    ledToggle17: { sp: 0x20017fc8, r7: 0x20017fc8, lr: 0x08000303 },
    ledToggle18: { sp: 0x20017fc8, r7: 0x20017fc8, lr: 0x08000303, r3: 0x20 },
    delayLoop: { sp: 0x20017fc0, r7: 0x20017fc0, lr: 0x08000307, r3: 0x3039, r2: 0x7a120 },
    hardFault: { r0: 0x5fffffec, r1: 0x20, r2: 0, r3: 0x20000010, r12: 0, sp: 0x20017fa8, r7: 0x20017fc8, lr: 0xfffffff9, xpsr: 0x61000003 },
    resetHandler: { r0: 0, r1: 0, r2: 0, r3: 0, r4: 0, r7: 0, r12: 0, sp: 0x20018000, lr: 0xffffffff, xpsr: 0x01000000 },
};
const REGISTER_ORDER = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12',
    'sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'primask', 'basepri', 'faultmask', 'control'];

/** Symbols GDB can evaluate: [value, type, children?]. */
const GLOBALS = {
    SystemCoreClock: ['84000000', 'uint32_t'],
    counter: ['42', 'volatile uint32_t'],
    'counter * 2': ['84', 'unsigned long'],
};
const LOCALS = {
    main: {
        config: ['{...}', 'led_config_t', [['period_ms', '500', 'uint32_t'], ['pin', "5 '\\005'", 'uint8_t']]],
        ledState: ['true', '_Bool'],
        buffer: ['"Hello, Cortex-M!"', 'char [16]', [...'Hello, Cortex-M!'].map((c, i) => [`[${i}]`, `${c.charCodeAt(0)} '${c}'`, 'char'])],
        password: ['0x8000f10 "hunter2"', 'const char *', [['*password', "104 'h'", 'const char']]],
        api_key: ['"AK-7f3a9c21e0b4"', 'char [16]', [...'AK-7f3a9c21e0b4'].map((c, i) => [`[${i}]`, `${c.charCodeAt(0)} '${c}'`, 'char'])],
    },
    led_toggle: { mask: ['32', 'uint32_t'] },
    delay_ms: { ms: ['500', 'uint32_t'], i: ['12345', 'volatile uint32_t'] },
};

const THREAD_SETS = {
    single: [{ id: 1, name: '1' }],
    rtx: [
        { id: 1, name: 'app_main (Running; Priority 24)' },
        { id: 2, name: 'osRtxIdleThread (Ready; Priority 1)', frames: [frame('osRtxIdleThread', '@packs/ARM/CMSIS-RTX/5.9.0/Source/rtx_lib.c', 546, 0x08001a42)] },
        {
            id: 3, name: 'sensor_task (Waiting; Priority 24)',
            frames: [
                ...Array.from({ length: 24 }, (_, i) => frame('parse_node', 'sensor.c', 41 + (i % 2) * 3, 0x080004c2 + (i % 2) * 8)),
                frame('sensor_task', 'sensor.c', 88, 0x08000566),
            ],
        },
    ],
};

/** Target memory: word values by address; everything outside READABLE fails. */
const READABLE = [[0x08000000, 0x08080000], [0x20000000, 0x20018000], [0x40000000, 0x40080000], [0xe0000000, 0xe0100000]];
function baseMemory() {
    const words = new Map();
    const bytes = (addr, list) => {
        for (let i = 0; i < list.length; i += 4) {
            const w = (list[i] ?? 0) | ((list[i + 1] ?? 0) << 8) | ((list[i + 2] ?? 0) << 16) | ((list[i + 3] ?? 0) << 24);
            words.set(addr + i, w >>> 0);
        }
    };
    const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
    // Vector table.
    words.set(0x08000000, 0x20018000); words.set(0x08000004, 0x08000199);
    words.set(0x08000008, 0x080001a1); words.set(0x0800000c, 0x080001a5);
    // SRAM: text, counter, more text, a marker, and erased bytes.
    bytes(0x20000000, [
        ...ascii('Hello, Cortex-M!'), 0x2a, 0, 0, 0, ...ascii('UART2 ready\r\n'), 0, 0, 0,
        0xef, 0xbe, 0xad, 0xde, ...ascii('The quick brown fox jumps over. '), ...Array(8).fill(0xff),
    ]);
    // Exception frame of the HardFault scenario (at its MSP).
    [0x5fffffec, 0x20, 0, 0x20000010, 0, 0x08000303, 0x0800027a, 0x21000000]
        .forEach((w, i) => words.set(0x20017fa8 + 4 * i, w));
    // Peripherals.
    words.set(0x40023800, 0x03000083); words.set(0x40023830, 0x00000001);          // RCC CR, AHB1ENR
    words.set(0x40020000, 0xa8000400); words.set(0x40020010, 0x0000a020);          // GPIOA MODER, IDR
    words.set(0x40020014, 0x00000020);                                             // GPIOA ODR
    words.set(0x40020400, 0x00000280);                                             // GPIOB MODER
    words.set(0x40004400, 0x000000c0); words.set(0x40004408, 0x0000016d);          // USART2 SR, BRR
    words.set(0x4000440c, 0x0000200c);                                             // USART2 CR1
    // System control space and DWT.
    words.set(0xe000ed00, 0x410fc241); words.set(0xe000ed08, 0x08000000);          // CPUID, VTOR
    words.set(0xe0001000, 0x40000000); words.set(0xe0001004, 0x00a3c1f5);          // DWT_CTRL, CYCCNT
    return words;
}
const FAULT_WORDS = { 0xe000ed28: 0x00008200, 0xe000ed2c: 0x40000000, 0xe000ed30: 0x00000008, 0xe000ed34: 0x60000000, 0xe000ed38: 0x60000000 };

class FakeTarget {
    constructor(sc, spec, session) {
        this.sc = sc;
        this.spec = spec;
        this.session = session;
        this.state = 'stopped';
        this.at = null;
        this.queue = (spec.stops ?? []).map((s) => ({ ...s }));
        this.runningAt = spec.runningAt ?? 'delayLoop';
        this.failures = { ...(spec.failures ?? {}) };
        this.threadSet = THREAD_SETS[spec.threads ?? 'single'];
        this.words = baseMemory();
        for (const [a, v] of Object.entries(spec.memory ?? {})) { this.words.set(Number(a), v >>> 0); }
        this.hung = false;
        this.dead = false;
        this.tracker = null;
        this.seq = 1;
    }

    attachTracker() {
        const trackers = trackerFactories.map((f) => f.createDebugAdapterTracker(this.session)).filter(Boolean);
        for (const t of trackers) { t.onWillStartSession?.(); }
        this.tracker = {
            send: (m) => { for (const t of trackers) { t.onDidSendMessage?.({ seq: this.seq++, ...m }); } },
            willStop: () => { for (const t of trackers) { t.onWillStopSession?.(); } },
        };
    }

    focused() { return stub.debug.activeDebugSession === this.session; }

    /** VS Code's focused frame follows this session only while it is the active one. */
    setStackItem(item) {
        if (!this.focused()) { return; }
        stub.debug.activeStackItem = item;
        bus.didChangeStackItem.fire(item);
    }

    emit(event, body) {
        const shown = event === 'output'
            ? `[${body.category}] ${JSON.stringify(String(body.output).trim().split('\n')[0])}`
            : JSON.stringify(body);
        this.sc.record(`event: ${event} ${shown}`);
        this.tracker?.send({ type: 'event', event, body });
    }

    output(category, text) { this.emit('output', { category, output: text }); }

    stopAt(at, reason, threadId = 1) {
        if (this.dead) { return; }
        this.state = 'stopped';
        this.at = at;
        this.emit('stopped', { reason, threadId, allThreadsStopped: true });
        this.setStackItem({ session: this.session, threadId, frameId: 1000 });
    }

    run() {
        if (this.dead) { return; }
        this.state = 'running';
        this.at = null;
        this.emit('continued', { threadId: 1, allThreadsContinued: true });
        this.setStackItem(undefined);
    }

    /** Run the target the way an execution request would, taking the next scripted stop. */
    perform(command) {
        const idx = this.queue.findIndex((s) => s.on === command);
        const stop = idx === -1 ? null : this.queue.splice(idx, 1)[0];
        setTimeout(() => {
            this.run();
            if (stop) { setTimeout(() => this.stopAt(stop.at, stop.reason), stop.delayMs ?? 5); }
        }, 1);
    }

    /** Stop the running target after `delayMs`, as a breakpoint hit would. */
    scheduleStop(delayMs, at, reason) { setTimeout(() => this.stopAt(at, reason), delayMs); }

    // ── requests ──

    request(command, args) {
        const line = `dap: ${command} ${JSON.stringify(args ?? {})}`;
        if (this.dead) {
            const msg = `No debugger available, can not send '${command}'`;
            this.sc.record(`${line} -> error: ${msg}`);
            return Promise.reject(new Error(msg));
        }
        if (this.hung) {
            this.sc.record(`${line} -> no answer`);
            return new Promise(() => {});
        }
        // Logged before answering: events the adapter emits while it works come after the request.
        const log = this.sc.log;
        const at = log.length;
        log.push(line);
        let body;
        try {
            body = this.answer(command, args ?? {});
        } catch (err) {
            log[at] = `${line} -> error: ${JSON.stringify(err.message)}`;
            this.tracker?.send({ type: 'response', command, success: false, message: err.message, body: { error: { id: 1, format: err.message } } });
            return Promise.reject(new Error(err.message));
        }
        if (command === 'evaluate') { log[at] = `${line} -> ${JSON.stringify(body.result)}`; }
        if (command === 'readMemory' && body?.data) { log[at] = `${line} -> ${Buffer.from(body.data, 'base64').length} bytes`; }
        this.tracker?.send({ type: 'response', command, success: true, body });
        return Promise.resolve(body);
    }

    frames(threadId) {
        if (threadId === 1) { return LOCATIONS[this.at] ?? []; }
        return this.threadSet.find((t) => t.id === threadId)?.frames ?? null;
    }

    /** Frame handle → { threadId, level, frame }, valid only while stopped. */
    frameRef(handle) {
        if (this.state !== 'stopped' || typeof handle !== 'number') { return undefined; }
        const threadId = Math.floor((handle - 1000) / 100) + 1;
        const level = (handle - 1000) % 100;
        const frames = this.frames(threadId);
        return frames && level >= 0 && level < frames.length ? { threadId, level, frame: frames[level] } : undefined;
    }

    regs(level = 0) {
        const regs = { ...BASE_REGS, ...(REG_OVERRIDES[this.at] ?? {}) };
        regs.pc = LOCATIONS[this.at][level]?.addr ?? 0;
        regs.msp = regs.sp;
        return regs;
    }

    /** A register in GDB's natural format, per pyOCD's target description. */
    naturalRegister(name, regs) {
        const v = regs[name];
        if (v === undefined) { return { value: 'void', type: 'void' }; }
        if (name === 'pc') { return { value: symbolise(v), type: 'void (*)()' }; }
        if (name === 'lr' && this.spec.lrAsHex) { return { value: hex(v), type: 'void (*)()' }; }
        if (name === 'sp' || name === 'msp' || name === 'psp') { return { value: hex(v), type: 'void *' }; }
        return { value: String(v | 0), type: 'int' };
    }

    readable(addr) { return READABLE.some(([lo, hi]) => addr >= lo && addr < hi); }
    byteAt(addr) { return ((this.words.get((addr - (addr & 3)) >>> 0) ?? 0) >>> ((addr & 3) * 8)) & 0xff; }
    readBytes(addr, count) {
        const out = [];
        for (let i = 0; i < count; i++) {
            const a = (addr + i) >>> 0;
            if (!this.readable(a)) { return null; }
            out.push(this.byteAt(a));
        }
        return Buffer.from(out);
    }
    writeBytes(addr, buf) {
        for (let i = 0; i < buf.length; i++) {
            const a = (addr + i) >>> 0;
            const base = (a - (a & 3)) >>> 0;
            const shift = (a & 3) * 8;
            const w = this.words.get(base) ?? 0;
            this.words.set(base, ((w & ~(0xff << shift)) | (buf[i] << shift)) >>> 0);
        }
    }

    /** What GDB's -var-create would make of `expression` in `ref`'s frame, or null when it fails. */
    varCreate(expression, ref) {
        const fnName = ref.frame.fn;
        const reg = /^\$([a-z0-9_]+)$/i.exec(expression);
        if (reg) { return this.naturalRegister(reg[1], this.regs(ref.threadId === 1 ? ref.level : 0)); }
        const deref = /^\*\(unsigned int\s*\*\)\s*(0x[0-9a-f]+)$/i.exec(expression);
        if (deref) {
            const buf = this.readBytes(Number(deref[1]), 4);
            return { value: buf ? String(buf.readUInt32LE(0)) : '', type: 'unsigned int' };
        }
        const local = LOCALS[fnName]?.[expression];
        const entry = local ?? GLOBALS[expression];
        if (!entry) { return null; }
        return { value: entry[0], type: entry[1], children: entry[2] };
    }

    answer(command, args) {
        if (this.failures[command]) {
            if (['next', 'stepIn', 'stepOut'].includes(command)) {
                const req = { next: 'nextRequest', stepIn: 'stepInRequest', stepOut: 'stepOutRequest' }[command];
                this.output('console', `Error occurred during the ${req}: ${this.failures[command]}\n`);
            }
            throw new Error(this.failures[command]);
        }
        switch (command) {
            case 'threads':
                return { threads: this.threadSet.map((t) => ({ id: t.id, name: t.name, running: this.state !== 'stopped' })) };
            case 'stackTrace': {
                if (this.state !== 'stopped') { throw new Error(RUNNING_MSG); }
                const frames = this.frames(args.threadId);
                if (!frames) { throw new Error(`Invalid thread id: ${args.threadId}`); }
                const depth = frames.length;
                const levels = args.levels ? Math.min(args.levels, depth) : depth;
                const low = args.startFrame || 0;
                const base = 1000 + (args.threadId - 1) * 100;
                const stackFrames = frames.slice(low, low + levels).map((f, i) => {
                    const file = this.sc.sourcePath(f.file);
                    return {
                        id: base + low + i, name: f.fn,
                        ...(file ? { source: { name: path.basename(file), path: file, sourceReference: 0 } } : {}),
                        line: f.line, column: 0, instructionPointerReference: hex(f.addr),
                    };
                });
                return { stackFrames, totalFrames: depth };
            }
            case 'scopes':
                return {
                    scopes: [
                        { name: 'Local', variablesReference: 2000 + (args.frameId - 1000) * 2, expensive: false },
                        { name: 'Registers', variablesReference: 2001 + (args.frameId - 1000) * 2, expensive: true },
                    ],
                };
            case 'variables': {
                const r = args.variablesReference;
                if (r >= 3000) { return { variables: this.children(r) }; }
                const ref = this.frameRef(1000 + Math.floor((r - 2000) / 2));
                if (!ref) { return { variables: [] }; }
                if ((r - 2000) % 2 === 1) {
                    const regs = this.regs(ref.level);
                    return { variables: REGISTER_ORDER.map((n) => ({ name: n, evaluateName: `$${n}`, value: hex(regs[n]), variablesReference: 0 })) };
                }
                return {
                    variables: Object.entries(LOCALS[ref.frame.fn] ?? {}).map(([name, [value, type, kids]], i) => ({
                        name, evaluateName: name, value, type, variablesReference: kids ? 3000 + i * 100 + ref.level : 0,
                    })),
                };
            }
            case 'evaluate':
                return this.evaluate(args);
            case 'readMemory': {
                if (this.spec.noReadMemory) { throw new Error('unrecognized request'); }
                const addr = Number(args.memoryReference) + (args.offset ?? 0);
                if (this.state !== 'stopped') { throw new Error(`${RUNNING_MSG} (@ ${hex(addr)})`); }
                if (!args.count) { return undefined; }
                const buf = this.readBytes(addr, args.count);
                if (!buf) { throw new Error(`Unable to read memory. (@ ${hex(addr)})`); }
                return { data: buf.toString('base64'), address: hex(addr) };
            }
            case 'writeMemory': {
                if (this.state !== 'stopped') { throw new Error(RUNNING_MSG); }
                const addr = Number(args.memoryReference);
                const buf = Buffer.from(args.data, 'base64');
                if (!this.readBytes(addr, buf.length)) { throw new Error(`Could not write memory at ${hex(addr)}`); }
                this.writeBytes(addr, buf);
                return undefined;
            }
            case 'next': case 'stepIn': case 'stepOut': case 'continue':
                if (this.state !== 'stopped') { throw new Error(RUNNING_MSG); }
                this.perform(command);
                return command === 'continue' ? { allThreadsContinued: true } : undefined;
            case 'pause':
                if (this.state !== 'stopped') { setTimeout(() => this.stopAt(this.runningAt, 'SIGINT'), 5); }
                return undefined;
            default:
                throw new Error('unrecognized request');
        }
    }

    children(ref) {
        const level = ref % 100;
        const index = Math.floor((ref - 3000) / 100);
        const fn = LOCATIONS[this.at]?.[level]?.fn;
        const entry = Object.values(LOCALS[fn] ?? {})[index];
        return (entry?.[2] ?? []).map(([name, value, type]) => ({ name, evaluateName: name, value, type, variablesReference: 0 }));
    }

    evaluate(args) {
        const notEvaluated = { result: NOT_EVALUATED, variablesReference: 0 };
        const expression = String(args.expression).trim();
        const isCli = expression.startsWith('>') && args.context === 'repl';
        if (!isCli && args.frameId === undefined) { throw new Error('Evaluation of expression without frameId is not supported.'); }
        const ref = this.frameRef(args.frameId);
        if (!isCli && !ref) { return notEvaluated; }
        if (isCli) {
            // Console output goes to the Debug Console as stdout; the reply carries none of it.
            const cmd = expression.slice(1).trim();
            this.output('stdout', `(gdb) ${cmd}\n` + (cmd === 'info registers'
                ? REGISTER_ORDER.map((n) => `${n.padEnd(15)}${hex(this.regs(0)[n])}`).join('\n') + '\n'
                : ''));
            return { result: '\r', variablesReference: 0 };
        }
        const fmt = /,([a-z])$/i.exec(expression);
        const base = fmt ? expression.slice(0, -2).trim() : expression;
        if (fmt && !'xdotbz'.includes(fmt[1])) { throw new Error('Unknown expression format specifier, supported specifiers are: x, d, o, b, t, z'); }
        const v = this.varCreate(base, ref);
        if (!v) { return notEvaluated; }
        let result = v.value;
        if (fmt && fmt[1] === 'x' && /^-?\d+$/.test(v.value)) { result = hex(Number(v.value)); }
        const kids = v.children?.length ?? 0;
        return { result, type: v.type, variablesReference: kids ? 3900 : 0 };
    }
}

// ── Scenario context ───────────────────────────────────────────────────────

function sessionConfig(env, kind) {
    const project = env.project;
    const common = {
        type: 'gdbtarget',
        cwd: project,
        program: path.join(project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug', 'Blinky.elf'),
        gdb: 'arm-none-eabi-gdb',
        cmsis: { cbuildRunFile: env.cbuildRun },
    };
    switch (kind) {
        case 'pyocd':
            return { ...common, name: 'CMSIS Debugger: pyOCD', request: 'launch', initCommands: ['load', 'break main'],
                target: { server: 'pyocd', port: '3333' } };
        case 'pyocd-attach':
            return { ...common, name: 'CMSIS Debugger: pyOCD (attach)', request: 'attach',
                target: { server: 'pyocd', port: '3333' } };
        case 'jlink':
            return { ...common, name: 'CMSIS Debugger: J-LINK', request: 'launch', initCommands: ['load', 'break main'],
                target: { server: 'JLinkGDBServer', serverParameters: ['-device', 'STM32F401RE', '-endian', 'little',
                    '-if', 'SWD', '-speed', 'auto', '-noir', '-vd', '-nogui', '-localhostonly', '-port', '3333'], port: '3333' } };
        default:
            throw new Error(`unknown session kind ${kind}`);
    }
}

const DEFAULT_COMMANDS = {
    'cmsis-csolution.getSolutionFile': (sc) => path.join(sc.env.project, 'Blinky.csolution.yml'),
    'cmsis-csolution.getActiveTargetSet': () => 'NUCLEO-F401RE',
    'cmsis-csolution.getPackRootPath': (sc) => sc.env.packRoot,
    'workbench.action.debug.restart': (sc) => sc.restartSession(),
};

class ScenarioContext {
    constructor(def, index, env) {
        this.def = def;
        this.index = index;
        this.env = env;
        this.log = [];
        this.targets = [];
        this.sessionCount = 0;
        this.commands = { ...DEFAULT_COMMANDS, ...(def.commands ?? {}) };
    }

    record(line) { this.log.push(line); }

    sourcePath(file) {
        if (!file) { return null; }
        if (file.startsWith('@packs/')) { return path.join(this.env.packRoot, file.slice(7)); }
        return path.join(this.env.project, file);
    }

    get target() { return this.targets[this.targets.length - 1]; }

    /** Bring a fake session up the way VS Code would; `spec.initial` is a stop, 'running', or nothing. */
    launch(spec) {
        const config = sessionConfig(this.env, spec.config ?? 'pyocd');
        const session = {
            id: `scenario-${this.index + 1}-session-${++this.sessionCount}`,
            type: config.type,
            name: config.name,
            configuration: config,
            workspaceFolder: stub.workspace.workspaceFolders[0],
            customRequest: (command, args) => target.request(command, args),
            getDebugProtocolBreakpoint: async () => undefined,
        };
        const target = new FakeTarget(this, spec, session);
        this.targets.push(target);
        target.attachTracker();
        if (!spec.focusElsewhere) {
            stub.debug.activeDebugSession = session;
            bus.didChangeActiveSession.fire(session);
        }
        bus.didStart.fire(session);
        // cdt-gdb-adapter prints this at configurationDone, which a failed launch never reaches.
        if (spec.banner !== false) { target.output('console', GDB_BANNER); }
        if (spec.initial === 'running') {
            target.stopAt('main31', 'breakpoint');
            target.run();
        } else if (spec.initial) {
            target.stopAt(spec.initial.at, spec.initial.reason);
        }
        if (spec.hangAfterStart) { target.hung = true; }
        return session;
    }

    /** vscode.debug.startDebugging: the scenario's `launches` say what each configuration does. */
    startDebugging(name) {
        const plan = this.def.launches?.[name];
        if (!plan) { return false; }
        if (plan.fail) {
            const session = this.launch({ config: plan.config, banner: false });
            const target = this.target;
            for (const [category, text] of plan.fail.output) { target.output(category, text); }
            this.record(`adapter: response launch -> error: ${JSON.stringify(plan.fail.message)}`);
            target.tracker.send({ type: 'response', command: 'launch', success: false, message: plan.fail.message });
            target.emit('terminated', {});
            this.endSession(session, { quiet: true });
            return false;
        }
        this.launch(plan);
        return true;
    }

    /** workbench.action.debug.restart: tear the adapter down and relaunch it in the same session. */
    restartSession() {
        const target = this.target;
        if (!target || target.dead) { return undefined; }
        this.record('adapter: restart — adapter relaunched in the same session; it stops at main 500 ms later');
        target.tracker.willStop();
        target.setStackItem(undefined);
        target.state = 'starting';
        target.at = null;
        target.attachTracker();
        target.output('console', GDB_BANNER);
        setTimeout(() => target.stopAt('main31', 'breakpoint'), 500);
        return undefined;
    }

    endSession(session, { quiet = false } = {}) {
        const target = this.targets.find((t) => t.session === session);
        if (!target || target.dead) { return; }
        target.tracker.willStop();
        if (!quiet) { target.emit('terminated', {}); }
        target.dead = true;
        if (stub.debug.activeDebugSession === session) {
            stub.debug.activeDebugSession = undefined;
            stub.debug.activeStackItem = undefined;
            bus.didChangeActiveSession.fire(undefined);
        }
        bus.didTerminate.fire(session);
    }

    /** Resolve '@file' arguments to project paths. */
    resolveArgs(args) {
        const out = {};
        for (const [k, v] of Object.entries(args)) {
            out[k] = typeof v === 'string' && v.startsWith('@') ? path.join(this.env.project, v.slice(1)) : v;
        }
        return out;
    }

    teardown() {
        for (const t of this.targets) {
            if (!t.dead) {
                const recording = this.log;
                this.log = [];
                this.endSession(t.session);
                this.log = recording;
            }
        }
    }
}

// ── Scenarios ──────────────────────────────────────────────────────────────

const RUNNING_RACE = { next: RUNNING_MSG };

const SCENARIOS = [
    {
        name: 'status-halted',
        description: 'pyOCD launch halted at a breakpoint in main: status, connection probe, device info.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'get_device_info' },
        ],
    },
    {
        name: 'call-stack-and-threads',
        description: 'RTX5 target with three threads, halted in led_toggle: call stacks (default, levels, other thread, deep thread) and thread list.',
        session: { initial: { at: 'ledToggle18', reason: 'breakpoint' }, threads: 'rtx' },
        calls: [
            { tool: 'get_call_stack' },
            { tool: 'get_call_stack', args: { levels: 1 } },
            { tool: 'get_call_stack', args: { threadId: 2 } },
            { tool: 'get_call_stack', args: { threadId: 3 } },
            { tool: 'get_call_stack', args: { threadId: 9 } },
            { tool: 'get_threads' },
        ],
    },
    {
        name: 'variables',
        description: 'Halted in led_toggle (caller main has a struct, arrays and secret-named locals): the adapter has Local and Registers scopes only.',
        session: { initial: { at: 'ledToggle18', reason: 'breakpoint' } },
        calls: [
            { tool: 'list_variable_names' },
            { tool: 'list_variable_names', args: { scope: 'local' } },
            { tool: 'get_variables_values' },
            { tool: 'get_variables_values', args: { variableNames: ['mask', 'counter'] } },
            { tool: 'get_variables_values', args: { variableNames: ['counter'] } },
            { tool: 'get_variables_values', args: { scope: 'global' } },
            { tool: 'get_frame_variables', args: { frameId: 1001 } },
            { tool: 'get_frame_variables', args: { frameId: 1001, variableNames: ['config', 'password', 'api_key'] } },
            { tool: 'get_frame_variables', args: { frameId: 1001, scope: 'local', variableNames: ['nosuch'] } },
            { tool: 'get_frame_variables', args: { frameId: 1077 } },
        ],
    },
    {
        name: 'evaluate',
        description: 'Halted in main: symbols, arithmetic, format suffix, struct, secret-named pointer and array, unknown symbol, and GDB passthrough both ways (-exec is evaluated as an expression, > is a CLI command whose output goes to the console only).',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'evaluate_expression', args: { expression: 'SystemCoreClock' } },
            { tool: 'evaluate_expression', args: { expression: 'counter * 2' } },
            { tool: 'evaluate_expression', args: { expression: 'counter,x' } },
            { tool: 'evaluate_expression', args: { expression: 'config' } },
            { tool: 'evaluate_expression', args: { expression: 'password' } },
            { tool: 'evaluate_expression', args: { expression: 'api_key' } },
            { tool: 'evaluate_expression', args: { expression: 'nosuch_symbol' } },
            { tool: 'evaluate_expression', args: { expression: '-exec info registers' } },
            { tool: 'evaluate_expression', args: { expression: '>info registers' } },
            { tool: 'evaluate_expression', args: { expression: '$pc' } },
        ],
    },
    {
        name: 'read-memory',
        description: 'Halted: DAP readMemory in hex / ascii / both, an address without 0x, and an unmapped address where readMemory fails and every GDB fallback fails too.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_memory', args: { address: '0x20000000', length: 16 } },
            { tool: 'read_memory', args: { address: '20000000', length: 20, format: 'ascii' } },
            { tool: 'read_memory', args: { address: '0x20000000', length: 70, format: 'both' } },
            { tool: 'read_memory', args: { address: '0x60000000', length: 8 } },
        ],
    },
    {
        name: 'read-memory-gdb-fallback',
        description: 'An adapter without readMemory ("unrecognized request"): the executor falls back to one watch-context evaluate per word and trims to the length.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, noReadMemory: true },
        calls: [
            { tool: 'read_memory', args: { address: '0x20000010', length: 6, format: 'both' } },
        ],
    },
    {
        name: 'core-registers',
        description: 'Halted in main: every core register through a watch-context $reg evaluate.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_core_registers' },
        ],
    },
    {
        name: 'peripheral-registers',
        description: 'Halted; the SVD comes from the session\'s cbuild-run file (${CMSIS_PACK_ROOT} expanded): one register with fields, a whole (derived) peripheral, unknown names, and the target-free lookups through the same SVD.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_peripheral_register', args: { peripheral: 'RCC', register: 'CR' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'usart2', register: 'sr' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'GPIOB' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'RCC', register: 'CRX' } },
            { tool: 'read_peripheral_register', args: { peripheral: 'UART2' } },
            { tool: 'lookup_register', args: { peripheral: 'USART2', register: 'CR1' } },
            { tool: 'lookup_peripheral', args: { address: '0x40004404' } },
        ],
    },
    {
        name: 'cycle-counter',
        description: 'Halted, trace disabled: the first read enables DEMCR.TRCENA and CYCCNTENA (write + read-back), the second finds them on.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'read_cycle_counter' },
            { tool: 'read_cycle_counter' },
        ],
    },
    {
        name: 'cycle-counter-absent',
        description: 'A core whose DWT_CTRL reports NOCYCCNT.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, memory: { 0xe0001000: 0x10000000, 0xe000edfc: 0x01000000 } },
        calls: [
            { tool: 'read_cycle_counter' },
        ],
    },
    {
        name: 'fault-hardfault',
        description: 'Precise bus fault escalated to HardFault (CFSR=0x00008200, BFAR=0x60000000), halted by vector catch (SIGSEGV). LR reads "-7" as GDB prints an int register.',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'get_call_stack' },
            { tool: 'get_fault_info' },
            { tool: 'diagnose_fault' },
            { tool: 'read_core_registers' },
        ],
    },
    {
        name: 'fault-diagnose-lr-hex',
        description: 'Same fault, but the adapter reports LR as a hex code pointer, so diagnose_fault reads the stacked exception frame at MSP.',
        session: { initial: { at: 'hardFault', reason: 'SIGSEGV' }, memory: FAULT_WORDS, lrAsHex: true },
        calls: [
            { tool: 'diagnose_fault', args: { levels: 4 } },
        ],
    },
    {
        name: 'execution-steps',
        description: 'Step into led_toggle, over, out, over, continue to the breakpoint; then wait_for_stop and pause_execution on the stopped target.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            stops: [
                { on: 'stepIn', at: 'ledToggle17', reason: 'step' },
                { on: 'next', at: 'ledToggle18', reason: 'step' },
                { on: 'stepOut', at: 'main32', reason: 'step' },
                { on: 'next', at: 'main29', reason: 'step' },
                { on: 'continue', at: 'main31', reason: 'breakpoint', delayMs: 50 },
            ],
        },
        calls: [
            { tool: 'step_into' },
            { tool: 'step_over' },
            { tool: 'step_out' },
            { tool: 'step_over' },
            { tool: 'continue_execution' },
            { tool: 'wait_for_stop' },
            { tool: 'pause_execution' },
        ],
    },
    {
        name: 'step-ui-fallback',
        description: 'The tracker says stopped but the adapter rejects `next` with GDB\'s running-target error: the executor falls back to the UI command, which (sent by VS Code) steps.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            failures: RUNNING_RACE,
            stops: [{ on: 'ui:next', at: 'main32', reason: 'step' }],
        },
        commands: {
            'workbench.action.debug.stepOver': (sc) => {
                sc.record('adapter: next (sent by the VS Code UI, succeeds)');
                sc.target.perform('ui:next');
            },
        },
        calls: [
            { tool: 'step_over' },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'continue-timeout-recovery',
        description: 'continue_execution with timeoutMs 600 and no breakpoint on the path: timeout, then the recovery pause stops in delay_ms and reports PC/LR.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, runningAt: 'delayLoop' },
        calls: [
            { tool: 'continue_execution', args: { timeoutMs: 600 } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'running-target',
        description: 'Target running (continued event seen): inspection is refused (as text or as an error), then pause_execution halts it in delay_ms and inspection works.',
        session: { initial: 'running', runningAt: 'delayLoop' },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'read_memory', args: { address: '0x20000000', length: 16 } },
            { tool: 'get_variables_values' },
            { tool: 'evaluate_expression', args: { expression: 'counter' } },
            { tool: 'get_call_stack' },
            { tool: 'step_over' },
            { tool: 'wait_for_stop', args: { timeoutMs: 100 } },
            { tool: 'pause_execution' },
            { tool: 'read_memory', args: { address: '0x20000010', length: 4 } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'wait-for-stop',
        description: 'Running target that hits a breakpoint 500 ms into wait_for_stop; a second wait_for_stop finds it already stopped.',
        session: { initial: 'running' },
        calls: [
            { tool: 'wait_for_stop', args: { timeoutMs: 5000 }, before: (sc) => sc.target.scheduleStop(500, 'main31', 'breakpoint') },
            { tool: 'wait_for_stop' },
        ],
    },
    {
        name: 'wait-for-stop-timeout',
        description: 'Running target that never stops: wait_for_stop with timeoutMs 2000 (budget 500 ms) times out.',
        session: { initial: 'running' },
        calls: [
            { tool: 'wait_for_stop', args: { timeoutMs: 2000 } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'breakpoints',
        description: 'Halted in main: breakpoints and logpoints go to the VS Code model and to GDB as -exec break/dprintf/clear/delete (answered as a failed expression), then steps show the breakpoint list diff.',
        session: {
            initial: { at: 'main31', reason: 'breakpoint' },
            stops: [{ on: 'next', at: 'main32', reason: 'step' }, { on: 'next', at: 'main29', reason: 'step' }],
        },
        calls: [
            { tool: 'list_breakpoints' },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 29 } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', line: 30, condition: 'counter > 10' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', lineContent: 'counter' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c', lineContent: 'no such text' } },
            { tool: 'add_breakpoint', args: { fileFullPath: '@main.c' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 32, logMessage: 'counter={counter} led={ledState:%u} 100%' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 33, logMessage: 'tick', condition: 'counter % 100 == 0' } },
            { tool: 'add_logpoint', args: { fileFullPath: '@main.c', line: 34, logMessage: 'broken {counter' } },
            { tool: 'list_breakpoints' },
            { tool: 'step_over' },
            { tool: 'step_over' },
            { tool: 'remove_breakpoint', args: { fileFullPath: '@main.c', line: 29 } },
            { tool: 'remove_breakpoint', args: { fileFullPath: '@main.c', line: 99 } },
            { tool: 'clear_all_breakpoints' },
            { tool: 'list_breakpoints' },
        ],
    },
    {
        name: 'reset-verified',
        description: 'pyOCD, halted at Reset_Handler: `monitor reset halt system` never reaches GDB (no stopped event), but PC already equals the reset vector, so the reset reads as verified.',
        session: { initial: { at: 'resetHandler', reason: 'breakpoint' } },
        calls: [
            { tool: 'reset', args: { method: 'system' } },
        ],
    },
    {
        name: 'reset-not-verified-jlink',
        description: 'J-Link, target running, reset with halt=false and the default auto method: pause first, then system/core/hardware, none verified.',
        session: { config: 'jlink', initial: 'running', runningAt: 'delayLoop' },
        calls: [
            { tool: 'reset', args: { halt: false } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'restart-and-stop',
        description: 'restart_debugging relaunches the adapter in the same session (the stop at main lands 500 ms after the command), then stop_debugging ends it.',
        session: { initial: { at: 'main31', reason: 'breakpoint' } },
        calls: [
            { tool: 'restart_debugging', settleMs: 800 },
            { tool: 'get_session_status' },
            { tool: 'stop_debugging' },
            { tool: 'get_session_status' },
            { tool: 'stop_debugging' },
        ],
    },
    {
        name: 'start-debugging',
        description: 'No session: start_debugging by configuration name launches one that halts at main; a second start is refused.',
        launches: { 'CMSIS Debugger: pyOCD': { config: 'pyocd', initial: { at: 'main31', reason: 'breakpoint' } } },
        calls: [
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'start-debugging-fails',
        description: 'No probe: the launch fails in the adapter and startDebugging resolves false; the reply carries the recent adapter traffic.',
        launches: {
            'CMSIS Debugger: pyOCD': {
                config: 'pyocd',
                fail: {
                    output: [['stderr', '0000410 C No connected debug probes [__main__]\n']],
                    message: 'Failed to launch the GDB server: pyocd exited with code 1',
                },
            },
        },
        calls: [
            { tool: 'start_debugging', args: { workingDirectory: '@', configurationName: 'CMSIS Debugger: pyOCD' } },
            { tool: 'start_debugging', args: { workingDirectory: '/elsewhere', configurationName: 'Nope' } },
            { tool: 'get_session_status' },
        ],
    },
    {
        name: 'unresponsive-adapter',
        description: 'Session halted, then every DAP request hangs: status and connection probes time out, a fenced read_memory returns the handler cap (its background probes are recorded as late traffic), pause is refused, stop works.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, hangAfterStart: true },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'check_target_connection' },
            { tool: 'read_memory', args: { address: '0x20000000', length: 16, timeoutMs: 1000 }, settleMs: 6500 },
            { tool: 'pause_execution' },
            { tool: 'stop_debugging' },
        ],
    },
    {
        name: 'focus-elsewhere',
        description: 'The session is tracked but not VS Code\'s active session (focus on another session): tools resolve it through the tracker, the SVD lookup and the active stack frame do not.',
        session: { initial: { at: 'main31', reason: 'breakpoint' }, focusElsewhere: true },
        calls: [
            { tool: 'get_session_status' },
            { tool: 'get_device_info' },
            { tool: 'read_peripheral_register', args: { peripheral: 'RCC', register: 'CR' } },
            { tool: 'evaluate_expression', args: { expression: 'counter' } },
            { tool: 'read_memory', args: { address: '0x20000000', length: 4 } },
        ],
    },
    {
        name: 'cmsis-build',
        description: 'No session: cmsis_action build waits for the cbuild task and reports its exit code (0, then 2).',
        commands: {
            'cmsis-csolution.build': (sc) => {
                const exitCode = (sc.builds = (sc.builds ?? 0) + 1) === 1 ? 0 : 2;
                const task = { name: 'cbuild Blinky.csolution.yml', source: 'CMSIS Solution', definition: { type: 'cmsis-csolution.build' } };
                setTimeout(() => {
                    sc.record(`task: start ${JSON.stringify(task.name)}`);
                    bus.taskStart.fire({ execution: { task } });
                    setTimeout(() => {
                        sc.record(`task: end ${JSON.stringify(task.name)} exitCode=${exitCode}`);
                        bus.taskEnd.fire({ execution: { task }, exitCode });
                    }, 20);
                }, 20);
            },
        },
        calls: [
            { tool: 'cmsis_action', args: { action: 'build' } },
            { tool: 'cmsis_action', args: { action: 'build' } },
        ],
    },
    {
        name: 'cmsis-attach',
        description: 'No session: cmsis_action attach starts a running pyOCD attach session that survives both probes; with it active, load_and_debug and flash are refused.',
        commands: {
            'cmsis-csolution.cmsisAttachDebugger': (sc) => { sc.launch({ config: 'pyocd-attach', initial: 'running' }); },
        },
        calls: [
            { tool: 'cmsis_action', args: { action: 'attach' } },
            { tool: 'get_device_info' },
            { tool: 'cmsis_action', args: { action: 'load_and_debug' } },
            { tool: 'flash', args: {} },
            { tool: 'stop_debugging' },
        ],
    },
];

// ── Workspace on disk ──────────────────────────────────────────────────────

const MAIN_C = `/* Blinky for NUCLEO-F401RE: toggles LD2 every period_ms */
#include <stdbool.h>
#include <stdint.h>
#include "led.h"

#define WIFI_PASSWORD "hunter2"

volatile uint32_t counter = 0;
extern uint32_t SystemCoreClock;

typedef struct {
    uint32_t period_ms;
    uint8_t  pin;
} led_config_t;

static void delay_ms(uint32_t ms) {
    for (volatile uint32_t i = 0; i < ms * 1000u; i++) {
        __asm volatile ("nop");
    }
}
int main(void) {
    led_config_t config = { .period_ms = 500u, .pin = 5u };
    bool ledState = false;
    char buffer[16] = "Hello, Cortex-M!";
    const char *password = WIFI_PASSWORD;
    char api_key[16] = "AK-7f3a9c21e0b4";
    led_init(config.pin);
    while (1) {
        counter++;
        ledState = !ledState;
        led_toggle();
        delay_ms(config.period_ms);
    }
}
`;

const LED_C = `/* LED driver for LD2 (PA5) */
#include <stdint.h>
#include "led.h"

typedef struct {
    volatile uint32_t MODER, OTYPER, OSPEEDR, PUPDR, IDR, ODR;
} gpio_t;

static gpio_t *led_port = (gpio_t *)0x40020000u;
static uint8_t led_pin;

void led_init(uint8_t pin) {
    led_pin = pin;
}

void led_toggle(void) {
    uint32_t mask = 1u << led_pin;
    led_port->ODR ^= mask;
}
`;

const FIELD = (name, description, offset, width, access) =>
    `<field><name>${name}</name><description>${description}</description><bitOffset>${offset}</bitOffset>` +
    `<bitWidth>${width}</bitWidth>${access ? `<access>${access}</access>` : ''}</field>`;
const REGISTER = (name, description, offset, reset, access, fields) =>
    `<register><name>${name}</name><description>${description}</description><addressOffset>${offset}</addressOffset>` +
    `<size>0x20</size><access>${access}</access><resetValue>${reset}</resetValue>` +
    `${fields.length ? `<fields>${fields.join('')}</fields>` : ''}</register>`;
const BLOCK = '<addressBlock><offset>0x0</offset><size>0x400</size><usage>registers</usage></addressBlock>';

// A subset of an STM32F401, written for this oracle.
const SVD = `<?xml version="1.0" encoding="utf-8"?>
<device schemaVersion="1.3" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance">
  <vendor>STMicroelectronics</vendor>
  <name>STM32F401</name>
  <version>1.0</version>
  <description>STM32F401 subset for the DAP scenario oracle</description>
  <cpu><name>CM4</name><revision>r0p1</revision><endian>little</endian><mpuPresent>true</mpuPresent><fpuPresent>true</fpuPresent><nvicPrioBits>4</nvicPrioBits><vendorSystickConfig>false</vendorSystickConfig></cpu>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <size>32</size>
  <resetValue>0x0</resetValue>
  <resetMask>0xFFFFFFFF</resetMask>
  <peripherals>
    <peripheral>
      <name>GPIOA</name>
      <description>General-purpose I/Os</description>
      <groupName>GPIO</groupName>
      <baseAddress>0x40020000</baseAddress>
      ${BLOCK}
      <registers>
        ${REGISTER('MODER', 'GPIO port mode register', '0x00', '0xA8000000', 'read-write', [
            FIELD('MODER5', 'Port x configuration bits (y = 5)', 10, 2), FIELD('MODER2', 'Port x configuration bits (y = 2)', 4, 2)])}
        ${REGISTER('IDR', 'GPIO port input data register', '0x10', '0x00000000', 'read-only', [
            FIELD('IDR13', 'Port input data (y = 13)', 13, 1)])}
        ${REGISTER('ODR', 'GPIO port output data register', '0x14', '0x00000000', 'read-write', [
            FIELD('ODR5', 'Port output data (y = 5)', 5, 1)])}
      </registers>
    </peripheral>
    <peripheral derivedFrom="GPIOA">
      <name>GPIOB</name>
      <baseAddress>0x40020400</baseAddress>
    </peripheral>
    <peripheral>
      <name>RCC</name>
      <description>Reset and clock control</description>
      <groupName>RCC</groupName>
      <baseAddress>0x40023800</baseAddress>
      ${BLOCK}
      <registers>
        ${REGISTER('CR', 'clock control register', '0x00', '0x00000083', 'read-write', [
            FIELD('HSION', 'Internal high-speed clock enable', 0, 1),
            FIELD('HSIRDY', 'Internal high-speed clock ready flag', 1, 1, 'read-only'),
            FIELD('HSEON', 'HSE clock enable', 16, 1),
            FIELD('PLLON', 'Main PLL (PLL) enable', 24, 1),
            FIELD('PLLRDY', 'Main PLL (PLL) clock ready flag', 25, 1, 'read-only')])}
        ${REGISTER('AHB1ENR', 'AHB1 peripheral clock enable register', '0x30', '0x00000000', 'read-write', [
            FIELD('GPIOAEN', 'IO port A clock enable', 0, 1), FIELD('GPIOBEN', 'IO port B clock enable', 1, 1),
            FIELD('DMA1EN', 'DMA1 clock enable', 21, 1)])}
      </registers>
    </peripheral>
    <peripheral>
      <name>USART2</name>
      <description>Universal synchronous asynchronous receiver transmitter</description>
      <groupName>USART</groupName>
      <baseAddress>0x40004400</baseAddress>
      ${BLOCK}
      <interrupt><name>USART2</name><description>USART2 global interrupt</description><value>38</value></interrupt>
      <registers>
        ${REGISTER('SR', 'Status register', '0x00', '0x00C00000', 'read-write', [
            FIELD('RXNE', 'Read data register not empty', 5, 1), FIELD('TC', 'Transmission complete', 6, 1),
            FIELD('TXE', 'Transmit data register empty', 7, 1, 'read-only')])}
        ${REGISTER('DR', 'Data register', '0x04', '0x00000000', 'read-write', [FIELD('DR', 'Data value', 0, 9)])}
        ${REGISTER('BRR', 'Baud rate register', '0x08', '0x00000000', 'read-write', [
            FIELD('DIV_Mantissa', 'mantissa of USARTDIV', 4, 12), FIELD('DIV_Fraction', 'fraction of USARTDIV', 0, 4)])}
        ${REGISTER('CR1', 'Control register 1', '0x0C', '0x00000000', 'read-write', [
            FIELD('RE', 'Receiver enable', 2, 1), FIELD('TE', 'Transmitter enable', 3, 1), FIELD('UE', 'USART enable', 13, 1)])}
      </registers>
    </peripheral>
  </peripherals>
</device>
`;

function writeWorkspace(tmp) {
    const project = path.join(tmp, 'project');
    const packRoot = path.join(tmp, 'packs');
    const svdRel = 'Keil/STM32F4xx_DFP/2.17.1/CMSIS/SVD/STM32F401x.svd';
    fs.mkdirSync(path.join(project, 'out', 'Blinky', 'NUCLEO-F401RE', 'Debug'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(packRoot, svdRel)), { recursive: true });
    fs.writeFileSync(path.join(project, 'main.c'), MAIN_C);
    fs.writeFileSync(path.join(project, 'led.c'), LED_C);
    fs.writeFileSync(path.join(project, 'Blinky.csolution.yml'),
        'solution:\n  target-types:\n    - type: NUCLEO-F401RE\n      board: STMicroelectronics::NUCLEO-F401RE\n' +
        '  build-types:\n    - type: Debug\n  projects:\n    - project: Blinky.cproject.yml\n');
    fs.writeFileSync(path.join(packRoot, svdRel), SVD);
    const cbuildRun = path.join(project, 'out', 'Blinky+NUCLEO-F401RE.cbuild-run.yml');
    fs.writeFileSync(cbuildRun, [
        'cbuild-run:',
        '  generated-by: csolution version 2.9.0',
        '  solution: ../Blinky.csolution.yml',
        '  target-type: NUCLEO-F401RE',
        '  compiler: GCC',
        '  device: STMicroelectronics::STM32F401RETx',
        '  device-pack: Keil::STM32F4xx_DFP@2.17.1',
        '  output:',
        '    - file: Blinky/NUCLEO-F401RE/Debug/Blinky.elf',
        '      info: generate by Blinky.Debug+NUCLEO-F401RE',
        '      type: elf',
        '  system-descriptions:',
        `    - file: \${CMSIS_PACK_ROOT}/${svdRel}`,
        '      type: svd',
        '  debugger:',
        '    name: CMSIS-DAP@pyOCD',
        '    protocol: swd',
        '    clock: 10000000',
        '',
    ].join('\n'));
    return { tmp, project, packRoot, cbuildRun };
}

// ── MCP client ─────────────────────────────────────────────────────────────

function request(port, method, sid, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : undefined;
        const req = http.request({
            host: '127.0.0.1', port, path: '/mcp', method, agent: false,
            headers: {
                'Host': `127.0.0.1:${port}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(sid ? { 'mcp-session-id': sid } : {}),
            },
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (payload) { req.write(payload); }
        req.end();
    });
}

function parseSse(text) {
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : text);
}

async function connect(port) {
    const init = await request(port, 'POST', undefined, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dap-scenarios', version: '1.0.0' } },
    });
    const sid = init.headers['mcp-session-id'];
    await request(port, 'POST', sid, { jsonrpc: '2.0', method: 'notifications/initialized' });
    let id = 2;
    return {
        call: (name, args) => request(port, 'POST', sid, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })
            .then((r) => parseSse(r.body)),
        close: () => request(port, 'DELETE', sid),
    };
}

// ── Recording ──────────────────────────────────────────────────────────────

/** Replace host-, time- and run-dependent fragments so two runs compare equal. */
function normalise(text, ctx) {
    let t = String(text);
    for (const [from, to] of ctx.paths) { t = t.split(from).join(to); }
    return t
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
        .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<n>$2')
        .replace(/\b127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
}

function normalisePaths(text, ctx) {
    let t = String(text);
    for (const [from, to] of ctx.paths) { t = t.split(from).join(to); }
    return t;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout(promise, ms) {
    let timer;
    const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
    try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

async function runScenario(def, index, env, ctx, DebugMCPServer) {
    const sc = new ScenarioContext(def, index, env);
    current = sc;
    stub.debug.breakpoints = [];
    stub.debug.activeDebugSession = undefined;
    stub.debug.activeStackItem = undefined;

    const server = new DebugMCPServer(0, 30);
    await server.initialize();
    await server.start();
    const client = await connect(server.getActualPort());

    if (def.session) { sc.launch(def.session); }
    const setup = sc.log.splice(0).map((l) => normalisePaths(l, ctx));

    // A call's traffic is everything logged since the previous call's slice
    // ended; with settleMs, what arrives during the settle is its late traffic.
    const calls = [];
    let consumed = 0;
    for (const call of def.calls) {
        const args = sc.resolveArgs(call.args ?? {});
        call.before?.(sc);
        const res = await withTimeout(client.call(call.tool, args), CALL_TIMEOUT_MS);
        const replied = sc.log.length;
        const traffic = sc.log.slice(consumed, replied);
        let late = [];
        if (call.settleMs) {
            await sleep(call.settleMs);
            late = sc.log.slice(replied);
        }
        consumed = sc.log.length;
        const entry = { tool: call.tool, args: JSON.parse(normalisePaths(JSON.stringify(args), ctx)) };
        if (res.timedOut) {
            entry.timedOut = true;
        } else {
            const r = res.result ?? {};
            const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `<${c.type}>`)).join('\n');
            if (res.error) { entry.rpcError = normalise(res.error.message, ctx); }
            if (r.isError) { entry.isError = true; }
            // The get_session_status trailer counts this session's calls and
            // bytes; it is metrics, not debugging behaviour, and would repeat
            // every earlier reply's size change.
            entry.text = normalise(text.replace(/\n*Tool stats \(([^)]*)\):[\s\S]*$/, '\n\nTool stats ($1): <trailer>'), ctx);
        }
        entry.traffic = traffic.map((l) => normalisePaths(l, ctx));
        if (late.length) { entry.lateTraffic = late.map((l) => normalisePaths(l, ctx)); }
        calls.push(entry);
    }

    await client.close();
    await server.stop();
    sc.teardown();
    current = null;
    return { name: def.name, description: def.description, ...(setup.length ? { setup } : {}), calls };
}

async function main() {
    const update = process.argv.includes('--update');
    const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
    const started = Date.now();

    const { DebugMCPServer } = require(path.join(OUT, 'debugMCPServer.js'));
    const { registerSessionStateTracker } = require(path.join(OUT, 'utils', 'sessionStateTracker.js'));
    // What activate() does first: the DAP stopped/continued tracker.
    registerSessionStateTracker({ subscriptions: [] });

    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cda-dap-')));
    const env = writeWorkspace(tmp);
    const ctx = { paths: [[tmp, '<tmp>'], [path.resolve(__dirname, '..', '..'), '<repo>']] };
    stub.workspace.workspaceFolders = [{ uri: stub.Uri.file(env.project), name: 'Blinky', index: 0 }];
    stub.workspace.name = 'Blinky';

    const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
    if (only && selected.length === 0) {
        console.error(`no scenario named ${only}; known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
        process.exit(2);
    }
    const scenarios = [];
    for (const def of selected) {
        scenarios.push(await runScenario(def, SCENARIOS.indexOf(def), env, ctx, DebugMCPServer));
    }
    fs.rmSync(tmp, { recursive: true, force: true });

    const requests = scenarios.reduce((n, s) => n + s.calls.reduce((m, c) =>
        m + [...c.traffic, ...(c.lateTraffic ?? [])].filter((l) => l.startsWith('dap: ')).length, 0), 0);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const actual = JSON.stringify({ format: 1, scenarios }, null, 2) + '\n';
    if (only) {
        process.stdout.write(actual);
        console.error(`${scenarios.length} scenario, ${requests} DAP requests, ${seconds} s`);
        process.exit(0);
    }
    if (update || !fs.existsSync(SNAPSHOT)) {
        fs.writeFileSync(SNAPSHOT, actual);
        console.log(`snapshot written: ${path.relative(process.cwd(), SNAPSHOT)} ` +
            `(${scenarios.length} scenarios, ${requests} DAP requests, ${Buffer.byteLength(actual)} bytes, ${seconds} s)`);
        process.exit(0);
    }
    const expected = fs.readFileSync(SNAPSHOT, 'utf8');
    if (expected === actual) {
        console.log(`DAP scenarios identical to the snapshot (${scenarios.length} scenarios, ${requests} DAP requests, ${seconds} s)`);
        process.exit(0);
    }
    const a = expected.split('\n');
    const b = actual.split('\n');
    const first = a.findIndex((line, i) => line !== b[i]);
    console.log(`DAP SCENARIOS CHANGED — first difference at snapshot line ${first + 1}:`);
    console.log(`  expected: ${a[first]}`);
    console.log(`  actual:   ${b[first]}`);
    const out = path.join(os.tmpdir(), 'dap-scenarios.actual.json');
    fs.writeFileSync(out, actual);
    console.log(`full actual result written to ${out}; diff it against ${path.relative(process.cwd(), SNAPSHOT)}`);
    process.exit(1);
}

main().catch((err) => { console.error('harness error:', err); process.exit(2); });
