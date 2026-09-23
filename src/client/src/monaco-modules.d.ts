/**
 * Monaco ships its Monarch grammar registrations without type declarations:
 * the module is imported purely for its side effect of registering languages,
 * and exposes nothing. `editor.api` next to it is fully typed and is what the
 * code actually calls into.
 */
declare module 'monaco-editor/basic-languages/monaco.contribution.js'
