# Spec: src/utils/secretRedaction.ts (and src/test/secretRedaction.test.ts)

Pure functions that decide whether a runtime value about to be shown to an AI agent must be withheld as a possible credential, plus the placeholder that replaces a withheld value and the notice appended to a reply that withheld something. Debug adapters return every variable in scope, including API keys, tokens, passwords and whole environment dumps, and those replies go to an agent and usually on to a remote model provider. The policy descends from DebugMCP's (credential-looking names and well-known credential shapes are withheld; empty and null-like values stay visible so "why is my token empty?" stays debuggable), adapted for firmware: a plain numeric scalar is never withheld, whatever the variable is called, because in firmware `auth`, `token`, `secret` or `pass` are overwhelmingly integer flags, counters and parser tags, and a 32-bit integer cannot carry a credential.

The module only decides. Where it applies is the callers' business, recorded here for context: `DebuggingHandler` applies `redactVariableValue` to every variable it renders (through the `redact` option of `renderScopes` in `src/core/variableView.ts`) and `redactExpressionResult` to `evaluate_expression` results, both only while the setting `cmsis-developer-assistant.redactSecrets` is true (default). Expressions starting with `-exec` (GDB passthrough) and the raw target reads (`read_memory`, `read_core_registers`, `read_peripheral_register`, `get_fault_info`) never pass through it.

## External contract

Types are contract; parameter names are free.

```ts
export const REDACTION_PLACEHOLDER: string;
export const REDACTION_NOTICE: string;
export function isSensitiveName(name: string | undefined | null): boolean;
export function looksLikeSecretValue(value: string | undefined | null): boolean;
export function redactVariableValue(name: string | undefined, value: unknown): { value: string; redacted: boolean };
export function redactExpressionResult(expression: string, value: unknown): { value: string; redacted: boolean };
```

| Export | Used by |
| --- | --- |
| `REDACTION_PLACEHOLDER` | `src/test/secretRedaction.test.ts`. Its literal text is also asserted by `src/test/variableView.test.ts` and quoted in `docs/agent-resources/debug_instructions.md`. |
| `REDACTION_NOTICE` | `src/debuggingHandler.ts` (appended to an `evaluate_expression` reply after a blank line when the result was withheld), `src/core/variableView.ts` (appended once, followed by a line break, after a variable listing in which at least one value was withheld). |
| `isSensitiveName` | `src/test/secretRedaction.test.ts` only (and internally). |
| `looksLikeSecretValue` | `src/test/secretRedaction.test.ts` only (and internally). |
| `redactVariableValue` | `src/debuggingHandler.ts` (the redactor passed to the variable views), `src/test/variableView.test.ts`, `src/test/secretRedaction.test.ts`. |
| `redactExpressionResult` | `src/debuggingHandler.ts` (`evaluate_expression`), `src/test/secretRedaction.test.ts`. |

## Behaviour

All functions are pure and stateless: the same input always gives the same result, however many calls came before (beware of global regular expressions that carry `lastIndex` between calls).

### Decision order of `redactVariableValue(name, value)`

1. Text: `undefined` and `null` become the empty string; any other value becomes `String(value)`.
2. Keep (return the text unchanged, `redacted: false`) when the text is empty, is a trivial value, or is a numeric scalar (rules below). This step comes first, so a credential name never withholds an empty, null-like or numeric value.
3. Withhold when `isSensitiveName(name)` is true.
4. Withhold when `looksLikeSecretValue(text)` is true, whatever the name.
5. Otherwise keep.

"Keep" returns `{ value: <text>, redacted: false }` with the original text, not a trimmed or unquoted form. "Withhold" returns `{ value: REDACTION_PLACEHOLDER, redacted: true }`.

The decision uses the variable's own name and its own rendered value only. It never descends into a structure: a struct whose name is not a credential name is returned intact even if a field inside it is called `password`, unless its rendering as a whole contains a recognisable credential shape (step 4 scans the whole text).

### `redactExpressionResult(expression, value)`

The same decision, with the whole expression text in place of the name in step 3. The expression is compared as a whole after the name normalisation below, so only a bare credential name (`apiKey`, `API_KEY`) is sensitive; `process.env.API_KEY` or `os.environ["OPENAI_API_KEY"]` is not, and such results are withheld only by step 4.

### Unwrapping (used by the trivial and numeric rules)

Trim surrounding whitespace; then, as long as the text has at least two characters and starts and ends with the same quote character (`'`, `"` or a backtick), remove that pair and trim again. So `"'None'"`, `' None '` and `None` all unwrap to `None`.

### Trivial values

The unwrapped text, lower-cased, is one of: the empty string, `none`, `null`, `nil`, `undefined`, `nan`, `true`, `false`, `0`, `-1`, `[]`, `{}`, `()`, `empty`, `<empty>`. A whitespace-only value is therefore trivial.

### Numeric scalars

1. Unwrap the text. Empty: not numeric.
2. Remove a trailing annotation as GDB prints it after a value (`0x8000414 <main+8>`, `12 '\f'`): the leftmost stretch that starts with one or more whitespace characters followed by `<`, `'` or `"` and runs to the end of the text without crossing a line break. Then trim. Without whitespace before it (`5<x>`), or when the stretch would span a line break, nothing is removed.
3. The rest must match, in full, `^[+-]?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[uUlLfF]*$` (any formulation that accepts the same strings conforms): an optional sign; then a hexadecimal literal with `0x`/`0X`, a binary literal with `0b`/`0B`, or decimal digits with an optional fraction (digits required on both sides of the point) and an optional exponent; then any number of C suffix letters `u`, `U`, `l`, `L`, `f`, `F`. `\d` is ASCII 0–9.

Numeric: `42`, `-1`, `+7`, `3.14`, `1e-6`, `1E+10`, `0xDEADBEEF`, `0XAbC`, `0b10110001`, `-0b101`, `4294967295u`, `10UL`, `1.5f`, `"42"` (unwrapped). Not numeric: `.5`, `3.`, `0x`, `Infinity`, `-nan(0x400000)`, `AUTH_OK`, `(uint8_t *) 0x20000000 <buf>`.

### `isSensitiveName(name)`

- `undefined`, `null` and the empty string: false.
- Otherwise normalise: lower-case with `toLowerCase()`, then delete every whitespace character (JavaScript `\s`, Unicode included), underscore and hyphen. `API_KEY`, `api-key`, `apiKey`, `ApiKey`, `api key` all become `apikey`. Dots, brackets and other characters stay.
- True exactly when the normalised name is one of these 74 names (exact membership, not substring, so `tokenCount`, `hasToken`, `passwordLength`, `tokenizer` are not sensitive):

  `accesskey`, `accesskeyid`, `accesstoken`, `accountkey`, `adminpassword`, `anthropicapikey`, `apikey`, `apikeys`, `apisecret`, `apisecretkey`, `apitoken`, `auth`, `authorization`, `authtoken`, `awsaccesskeyid`, `awssecretaccesskey`, `awssessiontoken`, `azurestoragekey`, `bearer`, `bearertoken`, `clientkey`, `clientsecret`, `connectionstring`, `connstr`, `consumersecret`, `cookie`, `cookies`, `credential`, `credentials`, `csrftoken`, `dbpass`, `dbpasswd`, `dbpassword`, `encryptionkey`, `ghtoken`, `githubtoken`, `gitlabtoken`, `googleapikey`, `gpgkey`, `idtoken`, `jwt`, `masterkey`, `npmtoken`, `oauthtoken`, `openaiapikey`, `otp`, `pass`, `passphrase`, `passwd`, `password`, `passwords`, `personalaccesstoken`, `privatekey`, `publicprivatekey`, `pwd`, `refreshtoken`, `rootpassword`, `saskey`, `sastoken`, `sasurl`, `secret`, `secretaccesskey`, `secretkey`, `secrets`, `sessionid`, `sessionkey`, `sessiontoken`, `signingkey`, `slacktoken`, `sshkey`, `token`, `tokens`, `userpassword`, `xsrftoken`

- Deliberately absent: `key`, `kr`, `keyr`, `unlock`, `optkeyr`, `privcfgr` and similar SVD register names.

### `looksLikeSecretValue(value)`

- `undefined`, `null` and the empty string: false.
- Otherwise true when any of the following JavaScript regular expressions finds a match anywhere in the text (a search, not a full match). `\b` is JavaScript's ASCII word boundary (no `u` flag). Patterns are case-sensitive except where marked. Any implementation that accepts exactly the same set of strings conforms; the patterns may be written differently.
  1. PEM private key: `-----BEGIN[A-Z ]*PRIVATE KEY-----` (a following base64 body and `-----END … PRIVATE KEY-----` footer are irrelevant to the result).
  2. JWT: `\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]`
  3. AWS key id: `\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{12,}\b`
  4. GitHub token: `\bgh[pousr]_[A-Za-z0-9]{16,}\b`
  5. GitHub fine-grained token: `\bgithub_pat_[A-Za-z0-9_]{20,}\b`
  6. Slack token: `\bxox[abopsr]-[A-Za-z0-9-]{10,}\b`
  7. Google API key: `\bAIza[0-9A-Za-z_-]{30,}\b`
  8. OpenAI / Anthropic style key, with an optional infix such as `ant-api03-` or `proj-`: `\bsk-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9]{16,}\b`
  9. Stripe key: `\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b`
  10. npm token: `\bnpm_[A-Za-z0-9]{30,}\b`
  11. GitLab token: `\bglpat-[A-Za-z0-9_-]{16,}\b`
  12. Bearer token, case-insensitive: `\bBearer\s+[A-Za-z0-9._~+/=-]{12,}`
  13. Connection-string secret, case-insensitive: `\b(?:AccountKey|SharedAccessSignature|Password|Pwd)\s*=\s*[^;\s'"]+` (an `=` is required; `Password=abc` and `password = abc;` match, `pwd="abc"` and a JSON `"password": "x"` do not).
- The placeholder itself matches none of these and is neither trivial nor numeric, so redacting an already withheld value again returns the placeholder unchanged, under any name.

### Performance

Redaction runs on every variable of every listing. Each call must finish in under a second on the adversarial inputs of the existing guard tests ("Performance guards" under "Test cases"). See "Known bugs to preserve" for two inputs on which the current implementation is quadratic.

## Agent- or user-visible text

- `REDACTION_PLACEHOLDER`, exact: `<redacted: possible secret>`. The text is shared with DebugMCP but is a sentinel that agents match, and it is pinned by Arm-authored material: `src/test/variableView.test.ts` asserts `apiKey: <redacted: possible secret>`, and `docs/agent-resources/debug_instructions.md` quotes it (that file's digest is in the surface snapshot). Treat it like an identifier: do not reword it.
- `REDACTION_NOTICE`: one line, no line break inside, no trailing whitespace. Four sentences separated by single spaces:
  1. Starts with the exact text `NOTE: values matching`, one space and the placeholder in single quotes. `src/test/variableView.test.ts` asserts that `NOTE: values matching` occurs exactly once in a listing, so the phrase occurs exactly once in the notice. The rest of the sentence: [REWORD] these values were withheld because their name or content looks like a credential, with examples of credential kinds (key, token, password, connection string).
  2. [REWORD] Advice to check the value in debug-oriented ways (its type, its length, whether it is null) instead of reading the raw value.
  3. Exact (Arm): `Numeric scalars are never withheld, so firmware flags and counters stay readable.`
  4. Exact (Arm): `Turn this off with the "cmsis-developer-assistant.redactSecrets" setting.` (ends the notice).
- [REWORD] The suite titles, test titles and assertion messages of the old `src/test/secretRedaction.test.ts` outside its "embedded carve-out" suite are shared with DebugMCP; write new ones.

Surface snapshot: no recorded reply contains the placeholder or the notice (without a debug session no variable or expression value is rendered). Indirectly, the `cmsis-developer-assistant://docs/debug_instructions` resource digest in every shape covers the doc that quotes the placeholder; it stays unchanged as long as the placeholder does.

## Known bugs to preserve

All of these: preserve (fixed separately later). The rewrite must return identical results.

1. The expression-name check compares the whole expression, so `process.env.API_KEY`, `os.environ["OPENAI_API_KEY"]` or `config.password` are not recognised by name. Their result is withheld only when the value has a recognisable credential shape: `redactExpressionResult('process.env.API_KEY', 'hunter2')` returns `hunter2`. The old module's own comment claimed this bypass was blocked.
2. Unwrapping happens before the numeric test, so a numeric string such as a PIN held in a char buffer (`"123456"` under `password`) is shown.
3. The numeric carve-out covers plain literals only: enum values (`auth = AUTH_OK`), typed pointer renderings (`(uint8_t *) 0x20000000 <buf>`), GDB float specials (`-nan(0x400000)`, `inf`) and function-pointer renderings under a credential name are withheld.
4. An annotation that contains a line break defeats the carve-out (`5 <sym>` + line break + `more` under `pwd` is withheld).
5. Quadratic time on two inputs: a long run of whitespace inside a value that does not trim away (for example `5`, then 100 000 spaces, then `x`: about 5 s in the current implementation), and a long repetition of `sk-` (`sk-` × 20 000: about 1.3 s). The results must stay the same; an implementation that returns them faster conforms. Neither case is covered by a test today.
6. Values are rendered with `String(value)`, so a non-string value that is not null-like, such as an object, becomes `[object Object]` and is withheld under a credential name.

## Test cases

Test file: `src/test/secretRedaction.test.ts` (mocha TDD `suite`/`test`, Node `assert`). Choose your own fixture strings where the case describes a shape; the shapes must satisfy the patterns above. The cases under "Embedded carve-out (Arm)" come from the Arm-authored suite and may use the values given.

Names:

1. Given each of `apiKey`, `API_KEY`, `api-key`, `openai_api_key`, `secret`, `clientSecret`, `password`, `passwd`, `pwd`, `passphrase`, `accessToken`, `refresh_token`, `credentials`, `privateKey`, `AUTHORIZATION`, `connectionString`, `connStr`, `cookie`, `sessionKey`, `encryptionKey`, `sasToken`, `otp`, `bearerToken`, when `isSensitiveName` is called, then it returns true.
2. Given each of `author`, `count`, `userName`, `result`, `items`, `index`, `config`, then it returns false.
3. Given names that merely contain a credential word, `tokenCount`, `cookieCount`, `tokenIndex`, `secretCount`, `hasToken`, `passwordLength`, `tokenizer`, `subtokens`, then it returns false.
4. Given the spellings `API_KEY`, `api-key`, `apiKey`, `ApiKey`, `api key`, then it returns true for each.
5. Given the variable `tokenCount` with value `42`, when `redactVariableValue` is called, then the value is `42` and `redacted` is false.

Value shapes:

1. Given one sample of each of these shapes, each satisfying its pattern above, when `looksLikeSecretValue` is called, then it returns true for each: an AWS access key id (`AKIA` prefix); a classic GitHub token (`ghp_` prefix); a GitHub fine-grained token (`github_pat_` prefix); a Slack bot token (`xoxb-` prefix, digits, a hyphen, letters); a Google API key (`AIza` prefix); an Anthropic-style key with the infix `ant-api03-`; a Stripe live key (`sk_live_` prefix); an npm token (`npm_` prefix); a GitLab token (`glpat-` prefix); a JWT (three dot-separated base64url parts, the first beginning `eyJ`); a PEM block with an RSA private key header, a short base64 body and the footer on separate lines; `Bearer`, a space and a token of at least 12 characters.
2. Given each of `42`, `hello world`, `/usr/local/bin`, `None`, `user@example.com`, then it returns false.

Variables:

1. Given the name `api_key` and a single-quoted `sk-proj-…` string, when `redactVariableValue` is called, then `redacted` is true and the value is `REDACTION_PLACEHOLDER`.
2. Given the name `x` and a GitHub token, then it is withheld (placeholder).
3. Given the name `api_key` and each of `None`, `null`, `undefined`, the empty string, `''` (two single quotes), `0`, `False`, then `redacted` is false and the value is returned unchanged.
4. Given `userCount` = `42`, then the value is `42`, not withheld.
5. Given the name `config` and a JSON-like struct rendering with a `host` field and a `password` field holding an ordinary string (no credential shape), then it is returned unchanged, not withheld.
6. Given the name `credentials` and a struct rendering with only harmless fields, then it is withheld.
7. Given the name `environ` and an environment-dump rendering whose entries include a GitHub token, then it is withheld.
8. Given a GitHub token under `api_key`, when it is redacted and the resulting value is redacted again under `api_key`, then the second value equals the first and the placeholder text occurs exactly once in it.

Performance guards:

1. Given the name `blob` and a value that opens a dict-like rendering with the key `'api_key'` and a double quote, followed by 50 000 backslashes and no closing quote, when `redactVariableValue` is called, then it returns in under 1000 ms.
2. Given the name `blob` and the value `a_` repeated 40 000 times followed by `=x`, then it returns in under 1000 ms.

Expressions:

1. Given the expression `os.environ["OPENAI_API_KEY"]` and a single-quoted `sk-` key of 20 letters, when `redactExpressionResult` is called, then it is withheld (by its value shape; the expression is not a sensitive name).
2. Given the expression `dict(os.environ)` and a dict rendering containing a GitHub token, then it is withheld and the returned value does not contain the token.
3. Given the expression `len(items)` and the value `3`, then the value is `3`, not withheld.

Embedded carve-out (Arm):

1. Given the pairs `auth`=`1`, `token`=`42`, `secret`=`0`, `pass`=`3`, `sessionKey`=`7`, `apiKey`=`255`, when `redactVariableValue` is called, then none is withheld and each value is returned unchanged.
2. Given the name `privateKey` and each of `0x20000000`, `0xDEADBEEF`, `0b10110001`, `-1`, `3.14`, `1e-6`, then none is withheld.
3. Given `token` = `0x8000414 <main+8>`, then it is not withheld.
4. Given `password` = `12 '\f'` (digits, a space, and a quoted backslash-f char escape), then it is not withheld.
5. Given `apiToken` = `4294967295u`, then it is not withheld.
6. Given `apiKey` = a double-quoted `sk-` key of 20 letters, then it is withheld and the value is the placeholder.
7. Given `auth` = a double-quoted GitHub token, then it is withheld.
8. Given the SVD register names `KEY`, `KR`, `UNLOCK`, `KEYR`, `OPTKEYR`, `PRIVCFGR`, when `isSensitiveName` is called, then each returns false.

Recommended additions (not pinned today):

1. `redactVariableValue('pwd', null)` and `(…, undefined)` return `{ value: '', redacted: false }`; a whitespace-only value under `password` is returned unchanged.
2. `redactExpressionResult('apiKey', 'hunter2')` is withheld; `redactExpressionResult('process.env.API_KEY', 'hunter2')` is not (known bug 1).
3. Calling `looksLikeSecretValue` twice in a row on the same GitHub token returns true both times (no state between calls).
4. The placeholder under a non-sensitive name is returned unchanged and not withheld.
5. `5<x>` under `pwd` is withheld (no whitespace before the annotation); `5`, a tab and `<x>` is not.

Also pinned elsewhere, and must keep passing: `src/test/variableView.test.ts` (placeholder text in a listing; the notice's `NOTE: values matching` appears exactly once when something was withheld and not at all otherwise; a withheld value is never clipped).

## Constraints

- No imports: no `vscode`, no `logger` (the module logs nothing), no I/O, no module-level mutable state.
- Regular expressions: standard ECMAScript 2022, with the semantics of patterns without the `u` or `v` flag (which would widen case-insensitive `\b`).
- File header: the Arm Apache-2.0 block exactly as at the top of `src/core/toolRun.ts`, without the Microsoft line, in both the module and its test (ignore the stale "File Header" section of AGENTS.md). Remove `src/utils/secretRedaction.ts` and `src/test/secretRedaction.test.ts` from `DERIVED_FILES` in `src/test/provenance.test.ts` in the same change. Keep the test at its path so the `out/src/test/**/*.test.js` glob in `.vscode-test.mjs` picks it up.
- Implement from this spec, the Arm-authored consumers and tests, `package.json` (`redactSecrets` description), `CHANGELOG.md` and `docs/agent-resources/debug_instructions.md`; not from DebugMCP PR #119.
- TypeScript strict, ES2022, Node16 modules (CommonJS output); `npm run compile`, `npm run lint`, `npm test`, `npm run test:transport` and `npm run test:surface` must pass.
