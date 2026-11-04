# Foundation validation

Validated locally on 2 November 2026 on Windows with Node 22.17.1 and npm 10.9.2.

| Check                      | Actual result                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                   | Passed; lockfile installs cleanly                                                                                                                     |
| `npm ls --depth=0`         | Passed; no invalid direct peer dependencies reported                                                                                                  |
| `npm run typecheck`        | Passed with strict compiler settings                                                                                                                  |
| `npm run lint`             | Passed with zero warnings                                                                                                                             |
| `npm run format:check`     | Passed                                                                                                                                                |
| `npm test`                 | Exits successfully; no unit test files exist yet                                                                                                      |
| `npm run build`            | Passed; production output generated in `dist`                                                                                                         |
| `npm run test:e2e:install` | Chromium and required Playwright components installed                                                                                                 |
| `npm run test:e2e`         | 1 Chromium smoke test passed; shell visible and no uncaught page errors                                                                               |
| `npm audit --omit=dev`     | Zero production dependency vulnerabilities reported                                                                                                   |
| `npm audit`                | 12 moderate findings in development tooling, rooted in the minimatch globparts amplification advisory and propagated through ESLint/typescript-eslint |
| Master plan preservation   | Original and project copy have identical SHA-256 hashes                                                                                               |

The development dependency audit is not clean. The audit lists the minimatch advisory `GHSA-g3hv-75wg-m249`; the installed current lint toolchain still depends on affected minimatch versions. No force downgrade or unsupported major transitive override was applied. Revisit compatible upstream updates before release.

Vitest temporarily has `passWithNoTests: true` for the foundation-only stage; remove that allowance once Agent 1 supplies core tests. Browser coverage currently verifies startup only. Whiteboard acceptance journeys, recording fallback, cross-browser coverage and performance measurements remain future work.

The CI workflow is configured locally and has not executed remotely. A local Git repository was initialized on `main`; no commit, remote, publication or deployment was created.
