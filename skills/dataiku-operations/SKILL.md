---
name: dataiku-operations
description: Use Dataiku DSS MCP tools to explore projects, inspect flows and datasets, build or change recipes, manage scenarios and agents, and diagnose failed jobs. Trigger for Dataiku, DSS, projects, recipes, datasets, scenarios, jobs, flows, or Dataiku automation.
---

# Dataiku DSS operations

Use the `dataiku_hardened` MCP server. If its tools are unavailable, explain that it needs a build (`make setup`), Node.js 22+, `DSS_HOST` and `DSS_API_KEY`. Never print or repeat `DSS_API_KEY`.

## Rules for every task

1. Call `get_usage_rules` before designing or changing a Flow, and follow it.
2. Start read-only unless the user clearly asks for a change. Find real project keys and object IDs with tools; never guess them.
3. Read before writing. Keep the `revision` from the read and pass it as `expected_hash` or `expected_version` on the write.
4. Preview with `dry_run` where a tool supports it, then send the same change.
5. A successful response is not proof. Read the changed object back and compare it with the request.
6. Ask for confirmation just before destructive or broad actions, unless the current request already names the exact action and targets.
7. Report partial state from errors, and read the current state before retrying. Never copy `[REDACTED]` values into a write.

If a tool says a guard refused the call, tell the user which setting controls it. Do not work around it with another tool.

## Choose a guide

| Task | Read |
| --- | --- |
| Datasets, recipes, library code, Flow zones | [references/flow-building.md](references/flow-building.md) |
| Builds, waiting on jobs, failed jobs | [references/jobs.md](references/jobs.md) |
| Scenarios and triggers | [references/scenarios.md](references/scenarios.md) |
| Agents, agent tools, agent reviews | [references/agents.md](references/agents.md) |
| Visual ML and saved models | [references/machine-learning.md](references/machine-learning.md) |
| Data quality and profiling | [references/data-quality.md](references/data-quality.md) |
| Projects, folders, users, plugins, environments | [references/administration.md](references/administration.md) |
| Cobuild, only when enabled and requested | [references/cobuild.md](references/cobuild.md) |

After a change, report the project, the affected objects, the operation and the result, including anything you could not confirm.
