# Jobs

**Build:** prefer `start_job`, which returns a job ID straight away. Check dependencies with `get_project_flow` first, because builds change data.

**Wait:** use `wait_for_job`. A timeout means the job is still running. Only `success: true` confirms completion.

**Diagnose a failure:**
1. Use `get_recent_runs` to find the job and `get_job_details` for its activities and failure.
2. Use `get_job_log_tail`, because errors are usually at the end. If it warns that the end was not reached, raise `max_scan_bytes`. `get_job_activity_log` shows the start of a log.
3. Inspect the failing recipe and its inputs before suggesting a fix.

**Stop:** use `abort_job` for one job, or `cancel_running_jobs` for a named list. Check each job's outcome. Aborting does not undo partial outputs.
