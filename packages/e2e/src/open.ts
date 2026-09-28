/**
 * Reading the format back: ciphertext in, plaintext out, one segment at a time.
 *
 * Used on the recipient's side of a transfer and on every Vault download. The
 * stream is consumed sequentially, so peak memory is one segment (1 MiB) plus
 * whatever the consumer is doing with the output — a 100 GB file opens in the
 * same footprint as a 1 MB one.
 */

import { HEADER_LEN, TAG_LEN, openSegment, readHeader, type Bytes, type E2eHeader } from './format';

/** FIFO over incoming chunks, so we can take exact byte counts across boundaries. */
class ByteQueue {
  private chunks: Bytes[] = [];
  private size = 0;

  get length(): number {
    return this.size;
  }

  push(chunk: Bytes): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  /** Remove and return exactly `n` bytes. Caller must check `length` first. */
  take(n: number): Bytes {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const head = this.chunks[0]!;
      const need = n - written;
      if (head.length <= need) {
        out.set(head, written);
        written += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), written);
        this.chunks[0] = head.subarray(need);
        written = n;
      }
    }
    this.size -= n;
    return out;
  }

  /** Everything left, in order. */
  drain(): Bytes {
    return this.take(this.size);
  }
}

export interface OpenInit {
  key: CryptoKey;
  /**
   * The prefix derived from (master, fileId). Checked against the one in the
   * header — the AAD binding would catch a mismatch anyway, but as an
   * unopenable-file error rather than "this is not your file".
   */
  noncePrefix?: Bytes;
}

function sameBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Ciphertext chunks in → plaintext chunks out. Yields the header alongside the
 * first plaintext so callers can learn the true size before deciding what to do
 * with the body (save picker vs Blob, progress bar totals).
 */
export async function* openCiphertext(
  source: AsyncIterable<Bytes>,
  init: OpenInit,
  onHeader?: (h: E2eHeader) => void,
): AsyncGenerator<Bytes> {
  const queue = new ByteQueue();
  let header: Bytes | null = null;
  let meta: E2eHeader | null = null;
  let sealedSegmentSize = 0;
  let index = 0;
  let produced = 0;

  for await (const chunk of source) {
    queue.push(chunk);

    if (!header) {
      if (queue.length < HEADER_LEN) continue;
      header = queue.take(HEADER_LEN);
      meta = readHeader(header);
      if (init.noncePrefix && !sameBytes(init.noncePrefix, meta.noncePrefix)) {
        throw new Error('e2e nonce prefix mismatch — wrong key for this file');
      }
      sealedSegmentSize = meta.segmentSize + TAG_LEN;
      onHeader?.(meta);
    }

    // Hold back the final segment: it is short, and we cannot tell a short
    // trailing segment from an incomplete full one until the stream ends.
    while (queue.length > sealedSegmentSize) {
      const plain = await openSegment(init.key, header, index++, queue.take(sealedSegmentSize));
      produced += plain.length;
      yield plain;
    }
  }

  if (!header || !meta) {
    // A zero-byte plaintext is still a valid object: header, no segments.
    throw new Error('e2e object truncated before its header');
  }

  while (queue.length > 0) {
    const n = Math.min(queue.length, sealedSegmentSize);
    const plain = await openSegment(init.key, header, index++, queue.take(n));
    produced += plain.length;
    yield plain;
  }

  // Per-segment tags catch modification and reorder but never a dropped
  // trailing segment. This is what catches that — and `plainLen` is
  // authenticated, because the header is in every segment's AAD.
  if (produced !== meta.plainLen) {
    throw new Error(`e2e length mismatch: opened ${produced}, header declares ${meta.plainLen}`);
  }
}

/** Browser-facing wrapper: `ReadableStream` in, `ReadableStream` out. */
export function decryptToStream(
  source: ReadableStream<Bytes>,
  init: OpenInit,
  onHeader?: (h: E2eHeader) => void,
): ReadableStream<Bytes> {
  const iterator = openCiphertext(readableToAsyncIterable(source), init, onHeader);
  return new ReadableStream<Bytes>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      void iterator.return?.(undefined);
    },
  });
}

/**
 * `ReadableStream` is only async-iterable in some engines (not Safari as of
 * writing), so iterate the reader by hand rather than relying on it.
 */
async function* readableToAsyncIterable(
  stream: ReadableStream<Bytes>,
): AsyncGenerator<Bytes> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Open a whole object already in memory. For small things only. */
export async function openCiphertextBytes(
  bytes: Bytes,
  init: OpenInit,
): Promise<Bytes> {
  const parts: Bytes[] = [];
  let total = 0;
  for await (const p of openCiphertext((async function* () {
    yield bytes;
  })(), init)) {
    parts.push(p);
    total += p.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
