# Haanji

AI phone receptionist for a small manufacturer (S S Industries, Vasai: pins under the Suman brand). A local Ollama model talks to callers in Hindi, Marathi, Gujarati, English or a mix; code-level guards stop it from agreeing prices; leads land in a dashboard.

## Commands
- `npm test`: offline test suite (node:test; a fake Ollama server in `test/fake-ollama.ts`)
- `npm run typecheck`: `tsc --noEmit`
- `npm start`: server at http://127.0.0.1:5050 (needs `ollama serve` and the model from `HAANJI_MODEL`, default gemma3:4b)
- `npm run eval`: run `eval/cases.json` against the real model

## Code rules
- TypeScript run by Node's type stripping: no enums, namespaces or constructor parameter properties; use `import type` for types; relative imports end in `.ts`.
- Zero runtime dependencies. Node built-ins only; the browser UI is plain HTML/CSS/JS.
- The model never gets the last word on money: every reply goes through `src/guard.ts`. Add a guard test for every new rule.
- Prices come only from `catalog.json`. Notes in the catalog are for people, never sent to the model.
- Tests must not need the network or a real model.

## Git
- Commits are authored as Jay Maurya <maurya67jay@gmail.com>. Do not add co-author or "generated with" lines to commits or pull requests.
