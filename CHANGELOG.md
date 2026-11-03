# Changelog

## [0.4.5](https://github.com/orafaelfragoso/crewyard/compare/v0.4.4...v0.4.5) (2026-11-03)


### Bug Fixes

* **queue:** hold integration-conflict revisions until the head changes ([4d5fe68](https://github.com/orafaelfragoso/crewyard/commit/4d5fe6810a5275ab4229d264efc827eb4a29d049))
* **queue:** hold integration-conflict revisions until the head changes ([#40](https://github.com/orafaelfragoso/crewyard/issues/40)) ([4d5fe68](https://github.com/orafaelfragoso/crewyard/commit/4d5fe6810a5275ab4229d264efc827eb4a29d049))

## [0.4.4](https://github.com/orafaelfragoso/crewyard/compare/v0.4.3...v0.4.4) (2026-11-03)


### Bug Fixes

* **github:** read merge commits from GraphQL ([aaac04d](https://github.com/orafaelfragoso/crewyard/commit/aaac04d9c36b63216fee56512e9b9a8f66fecb63))
* **github:** read merge commits from GraphQL and stop quarantining unrevised PRs ([#38](https://github.com/orafaelfragoso/crewyard/issues/38)) ([aaac04d](https://github.com/orafaelfragoso/crewyard/commit/aaac04d9c36b63216fee56512e9b9a8f66fecb63))
* **queue:** keep pending revisions through transient mergeability and ([aaac04d](https://github.com/orafaelfragoso/crewyard/commit/aaac04d9c36b63216fee56512e9b9a8f66fecb63))
* **service:** keep PATH in the installed service unit ([aaac04d](https://github.com/orafaelfragoso/crewyard/commit/aaac04d9c36b63216fee56512e9b9a8f66fecb63))

## [0.4.3](https://github.com/orafaelfragoso/crewyard/compare/v0.4.2...v0.4.3) (2026-11-03)


### Bug Fixes

* **agents:** retry tasks after transient session failures ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **application:** resume tasks stranded in REVIEWING ([d22179e](https://github.com/orafaelfragoso/crewyard/commit/d22179e90ed4b0bebdaa4a45bfd452e2f1a84a9b))
* **cli:** acknowledge external branch changes with crew pr acknowledge ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **integration:** accept GitHub update-branch merges as the expected ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **integration:** advance merged, blocked and escalated tasks instead of stranding them ([#34](https://github.com/orafaelfragoso/crewyard/issues/34)) ([d22179e](https://github.com/orafaelfragoso/crewyard/commit/d22179e90ed4b0bebdaa4a45bfd452e2f1a84a9b))
* **integration:** advance tasks whose pull requests merged ([d22179e](https://github.com/orafaelfragoso/crewyard/commit/d22179e90ed4b0bebdaa4a45bfd452e2f1a84a9b))
* **integration:** let escalated tasks rejoin the queue ([d22179e](https://github.com/orafaelfragoso/crewyard/commit/d22179e90ed4b0bebdaa4a45bfd452e2f1a84a9b))
* **integration:** respect GitHub rate limits across service cycles ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **publish:** reconcile acknowledged branch changes instead of retrying ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **publish:** recover from outside branch changes, failed sessions and stale worktrees ([#35](https://github.com/orafaelfragoso/crewyard/issues/35)) ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **queue:** keep stuck entries from halting the project and route reviews and revisions ([#36](https://github.com/orafaelfragoso/crewyard/issues/36)) ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **queue:** revise, re-evaluate and escalate blocked entries instead of ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **queue:** route failing checks to revision on high-risk PRs awaiting ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **queue:** update branches that strict protection holds behind their ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **reviews:** derive review status from blocking finding severity ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **reviews:** run reviews in the PR checkout without blocking service ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **scheduler:** measure queue age only over progressing entries ([38ecf4f](https://github.com/orafaelfragoso/crewyard/commit/38ecf4fe01f07df8d4dc76dcc72dbc6a96815ac8))
* **service:** clean worktrees of finished tasks automatically ([c4a228f](https://github.com/orafaelfragoso/crewyard/commit/c4a228f9593071a74e8be555632f5cd235f9f986))
* **tasks:** keep revision tasks in REVISION when their lease expires ([d22179e](https://github.com/orafaelfragoso/crewyard/commit/d22179e90ed4b0bebdaa4a45bfd452e2f1a84a9b))
* **tasks:** surface blocked tasks and requeue them when unblocked ([d22179e](https://github.com/orafaelfragoso/crewyard/commit/d22179e90ed4b0bebdaa4a45bfd452e2f1a84a9b))

## [0.4.2](https://github.com/orafaelfragoso/crewyard/compare/v0.4.1...v0.4.2) (2026-11-03)


### Features

* **cli:** change account concurrency with crew account set ([#30](https://github.com/orafaelfragoso/crewyard/issues/30)) ([e23083b](https://github.com/orafaelfragoso/crewyard/commit/e23083b6556672d864cbc55177dc6d29f30b0af1))
* **cli:** show who holds each task in crew task list ([2f53f6e](https://github.com/orafaelfragoso/crewyard/commit/2f53f6e9d81be148b46f6efb8f01f9cc6f862060))


### Bug Fixes

* **agents:** tell engineers why a pull request needs revision ([2f53f6e](https://github.com/orafaelfragoso/crewyard/commit/2f53f6e9d81be148b46f6efb8f01f9cc6f862060))
* **github:** read mergeability from the GraphQL state query ([#33](https://github.com/orafaelfragoso/crewyard/issues/33)) ([5642379](https://github.com/orafaelfragoso/crewyard/commit/5642379e1e2ceee10d6656c994c6028684feaa11))
* **publish:** push revised commits to the task's existing pull request ([2f53f6e](https://github.com/orafaelfragoso/crewyard/commit/2f53f6e9d81be148b46f6efb8f01f9cc6f862060))
* **queue:** close the revision loop from failing checks to merge ([#32](https://github.com/orafaelfragoso/crewyard/issues/32)) ([2f53f6e](https://github.com/orafaelfragoso/crewyard/commit/2f53f6e9d81be148b46f6efb8f01f9cc6f862060))
* **queue:** send tasks back for revision when checks or reviews fail ([2f53f6e](https://github.com/orafaelfragoso/crewyard/commit/2f53f6e9d81be148b46f6efb8f01f9cc6f862060))
* **service:** ignore stale service workers in status and stop ([e23083b](https://github.com/orafaelfragoso/crewyard/commit/e23083b6556672d864cbc55177dc6d29f30b0af1))
* **service:** keep heartbeats flowing while a review runs ([2f53f6e](https://github.com/orafaelfragoso/crewyard/commit/2f53f6e9d81be148b46f6efb8f01f9cc6f862060))

## [0.4.1](https://github.com/orafaelfragoso/crewyard/compare/v0.4.0...v0.4.1) (2026-11-03)


### Features

* **cli:** set codex and opencode permission modes with account set ([311b124](https://github.com/orafaelfragoso/crewyard/commit/311b124b21931abde780b2a7244ced29e6c5ccfe))
* **codex:** allow danger-full-access when a profile opts in ([311b124](https://github.com/orafaelfragoso/crewyard/commit/311b124b21931abde780b2a7244ced29e6c5ccfe))
* **codex:** let engineers fetch dependencies and opt into full access ([#27](https://github.com/orafaelfragoso/crewyard/issues/27)) ([311b124](https://github.com/orafaelfragoso/crewyard/commit/311b124b21931abde780b2a7244ced29e6c5ccfe))


### Bug Fixes

* **service:** keep the database open until running sessions settle ([bdac4b1](https://github.com/orafaelfragoso/crewyard/commit/bdac4b1e91dc581198d47821209f6944f2340f8b))
* **service:** stop running sessions and requeue tasks on shutdown ([#26](https://github.com/orafaelfragoso/crewyard/issues/26)) ([bdac4b1](https://github.com/orafaelfragoso/crewyard/commit/bdac4b1e91dc581198d47821209f6944f2340f8b))

## [0.4.0](https://github.com/orafaelfragoso/crewyard/compare/v0.3.4...v0.4.0) (2026-11-03)


### Features

* **claude:** allow bypassPermissions when a profile opts in ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))
* **cli:** add crew account set for permission mode and tools ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))


### Bug Fixes

* **agents:** let engineers run commands and report to Crewyard ([#24](https://github.com/orafaelfragoso/crewyard/issues/24)) ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))
* **agents:** start the crew MCP server after crewyard is upgraded ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))
* **claude:** run execution sessions in auto permission mode ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))
* **cli:** drop --dry-run from commands that cannot preview ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))
* **cli:** make --dry-run preview task, goal and PR approval changes ([653b281](https://github.com/orafaelfragoso/crewyard/commit/653b281f2f229124e0a01d2bb3ac1c9d250bb2fe))

## [0.3.4](https://github.com/orafaelfragoso/crewyard/compare/v0.3.3...v0.3.4) (2026-11-03)


### Bug Fixes

* **reviews:** check callers and contracts with crew context tools ([#22](https://github.com/orafaelfragoso/crewyard/issues/22)) ([bec643c](https://github.com/orafaelfragoso/crewyard/commit/bec643c7c80dda7e53a530086d8c7aebb79b7339))

## [0.3.3](https://github.com/orafaelfragoso/crewyard/compare/v0.3.2...v0.3.3) (2026-11-03)


### Bug Fixes

* **agents:** keep the full planning result and point the architect at crew context ([#19](https://github.com/orafaelfragoso/crewyard/issues/19)) ([3bb62ea](https://github.com/orafaelfragoso/crewyard/commit/3bb62ea688a92847b5e5581fedd28f322b72d5d3))
* **agents:** store the full final result of agent sessions so long plans parse ([3bb62ea](https://github.com/orafaelfragoso/crewyard/commit/3bb62ea688a92847b5e5581fedd28f322b72d5d3))
* **cli:** print the session log in `crew agent logs` ([3bb62ea](https://github.com/orafaelfragoso/crewyard/commit/3bb62ea688a92847b5e5581fedd28f322b72d5d3))
* **planning:** ask the architect to use the crew-planning skill and crew context tools ([3bb62ea](https://github.com/orafaelfragoso/crewyard/commit/3bb62ea688a92847b5e5581fedd28f322b72d5d3))

## [0.3.2](https://github.com/orafaelfragoso/crewyard/compare/v0.3.1...v0.3.2) (2026-11-03)


### Bug Fixes

* **agents:** parse fenced JSON from agent output in linear time ([8deb19a](https://github.com/orafaelfragoso/crewyard/commit/8deb19affb8b4e7a15288b0ed2b381410ae36f06))
* **config:** reject `__proto__`, `constructor` and `prototype` in configuration paths ([8deb19a](https://github.com/orafaelfragoso/crewyard/commit/8deb19affb8b4e7a15288b0ed2b381410ae36f06))
* **config:** write `crew config set` and the service unit atomically ([8deb19a](https://github.com/orafaelfragoso/crewyard/commit/8deb19affb8b4e7a15288b0ed2b381410ae36f06))
* **redaction:** redact private keys in linear time on hostile agent output ([8deb19a](https://github.com/orafaelfragoso/crewyard/commit/8deb19affb8b4e7a15288b0ed2b381410ae36f06))
* **security:** close code scanning alerts ([8deb19a](https://github.com/orafaelfragoso/crewyard/commit/8deb19affb8b4e7a15288b0ed2b381410ae36f06))


### Documentation

* ask pull requests to list changelog entries ([#15](https://github.com/orafaelfragoso/crewyard/issues/15)) ([00c583a](https://github.com/orafaelfragoso/crewyard/commit/00c583a9b0cea6c04982af6aceddaedc75c50d85))
* separate changelog entries with blank lines ([#17](https://github.com/orafaelfragoso/crewyard/issues/17)) ([7969ae5](https://github.com/orafaelfragoso/crewyard/commit/7969ae51e5da966dd86ca1806faf8e140de31b60))

## [0.3.1](https://github.com/orafaelfragoso/crewyard/compare/v0.3.0...v0.3.1) (2026-11-03)


### Bug Fixes

* close security and correctness findings from the v0.3.0 review ([#12](https://github.com/orafaelfragoso/crewyard/issues/12)) ([a4a1956](https://github.com/orafaelfragoso/crewyard/commit/a4a1956f4ad82c6a71d25cc5bc67ba617ba6ebd2))

## [0.3.0](https://github.com/orafaelfragoso/crewyard/compare/v0.2.0...v0.3.0) (2026-11-03)


### Features

* give every managed session the crew MCP server and Skills ([#10](https://github.com/orafaelfragoso/crewyard/issues/10)) ([a670910](https://github.com/orafaelfragoso/crewyard/commit/a6709105bbc05d1ef243855894a3b49091736439))

## [0.2.0](https://github.com/orafaelfragoso/crewyard/compare/v0.1.1...v0.2.0) (2026-11-03)


### ⚠ BREAKING CHANGES

* manage agents and account policies ([#9](https://github.com/orafaelfragoso/crewyard/issues/9))

### Features

* add crew account login and a getting-started guide ([#8](https://github.com/orafaelfragoso/crewyard/issues/8)) ([feae366](https://github.com/orafaelfragoso/crewyard/commit/feae366a3a421d5c44e6902ad85c3ed7e4ab3797))
* manage agents and account policies ([#9](https://github.com/orafaelfragoso/crewyard/issues/9)) ([89783db](https://github.com/orafaelfragoso/crewyard/commit/89783db4cdf11e4e416ec36d23fd193ce8e2372d))


### Documentation

* add the Crewyard banner to the README ([#6](https://github.com/orafaelfragoso/crewyard/issues/6)) ([7fdb5a9](https://github.com/orafaelfragoso/crewyard/commit/7fdb5a9f087dbc62612f08fb24d9d8fba11d34fc))

## [0.1.1](https://github.com/orafaelfragoso/crewyard/compare/v0.1.0...v0.1.1) (2026-11-03)


### Bug Fixes

* stop binaries from loading project .env files and shrink release binaries ([#4](https://github.com/orafaelfragoso/crewyard/issues/4)) ([0c45cdb](https://github.com/orafaelfragoso/crewyard/commit/0c45cdba68c44af7bcdef9ca13d99f2359d11dfa))

## 0.1.0 (2026-11-03)


### Documentation

* add contributing, security and community guidelines with issue and PR templates ([809dc2a](https://github.com/orafaelfragoso/crewyard/commit/809dc2a8f8bf35108c264c42e4a6da29ecec61fd))
* rewrite the README ([5f0892f](https://github.com/orafaelfragoso/crewyard/commit/5f0892fb02879a3744acf3b82120dc928ddf8e78))


### CI

* automate changelog and releases with release-please ([9764cac](https://github.com/orafaelfragoso/crewyard/commit/9764cac24eb2f708887e82c6491d72bb1a6c6391))
