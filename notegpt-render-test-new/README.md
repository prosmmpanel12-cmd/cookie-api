# NoteGPT Render Test Server

Render-ready Node.js test server.

## Deploy

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Optional environment variable: `TEST_API_KEY`

## Endpoints

`GET /health`

`POST /generate`

Example body:

```json
{"prompt":"A beautiful red apple on a wooden table","aspect":"1:1"}
```

If `TEST_API_KEY` is configured, send it as `x-api-key`.

## Important implementation detail

The WASM glue is initialized from local bytes on Node/Render. This avoids Node's inability to use `fetch()` for local `file://` URLs. The generated bundle also had a side-effect-only import for a missing `CXXaAwHQ.js`; that import has been removed because the required WASM glue exports are self-contained for this server path.


Step 2 cookie flow: performs a fresh same-origin bootstrap request, captures only server-issued Set-Cookie values in a per-generation jar, and sends that jar on subsequent API requests. TEST_USER_AGENT can select one explicit UA for interoperability testing.
