# Dataiku plugin

This plugin connects Codex or Claude Code to Dataiku DSS through the hardened TypeScript MCP server in `server-hardened/`.

Requirements: Node.js 22+, Make, Dataiku DSS API access, and `DSS_HOST` and `DSS_API_KEY` available to the client. Run `make setup` first, because the plugin starts the built server from `server-hardened/dist/`. HTTPS is required by default, and insecure TLS is rejected.

The plugin stores no DSS credentials; it uses only the named variables inherited from the client. See `README.md` for the optional safety switches.
