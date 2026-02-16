# AGENTS.md

## Scope

This directory is a standalone CLI package:

- Name: `llm-chatwork-reader-writer`
- Entry: `src/cli.mjs`
- API layer: `src/chatwork-client.mjs`

## Commands

```powershell
node src/cli.mjs --help
node src/cli.mjs me
node src/cli.mjs rooms
node src/cli.mjs read --room 123456 --jsonl
node src/cli.mjs write --room 123456 --message "Hello"
```

## Token

Use one of:

1. `--token <token>`
2. `CHATWORK_API_TOKEN`
3. `CHATWORK_TOKEN`
4. `--env-file <path>`

## LLM-friendly usage

- Use `read --json` for array JSON output.
- Use `read --jsonl` for streaming pipelines.
- Use `write` with stdin for generated content:
  - `"generated text" | node src/cli.mjs write --room 123456`
