# Temporary deepmerge security patch

The bundled CommonJS distribution of upstream deepmerge 4.3.1 is retained under
its MIT license. GHSA-gcqx-w48m-w2h4 has no published fixed release at the time
of this change. Only `@rollup/plugin-node-resolve` in the PWA build uses this override.

The patch defines own data properties instead of assigning object keys. An own
`__proto__` key in either operand can therefore never invoke the inherited setter
and change the returned object's prototype. Array merging, symbols, cloning and
custom merge options retain upstream behavior. The local package name/version
identify our patch; they do not claim an upstream release.

Remove this directory and the override when a fixed upstream version is available.
Regression tests: `src/__tests__/deepmerge-security.test.ts`.

Advisory: https://github.com/advisories/GHSA-gcqx-w48m-w2h4
Upstream: https://github.com/TehShrike/deepmerge/tree/v4.3.1
