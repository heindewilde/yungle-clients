# yungle-cli

Send, receive and sync large files with [Yungle](https://yungle.co?ref=npm) from your terminal
or CI. Resumable uploads up to 100 GB, private and EU-hosted.

<img src="https://raw.githubusercontent.com/heindewilde/yungle-clients/main/.github/assets/demo.svg" alt="yungle send, yungle status and yungle get in a terminal" width="720">

```bash
npm install -g yungle-cli
yungle login                  # opens your browser, once
yungle send ~/Shoot           # uploads resumably, prints the link
```

Works on the free plan. Node 22 or newer.

## Commands

**Get started**

| | |
|---|---|
| `yungle login` | Sign in with your browser. `--key` uses an API key instead (servers, CI) |
| `yungle whoami` | Who you are signed in as, and what you may do |
| `yungle logout` | Sign out and revoke the session |

**Send and receive**

| | |
|---|---|
| `yungle send <paths…>` | Send files or folders and print the link. `--to`, `--message`, `--title`, `--password`, `--expires` |
| `yungle get <link>` | Download a transfer sent to you. No account needed. `--out`, `--zip`, `--password` |
| `yungle status [<id\|link>]` | Who opened and downloaded a transfer. Without an id, pick from your recent ones |
| `yungle transfers` | Your recent transfers |
| `yungle revoke <id>` | Stop a transfer's link for good (asks first) |

**Collections** (paid plans)

| | |
|---|---|
| `yungle push <paths…> --collection <id>` | Upload into a collection, optionally `--folder <id>` |
| `yungle watch <dir> --collection <id>` | Keep uploading new files as they appear |
| `yungle collections` | Your collections |
| `yungle contacts` | Your contacts |

**Everything else**

| | |
|---|---|
| `yungle open [<id>\|plan\|keys\|webhooks]` | Open the dashboard, or a transfer, in your browser |
| `yungle webhooks ls` · `listen` | List endpoints, or print events live and `--forward-to` a local server |
| `yungle mcp install` · `status` | Connect a local AI assistant (see below) |
| `yungle completion <zsh\|bash\|fish>` | Tab completion |

Ids can be shortened: the last 6–8 characters of a transfer id, or its link, work everywhere
an id does. `yungle <command> --help` shows examples. Old spellings (`auth login`,
`ls transfers`, `rm transfer`) keep working.

## For people, and for scripts

The same command behaves right in both places:

| | At a terminal | In a pipe or CI | With `--json` |
|---|---|---|---|
| Output | Colour, tables, a live progress bar | Plain text; `send` prints only the link | One JSON object on stdout |
| Missing arguments | Asks, step by step | Fails with a usage hint | Fails with a usage hint |
| Confirmations | Asks | Never asks | Never asks |

Progress always goes to stderr, so `yungle send dist/ | pbcopy` copies just the link and
`yungle send dist/ --json | jq -r .url` works. `--yes` means "never ask", for scripts that run at
a terminal. `NO_COLOR` and `FORCE_COLOR` are respected.

Every error says what happened and the command that fixes it:

```
✖ Your sign-in is no longer valid (revoked, expired or mistyped).
→ yungle login
```

Exit codes: `0` success, `1` failure, `2` usage error, `130` cancelled.

## Resuming

Interrupt `yungle send` (Ctrl-C, a dropped connection, a closed lid) and run the same command
again: it continues from the last committed part instead of starting over.

State lives in `~/.cache/yungle/`, keyed by the local files' paths, sizes and modification
times, since that is all the next run has to go on. Change a file and it starts over, because
a resumed upload whose declared size no longer matches would fail at the very end. Sessions
expire after two hours, matching the upload tokens they hold.

## Watching a folder

```bash
yungle watch ~/Renders --collection 01J8Z3M9Q0W4
```

For a render box writing frames, a card reader, an export folder. It polls (every 10 seconds,
`--interval` to change) rather than using file-system events, which are unreliable on network
shares and external drives. A file is uploaded only once it has stopped changing, so a
half-written frame never goes up. What was uploaded is remembered, so a restart never uploads
twice. Files already there when it starts are left alone unless you pass `--existing`.

## Signing in

`yungle login` opens your browser, you confirm a code, done. The session is stored in
`~/.config/yungle/config.json` (mode `0600`) and renews itself.

**A browser sign-in makes links but never emails anyone.** Signing in by code can be phished
("enter this code" is the whole attack), so that session can't make Yungle mail strangers or
register a webhook. `yungle send --to` notices before uploading and offers to send a link
instead.

To email recipients, and on servers or in CI, use an API key: `yungle login --key` (asks for
it) or set `YUNGLE_API_KEY`, which always wins over the config file. Create keys under
[Settings → API keys](https://yungle.co/dashboard/settings/api) or with `yungle open keys`.

## Connecting a local AI assistant

The easiest way to connect Claude or Cursor is the hosted server at `https://yungle.co/mcp`:
add it in the client and sign in, no key involved.

To run the MCP server locally instead:

```bash
yungle login --key          # a read-only key is best
yungle mcp install          # or --client claude-code, --dry-run
```

This writes the [Yungle MCP server](https://www.npmjs.com/package/yungle-mcp) into Claude
Desktop, Claude Code, Cursor and Windsurf, whichever you have. Restart the client afterwards.

- **It wants a real API key**, not a browser session, which expires within the hour. The key
  ends up in the client's config file in plain text, which is how local MCP servers receive
  credentials.
- **It refuses a key that can write** unless you pass `--allow-write`, which lets the assistant
  create share links (every one still needs your confirmation).
- **A config file that does not parse is refused, never overwritten.** It holds your other
  MCP servers too. The previous contents are copied to `<config>.yungle-bak` before any change.

## What it cannot do

Your vault and end-to-end encrypted transfers are not reachable: their keys are derived in the
browser and never sent to Yungle. `yungle get` on an end-to-end encrypted link says so and
points you to the browser. See <https://yungle.co/developers/unsupported>.

Docs: <https://yungle.co/developers/cli?ref=npm> · Source: <https://github.com/heindewilde/yungle-clients> · MIT
