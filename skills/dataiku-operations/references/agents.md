# Agents

See `server-hardened/AGENTS-API.md` in this repository for examples and limits.

**Read:** `list_agents` and `get_agent` return summaries. Pass `detail: "full"` before patching arrays. Use `list_agent_tools`, `get_agent_tool`, `get_agent_tool_descriptor` and `list_llms`.

**Build:** use `create_agent`, `update_agent_version`, `create_agent_tool`, `update_agent_tool`, `attach_agent_tool` and `detach_agent_tool`. For structured visual agents, use `build_structured_agent` with a dry run, then `validate_structured_agent`.

**Run:** `run_agent` and `run_agent_tool` invoke real logic and can have side effects. A timeout does not cancel the run. `check_agent_tool_startup` checks that a tool initializes.

**Evaluate:** `list_agent_reviews`, `get_agent_review`, `list_agent_review_tests`, `list_agent_review_runs` and `get_agent_review_run_results` are read-only. This server cannot start review runs.
