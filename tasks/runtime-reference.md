# Autobot Runtime Reference

Runtime guardrail document for cleanup work. If a file or directory is mounted, imported, or started from the paths below, do not archive it until those references are removed.

## Primary Entrypoint

- `server.js`: the canonical backend entrypoint in `package.json`

## Startup Imports In `server.js`

These imports are part of boot and should be treated as active:

- `./services/database`
- `./services/event-bus`
- `./services/cron-service`
- `./services/discord-service`
- `./queues/email-queue`

## Static Serving

- `/api/screenshots` -> local filesystem screenshots directory via `express.static('/data/screenshots')`
- `/` -> static dashboard build under `dashboard/out`

## Mounted Route Aggregators

These route files are mounted directly in `server.js` and are active until their mount is removed:

- `/webhooks` -> `routes/webhooks`
- `/api` -> `routes/api`
- `/api/test` -> `routes/test`
- `/api/requests` -> `routes/requests`
- `/api/agencies` -> `routes/agencies`
- `/api` -> `routes/run-engine`
- `/api/portal-tasks` -> `routes/portal-tasks`
- `/api/shadow` -> `routes/shadow-mode`
- `/api/cases` -> `routes/cases`
- `/api/monitor` -> `routes/monitor`
- `/api/phone-calls` -> `routes/phone-calls`
- `/api/users` -> `routes/users`
- `/api/auth` -> `routes/auth`
- `/api/cases` -> `routes/case-agencies`
- `/api/eval` -> `routes/eval`
- `/api/simulate` -> `routes/simulate`
- `/api/admin` -> `routes/admin`
- `/api/events` -> server-level SSE handler using `services/event-bus`

## Special Cleanup Notes

- `routes/test.js` is still mounted and in turn mounts `routes/test/notion`, `email`, `cases`, `portal`, `decisions`, `fees`, `status`, `db-ops`, `simulation`, `ai-research`, `data-fixes`, and `e2e`. None of those test routes are safe to archive until `/api/test` is disabled or guarded behind a dev-only check.
- `routes/api.js` is still mounted at `/api`, so it is compatibility-heavy but live.
- `dashboard/out` is served directly by `server.js`; cleanup of dashboard build scripts should not break that path.
- `migrations/` is active because `server.js` runs SQL files from that directory at startup.

## Package Script Entrypoints

These files are referenced directly by `package.json` and should be treated as active:

- `server.js`
- `database/migrate.js`
- `test-setup.js`
- `tests/`
- `scripts/test-prompt-suite.js`
- `tests/e2e/production-readiness.test.js`
- `tests/e2e/api-prompt-e2e.test.js`
- `tests/golden-cases/golden.test.js`
- `tests/golden-runner.js`
- `tests/load/staging-load-test.js`
- `dashboard/package.json`

## Archive Move Rules

Before moving a file to `.old/`, confirm all of the following:

1. It is not imported by `server.js`, a mounted route aggregator, or a Trigger task.
2. It is not referenced by any `package.json` script in the root or `dashboard/`.
3. It is not a migration under `migrations/`.
4. It is not part of the dashboard static build or assets served by the backend.
5. If it is a test or debug helper, there is already a canonical replacement documented in `guide.md` or `tasks/repo-inventory.md`.
