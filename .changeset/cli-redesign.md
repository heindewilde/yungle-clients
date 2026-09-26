---
"yungle-cli": minor
---

A redesigned CLI.

- **Output** is calmer and clearer: a progress bar with speed and time left, tidy tables that fit your terminal, and results that finish with the next useful command. When piped it prints just the link, and `--json` still prints JSON.
- **Guided mode.** Run `yungle` on its own for a menu. Leave the paths off `yungle send`, or the link off `yungle get`, and it asks. It never prompts in scripts, in CI, or with `--json`/`--yes`.
- **Errors** say what happened and which command fixes it. Typos get a "did you mean" suggestion.
- **New commands:**
  - `yungle status` shows who opened and downloaded a transfer.
  - `yungle open` opens the dashboard, a transfer, or your keys, plan or webhooks.
  - `yungle watch <dir> --collection <id>` keeps uploading new files once they stop changing.
  - `yungle completion zsh|bash|fish` sets up tab completion.
  - `yungle whoami` shows who you're signed in as.
  - `yungle transfers`, `collections` and `contacts` list what you have.
  - `yungle revoke` stops a transfer's link.
- **Names:** commands accept the short ID from `yungle transfers` or a transfer's link. `yungle login --key` saves an API key. The old spellings (`auth login`, `ls transfers`, `rm transfer`) still work.
- **MCP:** `yungle mcp install` explains that the local server needs an API key, because a browser sign-in expires within the hour.
- **Emailing:** a browser sign-in makes links but never emails anyone. `yungle send --to` now checks this before uploading: at a terminal it offers to send a link instead, and in a script it stops before any bytes move. Use `yungle login --key` to email recipients.
