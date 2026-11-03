# Changelog

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
