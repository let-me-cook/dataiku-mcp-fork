# Administration

**Projects:** `create_project` needs an existing owner login, supports `dry_run` and never reuses an existing key. `get_project_variables` and `merge_project_variables` manage variables. `export_project_config` writes a private ZIP artifact that may hold sensitive configuration.

**Folders:** `get_project_folder` and `list_project_folders` are read-only.

**Instance information:** `list_users`, `list_groups`, `list_plugins`, `get_connections`, `get_code_environments` and `inspect_code_environment` are read-only and may need admin rights. This server cannot change users, groups, plugins or connections, so give the user the steps instead.

**Environments:** package lists don't prove imports work. `validate_code_environment_imports` temporarily creates and deletes a diagnostic tool in the project, so confirm first.
