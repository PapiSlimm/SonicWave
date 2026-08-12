import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmountToCents, addCents, formatCents, cents } from "../src/money.ts";

test("parses decimal strings without float drift", () => {
  assert.equal(parseAmountToCents("9.99"), 999);
  assert.equal(parseAmountToCents("0.1") + parseAmountToCents("0.2"), 30); // the classic 0.1+0.2 trap
  assert.equal(parseAmountToCents("100"), 10000);
});

test("rejects non-integer cents", () => {
  assert.throws(() => cents(9.99), /integer number of cents/);
});

test("adds exactly", () => {
  assert.equal(addCents(cents(999), cents(1)), 1000);
});

test("formats for display only at the edge", () => {
  assert.equal(formatCents(cents(999)), "$9.99");
});
