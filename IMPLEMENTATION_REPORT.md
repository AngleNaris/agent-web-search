# Implementation Report

## Architecture decision

DSH remains the product boundary. The plugin still registers one native
`ctx.web` provider and the Cordis patch still selects it for DSH's native
`web_search` path, so the model-facing tool name, prompt, normalized source
rows, citation cards, settings, history, diagnostics, and custom MCP-source
behavior remain DSH behavior.

The duplicate JavaScript provider fleet and aggregation engine are removed.
Built-in provider attempts now use a short-lived `agent-web-search-mcp` stdio
child and call only the fixed `web_search` operation. The bridge maps DSH live
credential references into the child environment, propagates provider
selection and `maxResults`, bounds output, sanitizes structured failures, and
terminates the child on success, timeout, cancellation, or malformed output.
DSH keeps fanout/fallback orchestration because those controls and per-source
history are not represented in the Python public MCP response. Custom remote
MCP sources remain the existing DSH-side exact-tool path.

## Files changed

- Added `integrations/dsh/lib/bridge.js` and focused fake-child tests.
- Reworked `integrations/dsh/lib/engine.js` and `provider.js` into the thin
  DSH-to-Python bridge and native result mapper.
- Reduced `integrations/dsh/lib/adapters/index.js` to the custom MCP adapter;
  removed the duplicate built-in JS adapters.
- Added endpoint override environment support to the canonical Python
  providers used by DSH.
- Updated `ARCHITECTURE.md`, root READMEs, and `integrations/dsh/README.md`.
- Replaced provenance tests with bridge/result-contract tests.

## Verification

- `npm test` — 31 DSH tests passed.
- `python -m pytest -q` — 249 Python tests passed.
- `git diff --check` — passed.
- `node --check` — passed for all DSH JavaScript files.
- No paid provider/API calls were made; bridge tests use fake child processes.

## Remaining limitations

- The Python `agent-web-search-mcp` executable must be installed in the DSH
  host environment, or configured through `AGENT_WEB_SEARCH_MCP_COMMAND`.
- The bridge forces the child transport to `stdio`, even when the DSH host
  environment also contains the Python server's HTTP transport setting.
- DSH custom MCP sources remain HTTP-based and continue to use their existing
  endpoint validation/discovery path; they are intentionally not exposed as
  model-facing MCP tools.
- DDGS uses the canonical Python DDGS backend and does not support replacing
  it with an arbitrary HTML endpoint through the DSH per-source endpoint field.
- The bridge uses one short-lived Python MCP child per built-in provider
  attempt. This preserves exact fanout/fallback and history semantics at the
  cost of process startup overhead.
