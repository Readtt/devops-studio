import { Channel, invoke } from "@tauri-apps/api/core";

/** Streaming events emitted by the Rust `ai_http_stream` command. Chunk bytes
 *  travel as base64 — a `Vec<u8>` would serialize as a JSON array with one
 *  number per byte, and at token-stream rates that per-chunk stringify/parse
 *  cost lands on the webview main thread and starves the UI (frozen clicks
 *  during long agentic runs). */
type AiStreamEvent =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; data: string }
  | { kind: "end" }
  | { kind: "error"; message: string };

type RequestHeaders = Record<string, string>;

function headerInitToRecord(
  init: HeadersInit | undefined,
): RequestHeaders | undefined {
  if (!init) return undefined;
  const out: RequestHeaders = {};
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(init)) out[k] = String(v);
  }
  return out;
}

/** Encode the request body as base64 for the IPC hop. Agentic-loop bodies grow
 *  to hundreds of KB (every step resends the whole conversation + tool
 *  results); as a number[] they'd JSON-stringify to multi-MB strings on the
 *  main thread on EVERY step — the app visibly freezes. Base64 is one compact
 *  string instead. */
async function bodyToBase64(
  body: BodyInit | null | undefined,
): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") {
    return bytesToBase64(new TextEncoder().encode(body));
  }
  if (body instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return bytesToBase64(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  if (body instanceof Blob)
    return bytesToBase64(new Uint8Array(await body.arrayBuffer()));
  // FormData / URLSearchParams / ReadableStream — uncommon for AI SDK calls.
  const text = await new Response(body as BodyInit).text();
  return bytesToBase64(new TextEncoder().encode(text));
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa takes a binary string; build it in slices so a multi-hundred-KB body
  // can't blow the argument limit of String.fromCharCode.apply.
  let bin = "";
  const SLICE = 0x8000;
  for (let i = 0; i < bytes.length; i += SLICE) {
    bin += String.fromCharCode(...bytes.subarray(i, i + SLICE));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function createProxyFetch(
  opts: { allowPrivateNetwork?: boolean } = {},
): typeof fetch {
  const allowPrivate = opts.allowPrivateNetwork === true;
  return async (input, init) => proxyFetchImpl(input, init, allowPrivate);
}

/** Backwards-compatible default — refuses private networks unless the caller
 *  explicitly opts in via {@link createProxyFetch}. */
export const proxyFetch: typeof fetch = (input, init) =>
  proxyFetchImpl(input, init, false);

// Monotonic id linking each streaming request to its Rust-side cancel handle.
let nextStreamRequestId = 1;

async function proxyFetchImpl(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  allowPrivateNetwork: boolean,
): Promise<Response> {
  const url = input instanceof URL ? input.toString() : String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = headerInitToRecord(init?.headers);
  const body = await bodyToBase64(init?.body);

  const signal = init?.signal;
  if (signal?.aborted) {
    throw makeAbortError();
  }

  const requestId = nextStreamRequestId++;

  return new Promise<Response>((resolve, reject) => {
    let resolved = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null =
      null;
    let cancelled = false;

    // Tell Rust to bail out of its chunk loop and drop the HTTP connection.
    // Without this, an aborted generation keeps streaming (and the provider
    // keeps generating tokens) until the model finishes on its own.
    const cancelUpstream = () => {
      void invoke("ai_http_stream_cancel", { requestId }).catch(() => {
        /* stream already ended — registry entry is gone */
      });
    };

    const onAbort = () => {
      cancelled = true;
      cancelUpstream();
      if (!resolved) {
        reject(makeAbortError());
      } else if (streamController) {
        try {
          streamController.error(makeAbortError());
        } catch {
          /* already closed */
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<AiStreamEvent>();
    channel.onmessage = (event) => {
      if (cancelled) return;
      switch (event.kind) {
        case "headers": {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              // Consumer stopped reading (e.g. SDK closed the body early) —
              // stop the upstream request too.
              cancelled = true;
              cancelUpstream();
            },
          });
          resolved = true;
          resolve(
            new Response(stream, {
              status: event.status,
              headers: new Headers(event.headers),
            }),
          );
          break;
        }
        case "chunk": {
          streamController?.enqueue(base64ToBytes(event.data));
          break;
        }
        case "end": {
          streamController?.close();
          break;
        }
        case "error": {
          if (!resolved) {
            reject(new Error(event.message));
          } else {
            streamController?.error(new Error(event.message));
          }
          break;
        }
      }
    };

    invoke("ai_http_stream", {
      url,
      method,
      headers,
      body,
      allowPrivateNetwork,
      requestId,
      onEvent: channel,
    }).catch((e) => {
      if (resolved) return; // headers already arrived; chunk-side error wins
      reject(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

function makeAbortError(): DOMException {
  return new DOMException("Request aborted", "AbortError");
}
