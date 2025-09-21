Sandboxed browser in browser project

> New Version upcoming ( Solve relative url issues， migrate to new router schema ）

- Sandbox enhance: A perfect isolated browser environment + a redirect component (simulated browser send requests as any regular browser, the redirect component wrap the request to router)
- On UI: A simulated browser container that would display html + js + css in it and can full screen
- All kinds of media should be handed correctly. Unfied url entrance, no seperate `Load Media` Block.

You would need to know the router interface
public repo: `https://github.com/ZihaoFU245/cf-worker-router`
Use git: `https://github.com/ZihaoFU245/cf-worker-router.git`

For you convinience, below is a doc from router repo:

```Markdown
# Connector Integration Guide

This document explains how a local connector application should talk to the
router worker. It focuses on HTTP contracts, payload formats, and the
expectations around cookies and batching so that connectors can reliably proxy
browser-style traffic through the worker.

## Overview

* **Base URL** – `https://<your-worker-subdomain>.workers.dev`
* **Authentication** – None. Callers are identified by their self-managed
  session identifier (`sid`).
* **Transport** – Always `https`. The worker rejects plain `http` targets.
* **Character encoding** – All opaque payloads (request bodies and binary
  responses) use Base64URL to stay transfer-safe over JSON.

The connector is responsible for generating a stable `sid` per sandbox/tab and
persisting any cookies that the worker echoes back via `X-Set-Cookie`.

## Session Identifiers

Create a unique `sid` for every sandboxed browsing context. The worker stores
cookies per `sid`, so reuse of the identifier across sites will leak cookies.
When a sandbox is destroyed, you can either let it expire server-side or call a
custom cleanup endpoint you host yourself.

## Available Endpoints

### `GET /p`

Lightweight passthrough for media elements, favicons, and other `GET`/`HEAD`
requests that should stream straight back to the connector.

| Query Parameter | Description |
| --- | --- |
| `sid` | Session identifier. Optional, but required for cookies. |
| `u` | Base64URL encoded absolute `https` URL. |

Forward any `Range` header when seeking within media. Responses mirror upstream
status codes and headers (`Content-Type`, `Content-Length`, `Accept-Ranges`,
`Content-Range`, `ETag`, `Last-Modified`). If upstream sets cookies, the worker
returns them in `X-Set-Cookie`.

### `POST /fetch`

Structured control-plane call for navigation, form submissions, and API calls
that need the full response streamed back to the connector.

```jsonc
{
  "sid": "sandbox-123",
  "target": "https://example.com/login",
  "method": "POST",
  "headers": {
    "content-type": "application/json"
  },
  "bodyB64": "eyJ1c2VyIjoicm9vdCIsInBhc3MiOiJzZWNyZXQifQ" // optional
}
```

* `method` defaults to `GET`. Only `GET`, `HEAD`, and `POST` are allowed.
* `bodyB64` must be Base64URL encoded bytes. Omit it for `GET`/`HEAD`.
* The worker streams the upstream response body back untouched. Watch for
  `X-Set-Cookie` headers to mirror cookies in your local jar.

### `POST /dispatch`

New batching endpoint for coordinating several upstream requests in one
round-trip. Ideal for bootstrapping a page where multiple dependent assets must
be fetched before rendering locally.

```jsonc
{
  "sid": "sandbox-123",
  "pipeline": "sequential",           // default, preserves cookie order
  "requests": [
    {
      "id": "bootstrap-html",
      "target": "https://example.com/",
      "method": "GET",
      "responseType": "text"
    },
    {
      "id": "bootstrap-api",
      "target": "https://example.com/api/session",
      "method": "GET",
      "responseType": "json"
    }
  ]
}
```

* Up to 16 sub-requests per call.
* `responseType` controls how the worker serialises the body:
  * `arrayBuffer` (default) – Base64 encoded bytes.
  * `text` – UTF-8 decoded string.
  * `json` – Parsed JSON object (falls back to raw text with a `note` on parse
    failure).
  * `none` – Skip body materialisation.
* Results are returned as an array, preserving request order. Each entry
  includes latency, redirect info, filtered headers, and an optional `body`
  payload. Example result:

```jsonc
{
  "id": "bootstrap-api",
  "ok": true,
  "status": 200,
  "statusText": "OK",
  "durationMs": 132,
  "headers": {
    "content-type": "application/json",
    "x-set-cookie": "session%3Dabc123"
  },
  "body": {
    "encoding": "json",
    "data": { "user": { "name": "Riley" } }
  }
}
```

The top-level response also carries a combined `X-Set-Cookie` header containing
all cookies observed while executing the batch. Merge it into your local storage
before issuing follow-up calls.

## Cookie Handling

1. After every response (including batches), look for the `X-Set-Cookie` header.
2. Split on commas and `decodeURIComponent` each entry to recover the original
   `Set-Cookie` strings.
3. Mirror the cookies in the connector’s storage and send them back on future
   calls associated with the same `sid`.

Cookies are persisted server-side when Durable Objects are configured, so even
parallel connectors will see a consistent view as long as they reuse the same
`sid`.

## Recommended Request Headers

The worker already supplies a realistic browser fingerprint:

* `User-Agent`: Chrome on Windows 10.
* `Accept`: rich HTML/media preference list.
* `Accept-Language`: `en-US,en;q=0.9`.

You can override any of these by sending explicit header values. Avoid
forwarding hop-by-hop headers (`Connection`, `Transfer-Encoding`, etc.) or
restricted headers like `Host`, `Cookie`, and `Content-Length`; the worker will
strip them for safety.

## Error Codes

* `400` – Validation failure (missing target, invalid Base64URL, non-HTTPS).
* `405` – Unsupported method.
* `0 / FETCH_ERROR` – Network failure or DNS issue when reaching the upstream.

When a batch contains an error, only that entry fails; other entries still
complete.

## Example Workflow

1. Connector receives a URL locally.
2. Generate/lookup the sandbox `sid`.
3. Encode the target with Base64URL and call `GET /p` for media or `POST /fetch`
   / `POST /dispatch` for document/API fetches.
4. Apply any cookies returned via `X-Set-Cookie`.
5. Render the upstream response locally. Repeat for additional assets.

Keeping requests batched when possible reduces round trips and helps the worker
optimise cookie persistence for high-concurrency workloads.
```

