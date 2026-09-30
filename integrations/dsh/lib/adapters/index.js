import { mcpAdapter } from './mcp.js'

export const ADAPTER_LIST = [mcpAdapter]
export const ADAPTERS = new Map(ADAPTER_LIST.map(adapter => [adapter.kind, adapter]))

export { mcpAdapter }
