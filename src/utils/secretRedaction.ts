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
 * Decides whether a program value about to go to an AI agent must be withheld
 * as a possible credential. Debug adapters hand back everything in scope, API
 * keys and environment dumps included, and the agent usually forwards it to a
 * remote model.
 *
 * A value is withheld when its variable name is a well-known credential name
 * or its text contains a well-known credential shape. Two kinds of value are
 * always shown, whatever the name: empty and null-like ones (so "why is my
 * token empty?" stays debuggable) and plain numeric scalars — in firmware a
 * variable called `auth`, `token` or `pass` is nearly always a flag, counter
 * or parser tag, and a 32-bit integer cannot hold a credential.
 *
 * Pure and stateless: the callers decide where it applies (the variable views
 * and evaluate_expression, while `redactSecrets` is on).
 */

export const REDACTION_PLACEHOLDER: string = '<redacted: possible secret>';

export const REDACTION_NOTICE: string = [
    `NOTE: values matching '${REDACTION_PLACEHOLDER}' were held back because the variable name or the value itself resembles a credential such as an API key, token, password or connection string.`,
    'To debug such a value, check its type, its length or whether it is null rather than asking for its contents.',
    'Numeric scalars are never withheld, so firmware flags and counters stay readable.',
    'Turn this off with the "cmsis-developer-assistant.redactSecrets" setting.',
].join(' ');

type Verdict = { value: string; redacted: boolean };

const words = (list: string): string[] => list.split(' ');

/**
 * Credential names after normalisation (lower case; whitespace, `_` and `-`
 * removed). Matched whole, so `tokenCount` or `passwordLength` are not on it.
 * Register names from SVDs (`KEY`, `KR`, `KEYR`, `UNLOCK`, …) stay off on
 * purpose.
 */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
    // Passwords and one-time codes
    ...words('pass passwd password passwords passphrase pwd otp adminpassword rootpassword userpassword dbpass dbpasswd dbpassword'),
    // Generic secrets, sessions, connection strings
    ...words('secret secrets credential credentials auth authorization cookie cookies sessionid connectionstring connstr'),
    // Tokens
    ...words('token tokens accesstoken refreshtoken idtoken authtoken apitoken bearer bearertoken oauthtoken sessiontoken csrftoken xsrftoken jwt personalaccesstoken'),
    // API keys and client secrets
    ...words('apikey apikeys apisecret apisecretkey accesskey accesskeyid secretkey secretaccesskey clientkey clientsecret consumersecret'),
    // Cryptographic keys
    ...words('privatekey publicprivatekey encryptionkey signingkey masterkey sessionkey sshkey gpgkey'),
    // Vendor-specific
    ...words('anthropicapikey openaiapikey googleapikey awsaccesskeyid awssecretaccesskey awssessiontoken azurestoragekey accountkey saskey sastoken sasurl'),
    ...words('ghtoken githubtoken gitlabtoken npmtoken slacktoken'),
]);

/**
 * Well-known credential shapes, searched anywhere in a value. None has the
 * `g` or `y` flag, so `test()` carries no state from one call to the next.
 */
const CREDENTIAL_SHAPES: ReadonlyArray<{ kind: string; shape: RegExp }> = [
    { kind: 'PEM private key', shape: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
    { kind: 'JSON Web Token', shape: /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]/ },
    { kind: 'AWS access key id', shape: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{12,}\b/ },
    { kind: 'GitHub token', shape: /\bgh[pousr]_[a-zA-Z0-9]{16,}\b/ },
    { kind: 'GitHub fine-grained token', shape: /\bgithub_pat_\w{20,}\b/ },
    { kind: 'Slack token', shape: /\bxox[abopsr]-[a-zA-Z0-9-]{10,}\b/ },
    { kind: 'Google API key', shape: /\bAIza[\w-]{30,}\b/ },
    { kind: 'OpenAI or Anthropic key', shape: /\bsk-(?:[\w-]+-)?[a-zA-Z0-9]{16,}\b/ },
    { kind: 'Stripe key', shape: /\b[rs]k_(?:live|test)_[a-zA-Z0-9]{10,}\b/ },
    { kind: 'npm token', shape: /\bnpm_[a-zA-Z0-9]{30,}\b/ },
    { kind: 'GitLab token', shape: /\bglpat-[\w-]{16,}\b/ },
    { kind: 'Bearer token', shape: /\bbearer\s+[\w.~+/=-]{12,}/i },
    { kind: 'Connection-string secret', shape: /\b(?:accountkey|sharedaccesssignature|password|pwd)\s*=\s*[^;\s'"]+/i },
];

/** Values that say "nothing here" rather than carry data (compared lower-cased, unwrapped). */
const TRIVIAL_VALUES: ReadonlySet<string> = new Set(['', ...words('none null nil undefined nan true false 0 -1 [] {} () empty <empty>')]);

/**
 * A C-style number: optional sign; hex (`0x…`), binary (`0b…`) or decimal with
 * optional fraction and exponent; any `u`/`l`/`f` suffix letters. Matched
 * case-insensitively, which only widens the letters the three forms already
 * accept in either case.
 */
const NUMBER_LITERAL = /^[+-]?(?:0x[0-9a-f]+|0b[01]+|[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?)[ulf]*$/i;

const QUOTE_CHARS = '\'"`';
/** A GDB annotation after a value opens with one of these (`<main+8>`, `'\f'`, `"text"`). */
const ANNOTATION_OPENERS = '<\'"';
const WHITESPACE = /\s/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Trim, then peel matching outer quotes (and the whitespace inside them) layer by layer. */
function unwrap(text: string): string {
    let core = text.trim();
    while (core.length >= 2 && QUOTE_CHARS.includes(core[0]) && core.endsWith(core[0])) {
        core = core.slice(1, -1).trim();
    }
    return core;
}

/**
 * Drop what GDB prints after a value — ` <main+8>` after an address, ` '\f'`
 * after a char: the leftmost stretch of whitespace followed by an opener that
 * runs to the end of the text on one line. Without whitespace before the
 * opener nothing is dropped. A linear scan: every whitespace run is visited
 * once.
 */
function dropAnnotation(text: string): string {
    let lastBreak = -1;
    for (let k = text.length - 1; k >= 0; k--) {
        if (LINE_BREAK.test(text[k])) {
            lastBreak = k;
            break;
        }
    }
    let pos = 0;
    while (pos < text.length) {
        if (!WHITESPACE.test(text[pos])) {
            pos++;
            continue;
        }
        const runStart = pos;
        while (pos < text.length && WHITESPACE.test(text[pos])) {
            pos++;
        }
        // `pos` is the first character after the run; the opener and all
        // that follows it must lie beyond the last line break.
        if (pos < text.length && pos > lastBreak && ANNOTATION_OPENERS.includes(text[pos])) {
            return text.slice(0, runStart);
        }
    }
    return text;
}

function isTrivialValue(text: string): boolean {
    return TRIVIAL_VALUES.has(unwrap(text).toLowerCase());
}

function isNumericScalar(text: string): boolean {
    const core = unwrap(text);
    return core.length > 0 && NUMBER_LITERAL.test(dropAnnotation(core).trim());
}

/** Empty, null-like and numeric values are shown under any name. */
function isAlwaysShown(text: string): boolean {
    return text.length === 0 || isTrivialValue(text) || isNumericScalar(text);
}

function normaliseName(name: string): string {
    return name.toLowerCase().split(/[\s_-]/).join('');
}

/** The name, normalised, is a credential name. `API_KEY`, `api-key` and `apiKey` are one name. */
export function isSensitiveName(identifier: string | undefined | null): boolean {
    return identifier ? CREDENTIAL_NAMES.has(normaliseName(identifier)) : false;
}

/** The text contains a well-known credential shape somewhere. */
export function looksLikeSecretValue(text: string | undefined | null): boolean {
    return text ? CREDENTIAL_SHAPES.some(({ shape }) => shape.test(text)) : false;
}

/**
 * The decision in order: always-shown values first (so a credential name never
 * hides an empty or numeric value), then the name, then the value's shape.
 */
function judge(label: string | undefined, raw: unknown): Verdict {
    const text = raw === undefined || raw === null ? '' : String(raw);
    const withhold = !isAlwaysShown(text) && (isSensitiveName(label) || looksLikeSecretValue(text));
    return withhold ? { value: REDACTION_PLACEHOLDER, redacted: true } : { value: text, redacted: false };
}

/**
 * The value as it may be shown, judged by the variable's own name and its own
 * rendering. A structure is not searched field by field; its whole rendering
 * is scanned for credential shapes.
 */
export function redactVariableValue(variableName: string | undefined, raw: unknown): Verdict {
    return judge(variableName, raw);
}

/**
 * The same judgement for an `evaluate_expression` result, with the whole
 * expression standing in for the name: only a bare credential name counts as
 * one (`apiKey` does, `process.env.API_KEY` does not).
 */
export function redactExpressionResult(expressionText: string, raw: unknown): Verdict {
    return judge(expressionText, raw);
}
