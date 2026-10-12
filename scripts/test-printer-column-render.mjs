/**
 * Run: node --experimental-strip-types scripts/test-printer-column-render.mjs
 */
import {
  classifyPrinterColumn,
  registryUrlForImage,
  statusToneFromText,
} from "../src/utils/printerColumnRender.ts";

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
}

assertEq(classifyPrinterColumn({ name: "State", type: "string", priority: 0 }, "printer:state"), "status", "state→status");
assertEq(classifyPrinterColumn({ name: "Node", type: "string", priority: 0 }, "printer:node"), "node", "node");
assertEq(classifyPrinterColumn({ name: "Image", type: "string", priority: 0 }, "printer:image"), "image", "image");
assertEq(classifyPrinterColumn({ name: "Replicas", type: "integer", priority: 0 }, "printer:replicas"), "text", "replicas");

assertEq(statusToneFromText("running"), "ok", "running ok");
assertEq(statusToneFromText("stopped"), "warn", "stopped warn");
assertEq(statusToneFromText("faulted"), "err", "faulted err");

assertEq(
  registryUrlForImage("longhornio/longhorn-engine:v1.6.2"),
  "https://hub.docker.com/r/longhornio/longhorn-engine",
  "dockerhub user image",
);
assertEq(
  registryUrlForImage("ghcr.io/org/app:1.0"),
  "https://ghcr.io/org/app",
  "ghcr",
);
assertEq(registryUrlForImage("localhost:5000/foo:bar"), null, "localhost no link");

if (!process.exitCode) console.log("all printerColumnRender checks passed");
