# Yungle for Chrome and Firefox

Send big files from the browser toolbar, and add a Yungle link while writing in Gmail or Outlook on the web. One Manifest V3 codebase ([WXT](https://wxt.dev) + React) builds for Chromium (Chrome, Edge, Brave) and Firefox.

## What it can reach, and why

| Permission | Why |
|---|---|
| `https://yungle.co/*` | To sign in, and to send. It is the only host the extension requires. |
| `storage` | The sign-in and your settings. |
| `notifications` | To say "your files are ready" when you have looked away. |
| `scripting` | To add the compose button, and only on the sites you allowed. |
| `sidePanel` (Chrome) | The panel where uploads run. A toolbar popup would stop the upload when it closes. |
| Gmail, Outlook (**optional**) | Asked for when you turn the compose button on. They are never listed in the manifest's required permissions: CI fails the release if they are. |

It never reads your email. The compose button only writes one link into the message you are typing, when you ask it to.

## How the pieces fit

- **Sign-in:** authorization code + PKCE against yungle.co's OAuth server. The client id is `yungle-extension`, which is first-party.
  - The redirect goes to yungle.co's own `/extension/connected`, not to `identity.launchWebAuthFlow`. Yungle signs in by magic link, which finishes in a new tab opened from the email, so the background watches every tab for that page.
  - Token refresh is single-flight across all extension pages (a Web Lock). The server revokes the whole grant if a refresh token is presented twice.
- **Sending:** `lib/send.ts` uses the `yungle-client` SDK and tus. An end-to-end encrypted send goes through `yungle-e2e`:
  - the key is made here and only ever appears in the link's `#fragment`
  - file names are sealed after the server has minted each file's id
- **Billing:** uploads through the extension are billed like the website (plan limits), not metered as API usage. The server decides this from the OAuth client id.
- **Compose button:** `content/adapters.ts` finds compose editors, and it is the part that breaks when Gmail or Outlook change their markup.
  - The dialog is an extension-origin iframe (`compose.html`) in a closed shadow root.
  - It posts the finished link back, and `content/mount.ts` inserts it at the caret as a small table card or a plain line.

## Develop

```sh
pnpm dev            # Chrome, pointed at https://yungle.co
pnpm dev:firefox
pnpm test           # the pure modules (vitest)
```

Point a build at a local server with `WXT_YUNGLE_ORIGIN` and `WXT_YUNGLE_TUS_ORIGIN`.

## Browser tests

`pnpm e2e` runs Playwright with the unpacked extension in Chromium, against a local Yungle server checkout. `YUNGLE_SERVER_DIR` defaults to `../../../yungle-extension`, and that checkout's `.env.dev` must run the web app on `:3002` and upload-svc on `:4002`.

```sh
pnpm e2e:build && pnpm e2e
```

The suite covers:
- the real consent round-trip
- a plain send
- emailing recipients
- an end-to-end encrypted send, which a second page opens with the key from the fragment
- the Gmail button on a stand-in page

It does **not** cover:
- live Gmail or Outlook markup
- the magic-link email itself
- Firefox, which Playwright cannot load extensions into (`npx web-ext lint -s .output/firefox-mv3` is the check there)

## Release

Bump `version` in `package.json`, then tag `extension-v<version>`. CI builds the Chrome and Firefox zips and the AMO source zip, and attaches them to a GitHub release. Submission to the Chrome Web Store and Firefox Add-ons is manual.

Fonts: the site's Pally and Satoshi are not bundled, because their licence forbids distributing the files. Text uses the system font, and the wordmark is an image.

## Reproducing the Firefox build (for AMO review)

The source zip is the whole `yungle-clients` repository. From its root:

```sh
corepack enable          # pnpm 9, as pinned in package.json
pnpm install --frozen-lockfile
pnpm --filter yungle-extension build
# → apps/extension/.output/firefox-mv3/
```

Node 22 or later. Nothing is fetched at build time beyond the npm packages in the lockfile.
