# Principles

* If the user prompt looks like a bash command they have probably forgotten to
  escape it and you should stop and ask whether they forgot to escape it.
* If the input looks incomplete ask the user and wait for the next message.
* If uncertain about user intentions clarify with the user and do not make
  assumptions.
* Design artefacts are in the `design` folder.
* **MAKE SURE YOU HAVE A CLEAN REVERT POINT BEFORE MAKING EVEN SEEMING MINOR
  CHANGES. CREATE BRANCHES FOR BIG CHANGES**
* All tests must be implemented and proven to fail before starting development
  of a feature.
* All tests must be proven to pass before development of a feature is complete.
* Before committing confirm the following:
  1. **ALL AFFECTED TESTS PASS**,
  2. **NO NEW LINTING OR STATIC ANALYSIS ISSUES**,
  3. **DESIGN DOCUMENTATION IS UP TO DATE**,
  4. **PATCH VERSION NUMBER IS INCREMENTED**
* git push is the users responsibility.
  **DO NOT TRY AND GIT PUSH THE PROJECT**
