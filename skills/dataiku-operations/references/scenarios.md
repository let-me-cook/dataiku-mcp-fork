# Scenarios

**Read:** `list_scenarios`, `get_scenario_info`, `get_scenario_steps`.

**Change:** `create_scenario`, `update_scenario` and `add_scenario_build_step`. Read the revision first, and preview with `dry_run`. Changing production schedules needs confirmation.

**Triggers:** `add_scenario_trigger` adds time-based triggers only, and `remove_scenario_trigger` removes one by index using the hash from `get_scenario_info`. A trigger only fires while the scenario is active.

**Run:** `run_scenario` returns without waiting. Check `get_scenario_run_history`, and track resulting jobs with `get_recent_runs` and `wait_for_job`.
