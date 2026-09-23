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
import * as policy from '../utils/secretRedaction';

const PLACEHOLDER = policy.REDACTION_PLACEHOLDER;

/** A comma-separated fixture list, so long lists stay on one readable line. */
const list = (items: string): string[] => items.split(', ');

/**
 * Fake credentials, assembled at run time so that no source line holds a
 * complete token for a secret scanner to trip over. Each one only has to
 * satisfy the shape the module looks for.
 */
const fake = {
    awsKeyId: 'AK' + 'IA' + 'Q7ZC2EXAMPLE0FAKE',
    githubClassic: 'gh' + 'p_' + 'Fa4e0nlyForTest1ng'.repeat(2),
    githubFineGrained: 'github' + '_pat_' + '11AFAKE0000_notARealTokenAtAll42',
    slackBot: 'xo' + 'xb-' + '2024000000001-notarealslacktoken',
    googleApiKey: 'AI' + 'za' + 'SyFAKE_placeholder-value0123456789Ab',
    anthropicStyle: 'sk-' + 'ant-api03-' + 'NotARealKeyJustTestData42',
    stripeLive: 'sk' + '_live_' + 'FakeStripeKey0000test',
    npm: 'np' + 'm_' + 'FakeNpmTokenForUnitTests0123456789',
    gitlab: 'gl' + 'pat-' + 'Fake_GitLab-Token42',
    jwt: 'ey' + 'JhbGciOiJub25lIn0' + '.' + 'eyJzdWIiOiJ0ZXN0In0' + '.' + 'c2lnbmF0dXJl',
    pem: ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'VGhpcyBpcyBub3QgYSBrZXk=', '-----END RSA ' + 'PRIVATE KEY-----'].join('\n'),
    bearer: 'Bear' + 'er ' + 'opaque.test.value.0123',
    skLetters: 'sk-' + 'abcdefghijklmnopqrst',
};

type Verdict = { value: string; redacted: boolean };

/** The verdict hides the value behind the placeholder. */
function expectHidden(verdict: Verdict, context: string): void {
    assert.deepStrictEqual(verdict, { value: PLACEHOLDER, redacted: true }, `${context}: should be withheld`);
}

/** The verdict shows `shown`, unchanged. */
function expectShown(verdict: Verdict, shown: string, context: string): void {
    assert.deepStrictEqual(verdict, { value: shown, redacted: false }, `${context}: should stay visible`);
}

function expectNameVerdict(names: string[], sensitive: boolean): void {
    names.forEach(n => assert.strictEqual(policy.isSensitiveName(n), sensitive, `isSensitiveName(${JSON.stringify(n)})`));
}

/** A variable of this name holding this value keeps it. */
function variableKeeps(name: string, value: string): void {
    expectShown(policy.redactVariableValue(name, value), value, `${name} = ${JSON.stringify(value)}`);
}

/** Wall-clock milliseconds of one variable verdict. */
function millisToJudge(name: string, value: string): number {
    const t0 = process.hrtime.bigint();
    policy.redactVariableValue(name, value);
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

suite('Redaction policy — which names are credentials', () => {

    test('well-known credential names in several spellings match', () => {
        expectNameVerdict(list('apiKey, API_KEY, api-key, openai_api_key, secret, clientSecret, password, passwd, pwd'), true);
        expectNameVerdict(list('passphrase, accessToken, refresh_token, credentials, privateKey, AUTHORIZATION'), true);
        expectNameVerdict(list('connectionString, connStr, cookie, sessionKey, encryptionKey, sasToken, otp, bearerToken'), true);
    });

    test('everyday identifiers do not match', () => {
        expectNameVerdict(list('author, count, userName, result, items, index, config'), false);
    });

    test('the match is on the whole name, not on a word inside it', () => {
        expectNameVerdict(list('tokenCount, cookieCount, tokenIndex, secretCount, hasToken, passwordLength, tokenizer, subtokens'), false);
    });

    test('letter case, underscore, hyphen and space are ignored', () => {
        expectNameVerdict(list('API_KEY, api-key, apiKey, ApiKey, api key'), true);
    });

    test('tokenCount = 42 is shown', () => {
        variableKeeps('tokenCount', '42');
    });
});

suite('Redaction policy — credential shapes in the value', () => {

    test('a sample of every supported shape is caught', () => {
        Object.entries(fake).forEach(([kind, sample]) =>
            assert.ok(policy.looksLikeSecretValue(sample), `${kind} sample not caught`));
    });

    test('plain text, paths, numbers and addresses are not caught', () => {
        list('42, hello world, /usr/local/bin, None, user@example.com').forEach(sample =>
            assert.ok(!policy.looksLikeSecretValue(sample), `${sample} caught by mistake`));
    });

    test('a second look at the same token gives the same answer', () => {
        const answers = [1, 2].map(() => policy.looksLikeSecretValue(fake.githubClassic));
        assert.deepStrictEqual(answers, [true, true]);
    });
});

suite('Redaction policy — variable values', () => {

    test('a quoted project key held by api_key', () => {
        expectHidden(policy.redactVariableValue('api_key', `'sk-proj-${'Zq8'.repeat(8)}'`), 'api_key');
    });

    test('a token is caught by its shape under a meaningless name', () => {
        expectHidden(policy.redactVariableValue('x', fake.githubClassic), 'x');
    });

    test('nothing to hide: empty or null-like values under api_key', () => {
        for (const value of ['None', 'null', 'undefined', '', "''", '0', 'False']) {
            variableKeeps('api_key', value);
        }
    });

    test('null and undefined render as an empty string', () => {
        expectShown(policy.redactVariableValue('pwd', null), '', 'pwd = null');
        expectShown(policy.redactVariableValue('pwd', undefined), '', 'pwd = undefined');
    });

    test('blanks under password are kept as they are', () => {
        variableKeeps('password', '   ');
    });

    test('userCount = 42 is shown', () => {
        variableKeeps('userCount', '42');
    });

    test('fields of a structure are not judged one by one', () => {
        variableKeeps('config', "{host = 'db.local', password = 'letmein'}");
    });

    test('the structure named credentials is hidden, however bland its fields', () => {
        expectHidden(policy.redactVariableValue('credentials', "{user = 'alice', retries = 3}"), 'credentials');
    });

    test('an environment listing with a token in it is hidden', () => {
        const listing = `{'HOME': '/home/dev', 'GH_TOKEN': '${fake.githubClassic}', 'LANG': 'C'}`;
        expectHidden(policy.redactVariableValue('environ', listing), 'environ');
    });

    test('hiding an already hidden value is a no-op', () => {
        const once = policy.redactVariableValue('api_key', fake.githubClassic).value;
        const twice = policy.redactVariableValue('api_key', once).value;
        assert.strictEqual(twice, once);
        assert.strictEqual(twice.split(PLACEHOLDER).length, 2, 'the placeholder appears exactly once');
    });

    test('the placeholder itself under an innocent name is left alone', () => {
        variableKeeps('note', PLACEHOLDER);
    });
});

suite('Redaction policy — pathological values finish quickly', () => {

    test('50 000 backslashes after an opening quote', () => {
        const ms = millisToJudge('blob', `{'api_key': "${'\\'.repeat(50_000)}`);
        assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    });

    test('40 000 "a_" pairs and then "=x"', () => {
        const ms = millisToJudge('blob', `${'a_'.repeat(40_000)}=x`);
        assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
    });
});

suite('Redaction policy — evaluate_expression results', () => {

    test('an OPENAI_API_KEY lookup returning an sk- key is hidden by the value', () => {
        expectHidden(policy.redactExpressionResult('os.environ["OPENAI_API_KEY"]', `'${fake.skLetters}'`), 'os.environ lookup');
    });

    test('a dict of the environment with a token is hidden and the token does not leak', () => {
        const verdict = policy.redactExpressionResult('dict(os.environ)', `{'PATH': '/usr/bin', 'GITHUB_TOKEN': '${fake.githubClassic}'}`);
        expectHidden(verdict, 'dict(os.environ)');
        assert.ok(!verdict.value.includes(fake.githubClassic));
    });

    test('len(items) = 3 is shown', () => {
        expectShown(policy.redactExpressionResult('len(items)', '3'), '3', 'len(items)');
    });

    test('only a bare credential name counts as a name', () => {
        expectHidden(policy.redactExpressionResult('apiKey', 'hunter2'), 'apiKey');
        // Known limitation: a qualified lookup is caught only by the value's shape.
        expectShown(policy.redactExpressionResult('process.env.API_KEY', 'hunter2'), 'hunter2', 'process.env.API_KEY');
    });
});

suite('Redaction policy — firmware numbers are always shown', () => {

    test('small integers under credential-like names', () => {
        const pairs: Array<[string, string]> = [['auth', '1'], ['token', '42'], ['secret', '0'], ['pass', '3'], ['sessionKey', '7'], ['apiKey', '255']];
        pairs.forEach(([name, value]) => variableKeeps(name, value));
    });

    test('hex, binary, signed, fractional and exponent forms under privateKey', () => {
        list('0x20000000, 0xDEADBEEF, 0b10110001, -1, 3.14, 1e-6').forEach(value => variableKeeps('privateKey', value));
    });

    test('GDB symbol annotation after an address', () => {
        variableKeeps('token', '0x8000414 <main+8>');
    });

    test('GDB char annotation after a number', () => {
        variableKeeps('password', "12 '\\f'");
    });

    test('C unsigned suffix', () => {
        variableKeeps('apiToken', '4294967295u');
    });

    test('an annotation counts only with whitespace before it', () => {
        expectHidden(policy.redactVariableValue('pwd', '5<x>'), '5<x>');
        variableKeeps('pwd', '5\t<x>');
    });

    test('a double-quoted sk- key under apiKey is still hidden', () => {
        expectHidden(policy.redactVariableValue('apiKey', `"${fake.skLetters}"`), 'apiKey');
    });

    test('a double-quoted GitHub token under auth is still hidden', () => {
        expectHidden(policy.redactVariableValue('auth', `"${fake.githubClassic}"`), 'auth');
    });

    test('watchdog and flash-unlock register names are not credentials', () => {
        expectNameVerdict(list('KEY, KR, UNLOCK, KEYR, OPTKEYR, PRIVCFGR'), false);
    });
});
