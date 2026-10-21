import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { needsQuoting, stringifyYaml } from "../src/yaml-scalars.ts";

/** Values that must survive as strings in both YAML 1.1 and YAML 1.2 readers. */
const TRAPS = [
  "no", "No", "NO", "yes", "Yes", "y", "n", "on", "off", "true", "false",
  "null", "NULL", "~", "0755", "12:30", "1.10", "1.0", "007", "0x1f",
  ".inf", ".nan", "-3", "1e5", "", " padded", "padded ",
];

test("needsQuoting flags every coercion trap", () => {
  for (const v of TRAPS) {
    assert.equal(needsQuoting(v), true, `expected ${JSON.stringify(v)} to need quoting`);
  }
});

test("needsQuoting leaves ordinary words alone", () => {
  for (const v of ["open", "closed", "The thing is broken", "in-progress", "a_b"]) {
    assert.equal(needsQuoting(v), false, `expected ${JSON.stringify(v)} to stay bare`);
  }
});

test("emitted traps round-trip as strings under YAML 1.1 and 1.2", () => {
  const data = Object.fromEntries(TRAPS.map((v, i) => [`k${i}`, v]));
  const text = stringifyYaml(data);
  for (const version of ["1.1", "1.2"] as const) {
    const back = parse(text, { version }) as Record<string, unknown>;
    for (const [k, v] of Object.entries(data)) {
      assert.equal(back[k], v, `${k} changed under YAML ${version}`);
    }
  }
});

test("ordinary values are emitted without needless quotes", () => {
  assert.equal(stringifyYaml({ status: "open" }), "status: open\n");
});

test("non-string scalars keep their native types", () => {
  const text = stringifyYaml({ n: 3, f: 1.5, b: true, nil: null });
  assert.deepEqual(parse(text), { n: 3, f: 1.5, b: true, nil: null });
});
