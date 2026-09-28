# yungle-e2e

The end-to-end encryption core behind [Yungle](https://yungle.co)'s encrypted transfers and vault, published so anyone can read exactly what runs in their browser.

The key is made in your browser. Yungle stores only ciphertext, and never sees the key or your file names.

- **Format:** files are cut into fixed-size segments, and each segment is sealed on its own with AES-256-GCM.
  - A short self-describing header is bound into every segment's authenticated data, so a server that edits it produces a file that fails to open rather than one that opens to something else.
  - Any byte offset maps to a segment by arithmetic alone. That is what lets an upload resume in the middle of a file it is encrypting on the fly.
- **Keys:** one random master key per transfer, which travels only in the link's `#fragment`. Per-file keys and nonce prefixes are derived from it with HKDF.
  - Nonce prefixes are never random. A regenerated random prefix on resume would reuse a nonce under the same key.
- **Metadata:** file names, types, folder paths and the message are sealed as JSON under a key derived for that purpose. They are bound to the transfer, so a blob cannot be moved to another one.

This package depends on WebCrypto only. It runs in browsers and in Node 22+.

It is Yungle's format, not a general-purpose file-encryption library: use it to read or produce Yungle transfers. The server applies its own envelope encryption on top of this ciphertext and treats it as opaque bytes.

## Install

```sh
npm i yungle-e2e
```

MIT licensed. Issues: https://github.com/heindewilde/yungle-clients/issues
