// The runtime config contract: present, well-formed, and safe defaults.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadLib } = require("./lib-loader");

const { CadConfig } = loadLib("config.js");

test("config exposes the full contract", () => {
  assert.equal(typeof CadConfig.BASE_URL, "string");
  assert.ok(CadConfig.BASE_URL.startsWith("https://"), "BASE_URL is absolute https");
  assert.ok(CadConfig.BASE_URL.endsWith("/"), "BASE_URL keeps its trailing slash");
  assert.equal(typeof CadConfig.BASE_LABEL, "string");
  assert.ok(!/^https?:/.test(CadConfig.BASE_LABEL), "BASE_LABEL is a label, not a URL");
  assert.ok(!CadConfig.RELAY_URL.endsWith("/"), "RELAY_URL has no trailing slash");
  assert.equal(typeof CadConfig.ASK_ENABLED, "boolean");
  assert.equal(CadConfig.ASK_ENABLED, false, "Ask stays off until the owner flips BOTH switches");
  assert.equal(typeof CadConfig.RELEASE, "string");
});

test("the domain never contains the DCI trademark", () => {
  assert.ok(!/dci/i.test(new URL(CadConfig.BASE_URL).hostname.split(".")[0]),
    "keep 'DCI' out of the site's own name (repo path is fine)");
});
