#!/usr/bin/env node
/* Fixture test for bug #21: UIL State placements must render as places
 * ("1st", "3rd"), never as Division ratings ("I", "III"), in the derived
 * family engine's generic views.
 *
 *   node scripts/test_uil_rendering.js
 *
 * It extracts the REAL normKind and score3 from the built engine
 * (docs/family/app.js) — not a reimplementation — and drives them with
 * UIL-shaped rows: region rows carry {rating}, State rows carry
 * {placement}, and the two must come out visually distinct.
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "docs", "family", "app.js"), "utf8");

const pass = [], fail = [];
const ok = (c, m) => (c ? pass : fail).push(m);

// pull the exact definitions out of the built engine (brace-aware, since
// normKind spans multiple lines)
function extract(name) {
  const tag = `const ${name} = `;
  const start = src.indexOf(tag);
  if (start < 0) throw new Error(`could not find ${name} in the built engine`);
  let i = start + tag.length, depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const ch = src[i], prev = src[i - 1];
    if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) break;
  }
  return src.slice(start + tag.length, i);
}
function build(resKind) {
  const ctx = `const FAM = { resultsKind: ${JSON.stringify(resKind)} };
    const ORD = ${extract("ORD")};
    const RES_KIND = FAM.resultsKind;
    const normKind = ${extract("normKind")};
    const score3 = ${extract("score3")};
    return { normKind, score3 };`;
  return new Function(ctx)();
}

// ── UIL (resultsKind 'rating'): region ratings vs State placements ──────
{
  const { normKind, score3 } = build("rating");
  const rows = normKind([
    { corps: "Region band", score: null, rating: 1 },
    { corps: "Region band 2", score: null, rating: 3 },
    { corps: "State champion", score: null, placement: 1 },
    { corps: "State 3rd", score: null, placement: 3 },
    { corps: "State 12th", score: null, placement: 12 },
  ]);
  ok(score3(rows[0].score) === "I", `rating 1 renders as Division I (got ${score3(rows[0].score)})`);
  ok(score3(rows[1].score) === "III", `rating 3 renders as Division III (got ${score3(rows[1].score)})`);
  ok(score3(rows[2].score) === "1st", `State placement 1 renders as 1st (got ${score3(rows[2].score)})`);
  ok(score3(rows[3].score) === "3rd", `State placement 3 renders as 3rd — NOT Division III (got ${score3(rows[3].score)})`);
  ok(score3(rows[4].score) === "12th", `State placement 12 renders as 12th (got ${score3(rows[4].score)})`);
  ok(score3(null) === "—", "null still renders as an em dash");
}

// ── pure placement circuits keep plain ordinals ─────────────────────────
{
  const { normKind, score3 } = build("placement");
  const rows = normKind([{ corps: "x", score: null, placement: 2 }]);
  ok(score3(rows[0].score) === "2nd", `placement circuit renders 2nd (got ${score3(rows[0].score)})`);
}

// ── an existing real score is never overwritten by normKind ─────────────
{
  const { normKind } = build("rating");
  const rows = normKind([{ corps: "x", score: 87.5, rating: 1 }]);
  ok(rows[0].score === 87.5, "a real score survives normKind untouched");
}

console.log(`PASS ${pass.length}`);
pass.forEach((m) => console.log("  ok   " + m));
if (fail.length) {
  console.log(`FAIL ${fail.length}`);
  fail.forEach((m) => console.log("  FAIL " + m));
  process.exit(1);
}
