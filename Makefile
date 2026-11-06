.DEFAULT_GOAL := help

ENV_FILE ?= .env

.PHONY: help prerequisites setup env install check build test run audit

help:
	@printf '%s\n' 'make setup  Install dependencies, build, and create .env' 'make run    Start the MCP server using .env' 'make check  Typecheck the server' 'make build  Rebuild after source changes' 'make test   Run offline API contract and MCP tests' 'make audit  Audit production dependencies'

prerequisites:
	@command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22 or newer (with npm).' >&2; exit 1; }
	@node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required."); process.exit(1); }'
	@command -v npm >/dev/null 2>&1 || { echo 'npm is required. Install it with Node.js.' >&2; exit 1; }

setup: prerequisites
	@$(MAKE) --no-print-directory env
	@$(MAKE) --no-print-directory install
	@$(MAKE) --no-print-directory check
	@$(MAKE) --no-print-directory build
	@printf '%s\n' 'Setup complete. Set DSS_HOST and DSS_API_KEY in .env, then run make run.'

env:
	@if [ ! -e .env ]; then (umask 077; set -C; cat .env.example > .env); fi

install: prerequisites
	@cd server-hardened && npm ci

check: prerequisites
	@cd server-hardened && npm run check

build: prerequisites
	@cd server-hardened && npm run build

test: prerequisites
	@cd server-hardened && npm test

run: prerequisites
	@test -f "$(ENV_FILE)" || { echo 'Missing environment file. Run make setup and fill in .env.' >&2; exit 1; }
	@test -f server-hardened/dist/mcp-server.js || { echo 'Missing build. Run make setup first.' >&2; exit 1; }
	@node --env-file="$(ENV_FILE)" -e 'if (!process.env.DSS_HOST?.trim() || !process.env.DSS_API_KEY?.trim()) { console.error("Set DSS_HOST and DSS_API_KEY in .env before running the server."); process.exit(1); }'
	@node --env-file="$(ENV_FILE)" server-hardened/dist/mcp-server.js

audit: prerequisites
	@cd server-hardened && npm run audit:prod
