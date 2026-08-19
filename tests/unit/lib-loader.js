// Loads a docs/lib/*.js browser module and returns the `window` globals it
// defined. The lib files are plain IIFE scripts with no DOM or fetch
// dependencies — that's the contract that keeps them testable.
//
// Evaluated in THIS realm (not a vm sandbox) on purpose: a sandbox gives the
// module its own Object/Array intrinsics, so every value it returns fails
// assert.deepStrictEqual against a host-realm literal even when structurally
// identical. Same-realm evaluation keeps assertions honest.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function loadLib(file) {
  const full = path.join(__dirname, "..", "..", "docs", "lib", file);
  const code = fs.readFileSync(full, "utf8");
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", code + "\n//# sourceURL=" + full)(win);
  return win;
}

module.exports = { loadLib };
