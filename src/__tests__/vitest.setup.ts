import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Global vitest setup — runs ONCE per test process, BEFORE any test file
 * or source module is imported.
 *
 * Pins `KOBO_HOME` to a unique temporary directory so every `getDb()` call
 * that doesn't receive an explicit path resolves to a disposable SQLite
 * file under `/tmp`, never under `$XDG_CONFIG_HOME/kobo/`. This is a hard
 * safety net: even a test that forgets to call `resetDb()` cannot mutate
 * the developer's real Kōbō database.
 *
 * We don't clean the directory at the end — vitest may still be writing
 * when the test hook fires and the OS wipes `/tmp` on reboot anyway.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `kobo-vitest-${process.pid}-`))
process.env.KOBO_HOME = tmpDir
