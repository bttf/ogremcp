// The platform service: web UI, MCP server, bridge API, and OAuth server
// (docs/architecture.md §5, §13). Empty until the service skeleton lands.

// Deliberate seam violation (RED-282): a kit imported outside the kit
// registry. The next commit reverts it.
import "@ogmcp/kit-wow";

export {};
