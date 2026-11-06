# Upstream provenance

This hardened fork was derived from:

- Repository: https://github.com/steven0lisa/mcp-dataiku
- Tag: v1.0.7
- Commit: da5daa639154e2d6590befdb17b12186ce6d4c3f
- Upstream package: @zhangzichao2008/mcp-dataiku@1.0.7
- License: MIT

The fork was created from the tagged source, then dependency and HTTP-client hardening changes were applied locally. The upstream LICENSE file is preserved.

## Dataiku Headless

The job helpers, dataset profile, library search, data quality, ML, agent review, project, folder, admin and Cobuild tools, the instance-type guard, and the docs consistency test were designed after reviewing [dataiku/dataiku-headless](https://github.com/dataiku/dataiku-headless) v0.9.0 (commit `14d71b8`), licensed under Apache-2.0, copyright Dataiku SAS. They were written independently for this TypeScript server and contain no Headless code. Dataiku Headless is not affiliated with this repository.
