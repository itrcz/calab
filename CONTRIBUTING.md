# Contributing to Calab

Thanks for helping. Calab is licensed under the Business Source License 1.1 with a commercial license offered by GPTunneL.

## Contributor License Agreement (CLA)
By submitting a contribution you (a) certify that you have the right to submit it and (b) grant GPTunneL a perpetual, worldwide, irrevocable, royalty-free license to use, modify, sublicense and relicense your contribution under any license, including commercial licenses and the Change License (Apache-2.0). You retain copyright in your contribution. Add `Signed-off-by: Name <email>` to your commits (`git commit -s`) to confirm.

## Before you start
- Read `docs/01-architecture.md`, `docs/02-media.md` (echo-cancellation rules are non-negotiable) and `docs/08-design.md` (UI standard).
- Architectural decisions live in `docs/adr/`. Changing one = a new ADR.

## Workflow
1. Fork, branch from `main`.
2. `pnpm install && make gen` — generated code (`apps/server/gen`, `packages/protocol/src/gen`) is committed; CI fails on drift.
3. Run the checks you touched:
   - server: `make lint` (from the repo root — it runs golangci-lint with the repo config) and `cd apps/server && go test -race ./...`; `make test-integration` (needs `pnpm infra:dev`);
   - desktop: `pnpm -F @calaba/desktop typecheck lint test`, `e2e:visual` when UI changes (update snapshots deliberately).
4. Open a PR (the template asks for the checks you ran, screenshots for UI changes and the CLA checkbox). CI runs on every PR; a maintainer reviews — security-sensitive paths (auth, permissions, tokens, protocol) get a second review.

## Style
- Go: `gofmt`, `golangci-lint` config in `.golangci.yml`.
- TypeScript: strict, ESLint config in `apps/desktop`.
- Commit messages in English, imperative mood.
- UI strings live in `apps/desktop/src/renderer/i18n/<locale>/*.ts` (ru, en, es, zh-CN, de — add all five).
- Performance rules apply to every UI change: no `backdrop-filter`, no infinite animations, re-renders under control (see `CLAUDE.md` → «Производительность», `docs/14-energy.md`).

## Reporting bugs
Use GitHub Issues. For security issues see `SECURITY.md`.
