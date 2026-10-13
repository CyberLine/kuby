/**
 * JSONPath unit checks against src/utils/jsonPath.ts
 * Run: node --experimental-strip-types scripts/test-jsonpath.mjs
 */
import { evalJsonPath, tokenizeJsonPath } from "../src/utils/jsonPath.ts";

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

const obj = {
  metadata: { name: "demo", creationTimestamp: "2024-01-01T00:00:00Z" },
  spec: { replicas: 3 },
  status: {
    conditions: [
      { type: "Available", status: "True" },
      { type: "Ready", status: "False" },
    ],
  },
};

assertEq(evalJsonPath(obj, ".spec.replicas"), "3", "spec.replicas");
assertEq(
  evalJsonPath(obj, '.status.conditions[?(@.type=="Ready")].status'),
  "False",
  "Ready condition",
);
assertEq(
  evalJsonPath(obj, ".metadata.creationTimestamp"),
  "2024-01-01T00:00:00Z",
  "creationTimestamp",
);
assertEq(evalJsonPath(obj, ".missing.path"), "", "missing path");
assertEq(tokenizeJsonPath("$.spec.replicas").join("|"), "spec|replicas", "tokenize");

if (!process.exitCode) console.log("all jsonpath checks passed");
