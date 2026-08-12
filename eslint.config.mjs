import stylistic from '@stylistic/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

const disabledCompatibilityRule = {
    meta: {
        type: 'problem',
        schema: [],
    },
    create: () => ({}),
}

const tsCompatibilityPlugin = {
    ...tsPlugin,
    rules: {
        ...tsPlugin.rules,
        'ban-types': disabledCompatibilityRule,
    },
}

export default [
    {
        ignores: [
            '**/builtin-plugins/**',
            '**/dist/**',
            '**/node_modules/**',
            '**/typings/**',
        ],
        linterOptions: {
            reportUnusedDisableDirectives: false,
        },
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: {
            '@stylistic': stylistic,
            '@typescript-eslint': tsCompatibilityPlugin,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', {
                vars: 'all',
                args: 'after-used',
                argsIgnorePattern: '^_',
                caughtErrors: 'none',
                varsIgnorePattern: '^_$',
            }],
            '@stylistic/semi': ['error', 'never'],
            '@stylistic/indent': ['error', 4],
            '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
            '@stylistic/array-bracket-spacing': ['error', 'never'],
            '@stylistic/computed-property-spacing': ['error', 'never'],
            'block-scoped-var': 'error',
            'eol-last': 'error',
            'eqeqeq': ['error', 'smart'],
            'max-depth': ['warn', 5],
            'max-statements': ['warn', 80],
            'no-duplicate-imports': 'error',
            'no-mixed-spaces-and-tabs': 'error',
            'no-multiple-empty-lines': 'error',
            'no-trailing-spaces': 'error',
            'no-var': 'error',
        },
    },
]
