# mediaXG

Premium terminal-based AI coding agent with multi-provider support, streaming, reasoning controls, Plan/Build modes, native coding tools, Skills, MCP, session persistence, and transparent cost controls.

## Features

- **Multi-provider support**: OpenAI-compatible, Anthropic-compatible, xKiro
- **Real streaming**: Genuine incremental streaming with reasoning controls
- **Plan/Build/Review modes**: Mode-based workflow with appropriate permissions
- **Native coding tools**: File operations, search, diff, process execution
- **Skills system**: Agent Skills convention with discovery and activation
- **MCP support**: Streamable HTTP and stdio transports
- **Session persistence**: Versioned JSON store with search, resume, export
- **Context management**: Requested budgets up to 5M tokens — always clamped by real model/provider limits, with assembly provenance, retrieval, and compaction
- **Budget controls**: Usage tracking, pricing, spending limits
- **Security**: Credential protection, permission engine, path traversal prevention

## Installation

```bash
bun install
```

## Development

```bash
bun run dev
```

## Build

```bash
bun run build
```

## Testing

```bash
bun test
```

## Configuration

Configuration is stored in:

- Project: `.mediaxg/config.json`
- User: `~/.config/mediaxg/config.json`

## License

MIT
