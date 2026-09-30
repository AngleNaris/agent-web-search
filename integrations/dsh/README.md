# dsh-agent-web-search

`dsh-agent-web-search` is the native DeepSeek Harness integration for
`agent-web-search`. It replaces the implementation behind DSH's native
`web_search` seam while preserving the native tool name, prompt, normalized
sources, and citation cards. It does **not** install or expose an
`mcp__...__web_search` model tool.

## Architecture

- DSH registers exactly one `ctx.web` provider: `agent-web-search`.
- The Cordis patch pins the shared `web` seam to that provider and disables the
  built-in DeepSeek search row without changing the tool surface.
- Built-in providers are delegated to the installed Python
  `agent-web-search-mcp` command over local stdio. The bridge calls only the
  fixed `web_search` MCP operation, bounds output, propagates `maxResults`,
  honors cancellation and timeouts, and terminates the child process.
- DSH retains its fanout/fallback strategy controls, live credentials, custom
  MCP sources, in-memory history, diagnostics, and settings page. Custom MCP
  sources remain a DSH-side path because they require per-source tool names and
  declarative result mapping that are not part of the Python public response.

The Python package must be installed in the same environment as the DSH host:

```bash
python -m pip install agent-web-search-mcp
```

Use `AGENT_WEB_SEARCH_MCP_COMMAND` when the executable is not on DSH's `PATH`.
`AGENT_WEB_SEARCH_MCP_ARGS` may contain a JSON array of extra command-line
arguments. The bridge always invokes the fixed `web_search` operation and never
passes provider credentials as MCP arguments.

## Installation

```bash
dsh plugin --profile <profile> add github:JerryLiu369/agent-web-search
```

Restart DSH after installation. The desktop profile is managed by Electron;
manual desktop installation instructions depend on the DSH release and should
use the profile's normal plugin-directory and bundle-registration mechanism.

If another bundle writes the `web.searchProvider` value later, its layer wins.
Keep this bundle last, or restate `searchProvider: agent-web-search` in the
profile-owned Cordis patch. The patch also repeats `fetchProvider: http` so the
whole-row replacement does not discard the existing fetch provider.

## Settings and credentials

The existing **Settings → agent-web-search** page remains available. Its
controls retain the following runtime behavior:

- `fanout` and `fallback` execution modes;
- provider enablement/order, max results, per-attempt timeout, total timeout,
  URL de-duplication, and answer inclusion;
- DSH credential references, which are resolved server-side and never persisted
  in the provider queue or sent to the model;
- custom Streamable HTTP MCP sources with exact tool selection and read-only
  discovery; and
- bounded in-memory call history and authenticated diagnostics.

Built-in provider credentials use the canonical Python environment names listed
in the root README. DSH resolves the corresponding credential reference into
the child process environment for one search and removes unrelated credential
variables from that child. Restart DSH after changing environment variables.

The per-source endpoint field accepts HTTPS URLs, or HTTP URLs on loopback for
local fakes and development. Embedded credentials and URL fragments are
rejected. The Python providers honor the DSH endpoint override for the built-in
API/MCP providers; DDGS uses its Python backend and does not support replacing
its endpoint with an arbitrary HTML URL.

## Native result and error behavior

Successful Python results are mapped to DSH `sources` and optional `content`.
Provider answers retain a short source attribution, while source rows remain
normalized DSH citation rows. Malformed MCP output, oversized output, timeout,
cancellation, and all-provider failure become sanitized DSH provider errors;
upstream response bodies and credentials are never copied into model-visible
errors or history.

The internal bridge uses local stdio only. DSH's custom remote MCP-source UI
continues to use its existing authenticated connection route and exact-tool
discovery; it is not converted into an arbitrary model-tool registry.

## Development and verification

From the repository root:

```bash
npm test
python -m pytest -q
```

The DSH bridge tests use fake child processes and never make paid provider
requests. They cover result mapping, malformed and structured error results,
`maxResults`, cancellation, timeout, bounded output, and child cleanup.

The package layout is intentionally a thin DSH adapter. Provider dispatch,
normalization, credentials, and shared failure payloads belong to the Python
`SearchEngine`, not a second JavaScript provider fleet.
