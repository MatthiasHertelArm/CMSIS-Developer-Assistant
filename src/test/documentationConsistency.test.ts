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

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { sliceTopic } from '../core/instructionTopics';

/**
 * The debugging guide, the live-debugging procedure, the troubleshooting notes
 * and the bootstrap skill each say what to do in a fault, an unresponsive
 * session, a serial monitor, the Cortex-M budget and a clean-up. The knowledge
 * units are built from the same files, so a disagreement reaches the agent
 * either way. Each check pins one of those facts in every source that states
 * it: the same next action, and no stale wording left behind.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const read = (...parts: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
/** One line of text, so a sentence that a Markdown wrap split still matches. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const GUIDE = read('docs', 'agent-resources', 'debug_instructions.md');
const LIVE = read('skills', 'cmsis-debug-live', 'SKILL.md');
const EMBEDDED = read('docs', 'agent-resources', 'troubleshooting', 'embedded.md');
const BOOTSTRAP = read('skills', 'cmsis-bootstrap', 'SKILL.md');

suite('Documentation consistency across the guide, the live procedure and the notes', () => {
    test('the Cortex-M comparator counts agree in every source, and none groups M4 with M7', () => {
        assert.match(sliceTopic(GUIDE, 'breakpoints'), /\|\s*Cortex-M7\s*\|\s*8\s*\|/, 'the guide table gives M7 eight comparators');
        assert.ok(flat(EMBEDDED).includes('M3/M4: 6, M7/M33/M55/M85: 8'), 'the troubleshooting notes give the same counts');
        assert.ok(flat(LIVE).includes('**6** on M3/M4, **8** on M7/M33/M55/M85'), 'the live procedure gives the same counts');
        for (const [name, text] of [['the guide', GUIDE], ['the live procedure', LIVE], ['the troubleshooting notes', EMBEDDED]]) {
            assert.ok(!/M4\/M7/.test(text), `${name} still groups M4 with M7`);
        }
    });

    test('a fault is read with diagnose_fault first, in the overview, the faults topic and the live procedure', () => {
        assert.ok(!/get_fault_info`? first/.test(GUIDE), 'the guide still puts get_fault_info first');
        assert.ok(sliceTopic(GUIDE, 'overview').includes('`diagnose_fault` once stopped (topic `faults`)'),
            'the served overview names diagnose_fault for a fault');
        assert.ok(flat(sliceTopic(GUIDE, 'faults')).includes('`diagnose_fault` is the first pass'),
            'the faults topic makes diagnose_fault the first pass');
        assert.ok(!/then `get_fault_info`/.test(EMBEDDED), 'the troubleshooting notes still send a fault to get_fault_info first');
        assert.ok(EMBEDDED.includes('`diagnose_fault` — did the target crash?'), 'the first-line sweep uses diagnose_fault');
        assert.ok(flat(LIVE).includes('`diagnose_fault` does the whole first pass in one call'), 'the live procedure names diagnose_fault first');
    });

    test('an unresponsive session keeps the fault state before any restart, and says what a restart loses', () => {
        const session = flat(sliceTopic(GUIDE, 'session'));
        const preserve = session.indexOf('Reconnect without a reset first');
        const restart = session.indexOf('`restart_debugging` and `cmsis_action load_and_debug` re-flash and reset');
        assert.ok(preserve >= 0 && restart > preserve, 'the guide table reconnects without a reset before it restarts');
        assert.ok(session.includes('lose that state'), 'the guide table says that a restart loses the fault state');
        const faults = flat(sliceTopic(GUIDE, 'faults'));
        assert.ok(faults.includes('The fault state survives.'), 'the faults topic says which reconnects keep the fault state');
        assert.ok(faults.includes('clears the fault status'), 'the faults topic says that a reset clears the fault status');
        assert.ok(flat(LIVE).includes('keeping the fault state for as long as you can'), 'the live procedure keeps the fault state');
        assert.ok(flat(LIVE).includes('clears the fault status'), 'the live procedure says that a reset clears the fault status');
        assert.ok(flat(EMBEDDED).includes('which clears the fault status: record the fault first'),
            'the troubleshooting notes say to record the fault before a reset');
    });

    test('the clean-up contract names the same four parts in the guide and in the live procedure', () => {
        for (const [name, text] of [['the guide', flat(sliceTopic(GUIDE, 'session'))], ['the live procedure', flat(LIVE)]]) {
            assert.ok(text.includes('**Target:** running when you finish'), `${name} names the target state at the end`);
            assert.ok(text.includes('**Breakpoints:**'), `${name} names the breakpoint state at the end`);
            assert.ok(text.includes('**Debug session:**') || text.includes('**Session:**') || text.includes('**Probe:**'),
                `${name} names the session and probe state`);
            assert.ok(text.includes('Read-only checks (`get_session_status`,'), `${name} keeps health checks out of the clean-up`);
            assert.ok(!text.includes('`stop_debugging` when done'), `${name} still stops the session unconditionally`);
            assert.ok(!text.includes('call `clear_all_breakpoints` before concluding'), `${name} still clears every breakpoint unconditionally`);
        }
    });

    test('between phases a source removes the breakpoints the investigation set, never every breakpoint of the window', () => {
        for (const [name, text] of [['the guide', GUIDE], ['the live procedure', LIVE], ['the troubleshooting notes', EMBEDDED]]) {
            assert.ok(!/`clear_all_breakpoints` (between|to free|when you change)/.test(flat(text)),
                `${name} still recommends clear_all_breakpoints between phases, which deletes the user's breakpoints too`);
            assert.ok(flat(text).includes('`remove_breakpoint`'), `${name} names remove_breakpoint for the breakpoints the investigation set`);
        }
    });

    test('serial subscription is capability-dependent in the guide and the live procedure, and no document says it taps the monitor', () => {
        assert.ok(flat(sliceTopic(GUIDE, 'inspection')).includes('capability-dependent: API version 0 has none'),
            'the guide says subscription depends on the monitor API');
        assert.ok(flat(LIVE).includes('capability-dependent: API version 0 has none'), 'the live procedure says the same');
        assert.ok(!/\btaps\b/.test(GUIDE) && !/\btaps\b/.test(LIVE), 'a source still says that subscription taps the monitor');
    });

    test('the bootstrap procedure hands over by knowledge procedure, not by an installed skill', () => {
        assert.ok(!BOOTSTRAP.includes('installed next to this one'), 'the bootstrap skill still says its siblings are installed');
        assert.ok(!BOOTSTRAP.includes('Configure Agent'), 'the bootstrap skill still asks the user to reinstall skills');
        assert.ok(flat(BOOTSTRAP).includes('`proc-<name>` of the knowledge index'), 'the bootstrap skill names the knowledge procedures');
        assert.ok(!sliceTopic(GUIDE, 'bootstrap').includes('the skill `cmsis-bootstrap`'), 'the guide still names the cmsis-bootstrap skill');
        assert.ok(sliceTopic(GUIDE, 'bootstrap').includes('`proc-cmsis-bootstrap`'), 'the guide names the bootstrap procedure by its ID');
    });
});
