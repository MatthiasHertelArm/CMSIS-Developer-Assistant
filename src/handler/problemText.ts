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
 * The reply of `get_recent_problems` (#48): one line per record, oldest
 * first, then `nextSeq=`. `data` carries the cursor, the counts and the same
 * records as JSON (`records`): a client that shows the model
 * `structuredContent` instead of the text must still see them. A reply keeps
 * its text and its records within 8 kB each by leaving out the oldest
 * records, which count as omitted.
 */

import { formatProblemLine, problemJson, type ProblemPage, type ProblemRecord, type ProblemSeverity, type ProblemSource } from '../core/problemJournal';
import type { JsonObject, ToolReply } from '../core/toolResult';

/** Records a reply returns without `limit`, and at most. */
export const PROBLEMS_DEFAULT_LIMIT = 20;
export const PROBLEMS_MAX_LIMIT = 50;
/** The largest reply text, and the largest JSON of its records. */
export const PROBLEMS_REPLY_MAX_BYTES = 8 * 1024;

/** What an empty reply says it did not find, by the lightest severity asked for. */
const NOTHING: Readonly<Record<ProblemSeverity, string>> = {
    error: 'No errors',
    warning: 'No warnings or errors',
    info: 'No problems',
};

/** The query as the agent put it, for the wording of an empty reply. */
export interface ProblemsAsked {
    sinceSeq?: number;
    sources?: readonly ProblemSource[];
    minSeverity: ProblemSeverity;
}

/** The newest records of `page` whose lines and whose JSON each fit the byte budget, oldest first. */
function recordsWithin(page: ProblemPage, budget: number): { lines: string[]; records: JsonObject[] } {
    const lines: string[] = [];
    const records: JsonObject[] = [];
    let usedText = 0;
    let usedJson = 0;
    for (let index = page.records.length - 1; index >= 0; index--) {
        const record: ProblemRecord = page.records[index];
        const line = formatProblemLine(record);
        const json = problemJson(record);
        const textCost = Buffer.byteLength(line) + 1;
        const jsonCost = Buffer.byteLength(JSON.stringify(json)) + 1;
        if (usedText + textCost > budget || usedJson + jsonCost > budget) {
            break;
        }
        lines.unshift(line);
        records.unshift(json);
        usedText += textCost;
        usedJson += jsonCost;
    }
    return { lines, records };
}

/** The reply to one `get_recent_problems` call. */
export function renderProblemPage(page: ProblemPage, asked: ProblemsAsked): ToolReply {
    const trailerRoom = 200;
    const { lines, records } = recordsWithin(page, PROBLEMS_REPLY_MAX_BYTES - trailerRoom);
    const omitted = page.omitted + (page.records.length - lines.length);
    let text: string;
    if (lines.length === 0 && omitted === 0) {
        const from = asked.sources && asked.sources.length > 0 ? ` from ${asked.sources.join(', ')}` : '';
        const since = asked.sinceSeq !== undefined ? ` since #${asked.sinceSeq}` : ' recorded in this window';
        text = `${NOTHING[asked.minSeverity]}${from}${since} (nextSeq=${page.nextSeq}).`;
    } else {
        const left = omitted > 0
            ? [`… ${omitted} older record${omitted === 1 ? '' : 's'} left out: raise limit (at most ${PROBLEMS_MAX_LIMIT}) or narrow sources or minSeverity.`]
            : [];
        text = [...left, ...lines, `nextSeq=${page.nextSeq}`].join('\n');
    }
    return { text, status: 'ok', data: { nextSeq: page.nextSeq, returned: lines.length, omitted, records } };
}
