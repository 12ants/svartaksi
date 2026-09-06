# Repository Guidelines

## Project Structure & Module Organization

Svartaksi is a Three.js/React driving game with a city streamed from OpenStreetMap.

- `src/svartaksi/`: game runtime, vehicles, characters, and configuration.
- `src/world/`: terrain, roads, props, and world streaming.
- `src/physics/`: custom rigid-body solver, raycast vehicles, and character controller.
- `src/components/`, `src/hooks/`: React HUD and overlays; `src/author/`: authoring tools.
- `src/models/`: bundled GLB assets; `vendor/worldcache/`: cached opening-area data.
- `tests/`: suites organized by source domain; `src/test/setup.ts`: shared setup.
- `design/`, `docs/architecture/`, `production/`: design documents, architecture decisions, and session records.

## Build, Test, and Development Commands

Use pnpm; `package.json` pins version 11.20.0 and rejects npm/yarn installation.

- `pnpm install`: install dependencies.
- `pnpm dev`: start Vite at `http://localhost:7777`.
- `pnpm lint`: run ESLint, including TypeScript and React Hooks rules.
- `pnpm typecheck`: check strict TypeScript without emitting files.
- `pnpm test` / `pnpm test:watch`: run Vitest once or interactively.
- `pnpm test:all`: run lint, type checking, and tests before declaring implementation complete.
- `pnpm build`: generate the production bundle in `dist/`.

## Coding Style & Naming Conventions

Match existing two-space indentation, single quotes, and semicolons. Use PascalCase for React components, camelCase for functions and module filenames, and `use` prefixes for hooks. ESLint is configured; no separate formatter is configured.

Document public APIs and explain decisions in comments. Give constants units and a rationale; keep gameplay tuning in configuration. Put arithmetic in pure, testable modules with thin scene bindings. Preserve the custom physics architecture. Record new system decisions in `docs/architecture/`.

## Testing Guidelines

Use Vitest with jsdom and React Testing Library. Mirror source domains with `*.test.ts` or `*.test.tsx`, matching `vitest.config.ts`; for example, `pnpm test -- tests/world/geo.test.ts`.

Test new pure logic and regressions with deterministic, isolated cases. No numeric coverage threshold is configured. Validate rendering and feel manually; do not add Playwright, Puppeteer, or screenshot automation unless requested.

## Commit & Pull Request Guidelines

History mixes timestamp checkpoints with descriptive commits. Follow the documented Conventional Commits policy: `feat:`, `fix:`, `test:`, `docs:`, or `refactor:`. Reference the relevant design document or task/story ID in the body.

PRs should describe the behavior change, link related tasks, and report validation results. Include manual verification notes or screenshots for visible changes, and update affected design or architecture documents.
