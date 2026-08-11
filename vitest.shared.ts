import { configDefaults } from "vitest/config"

// Test taxonomy, mirrored from the ContextLayer monorepo. The filename declares
// what the config can't infer, along two orthogonal axes: the RUNTIME (node vs
// workerd vs a real chromium) and the TIER (unit = hermetic + runs on CI vs
// integration = needs a real local prerequisite, opt-in only):
//
//   *.test.ts                    → unit, node       → `test`
//   *.worker.test.ts             → unit, workerd    → `test`
//   *.browser.test.ts            → unit, chromium   → `test`
//   *.node.integration.test.ts   → node + service   → `test:integration:node`
//
// The unmarked unit name claims the default runtime: bare `*.test.ts` runs in
// plain node, in every package. `.worker.` and `.browser.` are the marked
// exceptions, for unit tests whose subject is coupled to that runtime (the
// registry's routes run inside workerd via @cloudflare/vitest-pool-workers; the
// embed script's DOM behavior needs a browser). A marked file in a package with
// no matching project still runs — in node, where it fails loud — so
// misplacement self-reports instead of silently not running. Only a package
// that actually runs a worker/browser project may exclude that marker from its
// node project.

export const unitTestInclude = ["**/*.test.ts"]

export const workerUnitTestInclude = ["**/*.worker.test.ts"]

export const browserUnitTestInclude = ["**/*.browser.test.ts"]

export const nodeIntegrationTestInclude = ["**/*.node.integration.test.ts"]

export const unitTestExclude = [...configDefaults.exclude, "**/*.integration.test.ts"]
