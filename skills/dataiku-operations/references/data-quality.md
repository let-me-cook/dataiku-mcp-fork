# Data quality

**Rules and results:** `list_data_quality_rules`, `get_data_quality_status`, `get_data_quality_results` and `get_data_quality_history` read stored results and never compute rules. Stale status means nothing has recomputed it.

**Profiling:** `get_dataset_profile` summarizes empty rates, top values and numeric ranges. Check `scan_complete`: a partial scan describes only the rows scanned. Columns with secret-like names report fill rates only. Use it before reading raw rows.

**Metrics:** `check_dataset_metrics` reads stored metrics without recomputing them.
