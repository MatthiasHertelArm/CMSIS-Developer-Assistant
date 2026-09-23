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

// Lint configuration for `npm run lint` (`eslint src`), which is also the
// `pretest` step and the CI lint job. Every rule is a warning, so the run
// never fails on them. No type-aware rules: nothing here needs a tsconfig.

import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const WARN = 'warn';

/** Import bindings are camelCase (`import * as vscode`) or PascalCase. */
const importBindings = { selector: 'import', format: ['camelCase', 'PascalCase'] };

export default [
    // TypeScript sources are linted too, next to the JavaScript extensions ESLint picks up itself.
    { files: ['**/*.ts'] },
    // No `files` key: parser and rules apply to every linted file, JavaScript included.
    {
        plugins: { '@typescript-eslint': tsPlugin },
        languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
        rules: {
            '@typescript-eslint/naming-convention': [WARN, importBindings],
            curly: WARN,
            eqeqeq: WARN,
            'no-throw-literal': WARN,
            semi: WARN,
        },
    },
];
