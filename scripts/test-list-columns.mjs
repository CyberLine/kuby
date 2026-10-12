/**
 * listColumns prefs / printer id checks
 * Run: node --experimental-strip-types scripts/test-list-columns.mjs
 */
import {
  availableColumns,
  printerColumnId,
  readColumnPrefs,
  shouldSkipPrinterColumn,
  toggleColumnHidden,
  visibleColumns,
} from "../src/utils/listColumns.ts";

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}: got ${a}, want ${e}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

assertEq(shouldSkipPrinterColumn("Name"), true, "skip Name");
assertEq(shouldSkipPrinterColumn("AGE"), true, "skip AGE");
assertEq(shouldSkipPrinterColumn("Ready"), false, "keep Ready");
assertEq(printerColumnId("Ready Replicas"), "printer:ready-replicas", "slug");

const caps = {
  namespace: true,
  node: false,
  version: false,
  status: false,
  summary: false,
  pods: false,
  metrics: false,
  expires: false,
};
const printer = [
  { name: "Name", type: "string", jsonPath: ".metadata.name", priority: 0 },
  {
    name: "Ready",
    type: "string",
    jsonPath: '.status.conditions[?(@.type=="Ready")].status',
    priority: 0,
  },
  { name: "Node", type: "string", jsonPath: ".spec.nodeName", priority: 1 },
  { name: "Age", type: "date", jsonPath: ".metadata.creationTimestamp", priority: 0 },
];
const avail = availableColumns(caps, printer);
assertEq(
  avail,
  ["name", "namespace", "printer:ready", "printer:node", "age"],
  "available with printer",
);

const visDefault = visibleColumns({}, "Bar", avail);
assertEq(visDefault.includes("printer:ready"), false, "printer default hidden");
assertEq(visDefault.includes("name"), true, "name still visible");

const enabled = toggleColumnHidden({}, "Bar", avail, "printer:ready");
assertEq(enabled.enabledPrinterColumns, ["printer:ready"], "global enabled list");
const visEnabled = visibleColumns(enabled, "Bar", avail);
assertEq(visEnabled.includes("printer:ready"), true, "printer enabled via toggle");
assertEq(visEnabled.includes("printer:node"), false, "other printer still hidden");

// Same preference applies to another kind / "cluster".
const visOtherKind = visibleColumns(enabled, "OtherKind", avail);
assertEq(visOtherKind.includes("printer:ready"), true, "enabled across kinds");

// localStorage stub: migrate per-kind map + new global field
globalThis.localStorage = {
  getItem: () =>
    JSON.stringify({
      hiddenByKind: { Foo: ["namespace"] },
      enabledPrinterByKind: { Foo: ["printer:ready"], Baz: ["printer:node"] },
      enabledPrinterColumns: ["printer:status"],
    }),
  setItem() {},
};
const prefs = readColumnPrefs();
assertEq(
  prefs.enabledPrinterColumns?.sort(),
  ["printer:node", "printer:ready", "printer:status"],
  "migrate + merge enabled printers",
);
const visStored = visibleColumns(prefs, "Foo", avail);
assertEq(visStored.includes("namespace"), false, "fixed hidden from prefs");
assertEq(visStored.includes("printer:ready"), true, "migrated ready visible");
assertEq(visStored.includes("printer:node"), true, "migrated node visible");

if (!process.exitCode) console.log("all listColumns checks passed");
