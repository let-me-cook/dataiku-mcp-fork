# Scenarios

**Read:** `list_scenarios`, `get_scenario_info`, `get_scenario_steps`.

**Change:** `create_scenario`, `update_scenario` and `add_scenario_build_step`. Read the revision first, and preview with `dry_run`. Changing production schedules needs confirmation.

**Run:** `run_scenario` returns without waiting. Track resulting jobs with `get_recent_runs` and `wait_for_job`.

**Less reliable tools:** `add_scenario_trigger`, `remove_scenario_trigger`, `clone_scenario`, `get_scenario_logs` and `get_scenario_run_history` use endpoints not found in the 14.7.1 SDK and may fail. If one fails with not found, report that instead of retrying.
