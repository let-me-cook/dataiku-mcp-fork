# Flow building

**Orient:** `list_projects`, `get_project_flow`, `list_datasets`, `list_recipes`, `list_flow_zones`.

**Datasets:** read with `get_dataset_info`, `inspect_dataset_schema` and `get_dataset_sample`. A sample filter only covers the bounded scan, so a partial scan with no matches proves nothing. Create with `create_dataset` or `create_external_postgresql_dataset`, and detect columns with `autodetect_dataset_schema`. Inspect physical tables with `list_database_tables` and `inspect_database_table`.

**Recipes:** read with `get_recipe_info` and `get_recipe_code`. Prefer native visual recipes. Change with `update_recipe`, previewing first with `dry_run`. Python recipes must keep exactly one output and at most 1,000 lines. After `create_recipe`, check the saved result, because its request format comes from the older upstream tool.

**Library code:** use `list_project_library`, `search_project_library` (literal text only), `read_project_library_file` and `write_project_library_file`. Updates need the previous hash.

**Zones:** reuse existing zones first. Use `create_flow_zone`, `move_flow_objects`, `share_flow_object` and `update_flow_zone`. Moving an object can also move its generating recipe.

**Files:** `upload_managed_folder_file` takes only an artifact registered with `register_artifact`, never a local path.
