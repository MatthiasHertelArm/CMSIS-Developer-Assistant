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
import * as fc from 'fast-check';
import { decodeFault, decodeFaultRegisters, renderFaultReport, FaultRegisters, FaultStatusRegister } from '../core/faultDecoder';

/**
 * get_fault_info's text is what agents (and the skill) have learnt to read;
 * the structured decode underneath it feeds diagnose_fault. Pin both: every
 * bit, the class precedence, and that the text did not change for the bits
 * that existed before.
 */
suite('Fault decoder', () => {

    const regs = (over: Partial<FaultRegisters> = {}): FaultRegisters =>
        ({ CFSR: 0, HFSR: 0, DFSR: 0, MMFAR: 0, BFAR: 0, AFSR: 0, ...over });

    test('a precise bus fault escalated to HardFault decodes class, address and flags', () => {
        const d = decodeFault(regs({ CFSR: 0x8200, HFSR: 0x40000000, BFAR: 0x40005400 }));
        assert.strictEqual(d.faultClass, 'BusFault');
        assert.strictEqual(d.escalated, true);
        assert.deepStrictEqual(d.faultAddress, { source: 'BFAR', value: 0x40005400 });
        assert.deepStrictEqual(d.flags.map(f => f.name), ['FORCED', 'BFARVALID', 'PRECISERR']);
        const text = decodeFaultRegisters(regs({ CFSR: 0x8200, HFSR: 0x40000000, BFAR: 0x40005400 }));
        assert.match(text, /HFSR  = 0x40000000\n  FORCED: Escalated fault \(check CFSR for root cause\)\n/);
        assert.match(text, /BFSR  = 0x82\n  BFARVALID: Faulting address = 0x40005400\n  PRECISERR: Precise data bus error\n/);
    });

    test('class precedence: MemManage before BusFault before UsageFault before bare HardFault', () => {
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0002 })).faultClass, 'MemManage');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0002 | 0x0200 })).faultClass, 'MemManage');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0200 | 0x00010000 })).faultClass, 'BusFault');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x00010000 })).faultClass, 'UsageFault');
        assert.strictEqual(decodeFault(regs({ HFSR: 0x2 })).faultClass, 'HardFault');
        assert.strictEqual(decodeFault(regs()).faultClass, 'None');
        assert.strictEqual(decodeFault(regs({ CFSR: 0x80, MMFAR: 0x20 })).faultClass, 'None', 'MMARVALID alone is not a fault');
    });

    test('MMFAR is only reported with MMARVALID, and BFAR wins when both are valid', () => {
        assert.strictEqual(decodeFault(regs({ CFSR: 0x0002, MMFAR: 0x10 })).faultAddress, undefined);
        assert.deepStrictEqual(decodeFault(regs({ CFSR: 0x0082, MMFAR: 0x10 })).faultAddress, { source: 'MMFAR', value: 0x10 });
        assert.deepStrictEqual(decodeFault(regs({ CFSR: 0x8082, MMFAR: 0x10, BFAR: 0x20 })).faultAddress, { source: 'BFAR', value: 0x20 });
    });

    test('the two new bits decode: STKOF (Armv8-M) and DEBUGEVT', () => {
        const stkof = decodeFault(regs({ CFSR: 0x00100000 }));
        assert.deepStrictEqual(stkof.flags.map(f => f.name), ['STKOF']);
        assert.match(decodeFaultRegisters(regs({ CFSR: 0x00100000 })), /UFSR  = 0x0010\n  STKOF: Stack overflow/);
        assert.deepStrictEqual(decodeFault(regs({ HFSR: 0x80000000 })).flags.map(f => f.name), ['DEBUGEVT']);
    });

    test('every UsageFault and DFSR bit is named in report order', () => {
        const d = decodeFault(regs({ CFSR: 0x031F0000, DFSR: 0x1F }));
        assert.deepStrictEqual(d.flags.map(f => f.name),
            ['DIVBYZERO', 'UNALIGNED', 'STKOF', 'NOCP', 'INVPC', 'INVSTATE', 'UNDEFINSTR', 'EXTERNAL', 'VCATCH', 'DWTTRAP', 'BKPT', 'HALTED']);
    });

    test('the text form for a clean core is unchanged', () => {
        assert.strictEqual(decodeFaultRegisters(regs()),
            '=== Cortex-M Fault Analysis ===\n\nHFSR  = 0x00000000\n\nMMFSR = 0x00\n\nBFSR  = 0x00\n\nUFSR  = 0x0000\n\nDFSR  = 0x00000000\n\nNo fault flags set. Target may not be in a fault handler.\n');
        assert.match(decodeFaultRegisters(regs({ AFSR: 0x5 })), /AFSR  = 0x00000005 \(implementation-defined\)/);
    });
});

/**
 * The decoder against the architecture, and pins of what agents read.
 *
 * The bit model below was transcribed by hand on 2026-11-25 from the Armv8-M Architecture Reference
 * Manual DDI0553B.z (CFSR p.1477, MMFSR p.1740-1741, BFSR p.1467-1469, UFSR p.1897-1899, HFSR p.1671-1672,
 * DFSR p.1529-1530) and the Armv7-M Architecture Reference Manual DDI0403E.e (CFSR and MMFSR p.609-610,
 * MMFAR p.613, DFSR p.699), both read through the documentation tools. It covers the five status
 * registers the decoder reads and nothing else of the architecture's fault model; a bit it does not
 * list is reserved (RES0). A test whose expectation has no source outside this repository says
 * "regression pin" in its name: the class precedence, the choice between BFAR and MMFAR, the report
 * layout and the texts are what get_fault_info has always shown, and a change there is a change for
 * every agent that reads it.
 */
suite('Fault decoder: the architecture\'s bits (fast-check)', () => {

    type Bit = readonly [bit: number, name: string];
    const ARCHITECTURE: Record<FaultStatusRegister, ReadonlyArray<Bit>> = {
        HFSR: [[31, 'DEBUGEVT'], [30, 'FORCED'], [1, 'VECTTBL']],
        // Bit 7 is MMARVALID in Armv7-M (DDI0403E.e p.610) and in CMSIS Core (SCB_CFSR_MMARVALID_Pos,
        // CMSIS 6.3.0); Armv8-M spells it MMFARVALID (DDI0553B.z p.1740). The decoder keeps the CMSIS name.
        MMFSR: [[7, 'MMARVALID'], [5, 'MLSPERR'], [4, 'MSTKERR'], [3, 'MUNSTKERR'], [1, 'DACCVIOL'], [0, 'IACCVIOL']],
        BFSR: [[7, 'BFARVALID'], [5, 'LSPERR'], [4, 'STKERR'], [3, 'UNSTKERR'], [2, 'IMPRECISERR'], [1, 'PRECISERR'], [0, 'IBUSERR']],
        // STKOF exists from Armv8-M on (DDI0553B.z p.1898); in Armv7-M bit 4 is reserved.
        UFSR: [[9, 'DIVBYZERO'], [8, 'UNALIGNED'], [4, 'STKOF'], [3, 'NOCP'], [2, 'INVPC'], [1, 'INVSTATE'], [0, 'UNDEFINSTR']],
        // PMU exists in Armv8.1-M with a PMU (DDI0553B.z p.1529); in Armv7-M bits [31:5] are reserved (DDI0403E.e p.699).
        DFSR: [[5, 'PMU'], [4, 'EXTERNAL'], [3, 'VCATCH'], [2, 'DWTTRAP'], [1, 'BKPT'], [0, 'HALTED']],
    };
    /** Reserved positions the generator sets as well, so that a reserved bit is seen to decode to nothing. */
    const RESERVED: Record<FaultStatusRegister, readonly number[]> = {
        HFSR: [0, 2, 15, 29], MMFSR: [2, 6], BFSR: [6], UFSR: [5, 6, 7, 10, 15], DFSR: [6, 7, 31],
    };
    const REGISTERS: readonly FaultStatusRegister[] = ['HFSR', 'MMFSR', 'BFSR', 'UFSR', 'DFSR'];

    /** A register's value in the words the decoder reads: CFSR is UFSR[31:16], BFSR[15:8], MMFSR[7:0] (DDI0553B.z p.1477, DDI0403E.e p.609). */
    const valueOf = (regs: FaultRegisters, reg: FaultStatusRegister): number => ({
        HFSR: regs.HFSR >>> 0, MMFSR: regs.CFSR & 0xFF, BFSR: (regs.CFSR >>> 8) & 0xFF, UFSR: (regs.CFSR >>> 16) & 0xFFFF, DFSR: regs.DFSR >>> 0,
    })[reg];
    const isSet = (value: number, bit: number): boolean => (value & (1 << bit)) !== 0;
    const hex8 = (n: number): string => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;

    /** A register from a subset of its named and reserved bit positions: sparse values, the empty set and lone bits included. */
    const bitsArb = (reg: FaultStatusRegister): fc.Arbitrary<number> =>
        fc.subarray([...ARCHITECTURE[reg].map(([bit]) => bit), ...RESERVED[reg]])
            .map(bits => bits.reduce((value, bit) => (value | (1 << bit)) >>> 0, 0));
    const wordArb: fc.Arbitrary<number> = fc.integer({ min: -0x80000000, max: 0x7fffffff }).map(v => v >>> 0);
    const regsArb: fc.Arbitrary<FaultRegisters> = fc.record({
        hfsr: bitsArb('HFSR'), mmfsr: bitsArb('MMFSR'), bfsr: bitsArb('BFSR'), ufsr: bitsArb('UFSR'), dfsr: bitsArb('DFSR'),
        MMFAR: wordArb, BFAR: wordArb, AFSR: fc.constantFrom(0, 0x5, 0xFFFFFFFF),
    }).map(({ hfsr, mmfsr, bfsr, ufsr, dfsr, MMFAR, BFAR, AFSR }) =>
        ({ CFSR: ((ufsr << 16) | (bfsr << 8) | mmfsr) >>> 0, HFSR: hfsr, DFSR: dfsr, MMFAR, BFAR, AFSR }));
    /** A fixed seed: every run, a mutation run included, judges the same 300 register sets. */
    const check = (predicate: (regs: FaultRegisters) => void): void => {
        fc.assert(fc.property(regsArb, predicate), { seed: 20261125, numRuns: 300 });
    };

    test('every set bit the architecture names is decoded once, under that name and bit, and a reserved bit is not', () => {
        check((regs) => {
            const expected: string[] = [];
            for (const reg of REGISTERS) {
                for (const [bit, name] of ARCHITECTURE[reg]) {
                    if (isSet(valueOf(regs, reg), bit)) { expected.push(`${reg}.${name}@${bit}`); }
                }
            }
            const actual = decodeFault(regs).flags.map(f => `${f.reg}.${f.name}@${f.bit}`);
            assert.deepStrictEqual([...actual].sort(), expected.sort(), `registers ${JSON.stringify(regs)}`);
        });
    });

    test('an address is reported only with its valid bit and is that register\'s value (MMFAR: DDI0553B.z p.1739, DDI0403E.e p.613; BFAR: DDI0553B.z p.1467); the flag\'s wording is a regression pin', () => {
        check((regs) => {
            const { faultAddress, flags } = decodeFault(regs);
            const mmarValid = isSet(valueOf(regs, 'MMFSR'), 7);
            const bfarValid = isSet(valueOf(regs, 'BFSR'), 7);
            if (!mmarValid && !bfarValid) {
                assert.strictEqual(faultAddress, undefined);
            } else {
                assert.ok(faultAddress, 'an address with a valid bit set');
                assert.ok(faultAddress.source === 'BFAR' ? bfarValid : mmarValid, 'the source named has its valid bit set');
                assert.strictEqual(faultAddress.value, regs[faultAddress.source] >>> 0);
            }
            const text = (name: string) => flags.find(f => f.name === name)?.text;
            assert.strictEqual(text('MMARVALID'), mmarValid ? `MMARVALID: Faulting address = ${hex8(regs.MMFAR)}` : undefined);
            assert.strictEqual(text('BFARVALID'), bfarValid ? `BFARVALID: Faulting address = ${hex8(regs.BFAR)}` : undefined);
        });
    });

    test('escalated is HFSR.FORCED, a configurable fault escalated to HardFault (DDI0553B.z p.1671)', () => {
        check((regs) => { assert.strictEqual(decodeFault(regs).escalated, isSet(regs.HFSR, 30)); });
    });

    test('regression pin: the class is the first of MemManage, BusFault, UsageFault, HardFault with a bit set, a valid-address bit alone counting for nothing', () => {
        check((regs) => {
            const named = (reg: FaultStatusRegister, exceptBit?: number): boolean =>
                ARCHITECTURE[reg].some(([bit]) => bit !== exceptBit && isSet(valueOf(regs, reg), bit));
            const expected = named('MMFSR', 7) ? 'MemManage' : named('BFSR', 7) ? 'BusFault' : named('UFSR') ? 'UsageFault' : named('HFSR') ? 'HardFault' : 'None';
            assert.strictEqual(decodeFault(regs).faultClass, expected, `registers ${JSON.stringify(regs)}`);
        });
    });

    test('regression pin: BFAR is the address when both valid bits are set', () => {
        check((regs) => {
            fc.pre((regs.CFSR & 0x8080) === 0x8080);
            assert.deepStrictEqual(decodeFault(regs).faultAddress, { source: 'BFAR', value: regs.BFAR >>> 0 });
        });
    });

    test('regression pin: the report shows each register\'s value with one line per flag under it, the AFSR when it is not zero, and the no-fault line only when CFSR and HFSR are both zero', () => {
        check((regs) => {
            const decoded = decodeFault(regs);
            const lines = (reg: FaultStatusRegister): string => decoded.flags.filter(f => f.reg === reg).map(f => `  ${f.text}\n`).join('');
            const expected = '=== Cortex-M Fault Analysis ===\n\n'
                + `HFSR  = ${hex8(regs.HFSR)}\n${lines('HFSR')}`
                + `\nMMFSR = 0x${valueOf(regs, 'MMFSR').toString(16).padStart(2, '0')}\n${lines('MMFSR')}`
                + `\nBFSR  = 0x${valueOf(regs, 'BFSR').toString(16).padStart(2, '0')}\n${lines('BFSR')}`
                + `\nUFSR  = 0x${valueOf(regs, 'UFSR').toString(16).padStart(4, '0')}\n${lines('UFSR')}`
                + `\nDFSR  = ${hex8(regs.DFSR)}\n${lines('DFSR')}`
                + (regs.AFSR !== 0 ? `\nAFSR  = ${hex8(regs.AFSR)} (implementation-defined)\n` : '')
                + (regs.CFSR === 0 && regs.HFSR === 0 ? '\nNo fault flags set. Target may not be in a fault handler.\n' : '');
            assert.strictEqual(renderFaultReport(decoded), expected);
            assert.strictEqual(decodeFaultRegisters(regs), expected);
        });
    });

    test('regression pin: the get_fault_info line of every bit, as agents have learnt to read it (no source outside this repository)', () => {
        const LINES: ReadonlyArray<[FaultStatusRegister, number, string]> = [
            ['HFSR', 31, 'DEBUGEVT: Debug event escalated to HardFault (debug monitor disabled)'],
            ['HFSR', 30, 'FORCED: Escalated fault (check CFSR for root cause)'],
            ['HFSR', 1, 'VECTTBL: Vector table read fault on exception processing'],
            ['MMFSR', 7, 'MMARVALID: Faulting address = 0x00000000'],
            ['MMFSR', 5, 'MLSPERR: MemManage fault during FP lazy state preservation'],
            ['MMFSR', 4, 'MSTKERR: MemManage fault on exception entry (stacking)'],
            ['MMFSR', 3, 'MUNSTKERR: MemManage fault on exception return (unstacking)'],
            ['MMFSR', 1, 'DACCVIOL: Data access violation'],
            ['MMFSR', 0, 'IACCVIOL: Instruction access violation'],
            ['BFSR', 7, 'BFARVALID: Faulting address = 0x00000000'],
            ['BFSR', 5, 'LSPERR: BusFault during FP lazy state preservation'],
            ['BFSR', 4, 'STKERR: BusFault on exception entry (stacking)'],
            ['BFSR', 3, 'UNSTKERR: BusFault on exception return (unstacking)'],
            ['BFSR', 2, 'IMPRECISERR: Imprecise data bus error'],
            ['BFSR', 1, 'PRECISERR: Precise data bus error'],
            ['BFSR', 0, 'IBUSERR: Instruction bus error'],
            ['UFSR', 9, 'DIVBYZERO: Divide by zero'],
            ['UFSR', 8, 'UNALIGNED: Unaligned memory access'],
            ['UFSR', 4, 'STKOF: Stack overflow (Armv8-M stack limit crossed)'],
            ['UFSR', 3, 'NOCP: Coprocessor access (FPU not enabled?)'],
            ['UFSR', 2, 'INVPC: Invalid PC load on return (corrupted stack?)'],
            ['UFSR', 1, 'INVSTATE: Invalid EPSR.T bit (ARM mode on Cortex-M?)'],
            ['UFSR', 0, 'UNDEFINSTR: Undefined instruction'],
            ['DFSR', 5, 'PMU: PMU counter overflow debug event (Armv8.1-M)'],
            ['DFSR', 4, 'EXTERNAL: External debug request'],
            ['DFSR', 3, 'VCATCH: Vector catch'],
            ['DFSR', 2, 'DWTTRAP: DWT match'],
            ['DFSR', 1, 'BKPT: Breakpoint instruction'],
            ['DFSR', 0, 'HALTED: Halt request'],
        ];
        assert.strictEqual(LINES.length, REGISTERS.reduce((n, reg) => n + ARCHITECTURE[reg].length, 0), 'one line per architecture bit');
        for (const [reg, bit, line] of LINES) {
            const word = ((1 << bit) << (reg === 'BFSR' ? 8 : reg === 'UFSR' ? 16 : 0)) >>> 0;
            const only: FaultRegisters = { CFSR: 0, HFSR: 0, DFSR: 0, MMFAR: 0, BFAR: 0, AFSR: 0, [reg === 'HFSR' ? 'HFSR' : reg === 'DFSR' ? 'DFSR' : 'CFSR']: word };
            assert.deepStrictEqual(decodeFault(only).flags.map(f => f.text), [line], `${reg} bit ${bit}`);
        }
    });

    // The three gaps the first mutation run showed (2026-11-25), as examples beside the properties above;
    // their wording and layout are the module's conventions, so they are pins.
    const regs = (over: Partial<FaultRegisters> = {}): FaultRegisters =>
        ({ CFSR: 0, HFSR: 0, DFSR: 0, MMFAR: 0, BFAR: 0, AFSR: 0, ...over });

    test('regression pin: MMARVALID carries the MMFAR as eight hex digits, under MMFSR, bit 7', () => {
        assert.deepStrictEqual(decodeFault(regs({ CFSR: 0x82, MMFAR: 0x20000010 })).flags,
            [{ reg: 'MMFSR', name: 'MMARVALID', bit: 7, text: 'MMARVALID: Faulting address = 0x20000010' },
             { reg: 'MMFSR', name: 'DACCVIOL', bit: 1, text: 'DACCVIOL: Data access violation' }]);
    });

    test('regression pin: the no-fault line needs both CFSR and HFSR zero', () => {
        const line = /No fault flags set/;
        assert.match(decodeFaultRegisters(regs()), line);
        assert.doesNotMatch(decodeFaultRegisters(regs({ HFSR: 0x2 })), line);
        assert.doesNotMatch(decodeFaultRegisters(regs({ CFSR: 0x1 })), line);
        assert.doesNotMatch(decodeFaultRegisters(regs({ CFSR: 0x1, HFSR: 0x2 })), line);
    });

    test('regression pin: the MMFSR and DFSR sections list their flags', () => {
        const text = decodeFaultRegisters(regs({ CFSR: 0x3, DFSR: 0x3 }));
        assert.match(text, /MMFSR = 0x03\n  DACCVIOL: Data access violation\n  IACCVIOL: Instruction access violation\n/);
        assert.match(text, /DFSR  = 0x00000003\n  BKPT: Breakpoint instruction\n  HALTED: Halt request\n/);
    });
});
