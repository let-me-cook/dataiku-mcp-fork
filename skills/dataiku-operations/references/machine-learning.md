# Machine learning

These tools are read-only. This server cannot create analyses, train models from a task, or change the active version.

**Visual analyses:** `list_ml_analyses`, `get_ml_analysis`, `list_ml_tasks`, then `get_ml_task_status` for trained model IDs, then `get_ml_model_details`.

**Saved models:** `list_saved_models`, `list_saved_model_versions`, `get_saved_model_version_details`.

**Retraining:** add a saved model output to a scenario with `add_scenario_build_step`, or build it with `start_job`.

Model details can be large. Oversized results come back as private local artifacts.
