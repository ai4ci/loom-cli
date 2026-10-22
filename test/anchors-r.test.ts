import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeComment, extractAnchors, resolveAnchor } from "../src/source.ts";

const names = (code: string) => extractAnchors(code, "r").map((a) => a.fullName);

test("plain assignment forms become anchors", () => {
  const r = `fit <- function(df) { df }
scale_it = function(v) { v }
lam <- \\(x) { x }`;
  assert.deepEqual(names(r), ["fit", "scale_it", "lam"]);
});

test("nested functions get dotted names", () => {
  const r = `outer <- function(df) {
  helper <- function(x) { x * 2 }
  helper(df)
}`;
  assert.deepEqual(names(r), ["outer", "outer.helper"]);
});

test("R functions carry a body span so they can be annotated", () => {
  const r = `fit <- function(df) {
  df
}`;
  const anchor = extractAnchors(r, "r")[0]!;
  assert.ok(anchor.bodySpan, "braced body must be carried through");
});

test("a one-liner has no body span and so cannot be annotated", () => {
  const r = `one <- function(x) x + 1`;
  const anchor = extractAnchors(r, "r")[0]!;
  assert.equal(anchor.bodySpan, undefined);
});

test("R6 methods are anchors qualified by the binding", () => {
  const r = `Counter <- R6::R6Class("Counter", public = list(
  add = function(n) { n },
  reset = function() { 0 }
))`;
  assert.deepEqual(names(r), ["Counter.add", "Counter.reset"]);
});

test("S7 validators and constructors are anchors, by the same rule", () => {
  const r = `Range <- new_class("Range",
  properties = list(start = class_double),
  validator = function(self) {
    if (length(self@start) != 1) "@start must be length 1"
  }
)`;
  assert.deepEqual(names(r), ["Range.validator"]);
});

test("registration through a function call is not an anchor", () => {
  const r = `setMethod("area", "Circle", function(shape) { pi })
method(print, Range) <- function(x, ...) { cat("r") }`;
  // S4 setMethod names its target in an argument value, and S7's method()<- has
  // a call on the left-hand side; neither is a binding.
  assert.deepEqual(names(r), []);
});

test("an anchor is never named after a call", () => {
  const r = `method(print, Range) <- function(x, ...) { cat("r") }`;
  // Would otherwise collide with the overload qualifier syntax.
  assert.equal(names(r).some((n) => n.includes("(")), false);
});

test("R anchors resolve and attribute", () => {
  const r = `fit <- function(df) {
  # implements: issue://x.md
  df
}`;
  const anchors = extractAnchors(r, "r");
  assert.equal(resolveAnchor(anchors, "fit").ok, true);
  assert.equal(attributeComment(r.indexOf("# implements"), anchors)?.fullName, "fit");
});

test("a nested R function shadowed by name is ambiguous, not silently first", () => {
  const r = `a <- function() { h <- function() { 1 } }
b <- function() { h <- function() { 2 } }`;
  const anchors = extractAnchors(r, "r");
  assert.deepEqual(names(r), ["a", "a.h", "b", "b.h"]);
  const bare = resolveAnchor(anchors, "h");
  assert.equal(!bare.ok && bare.reason, "ambiguous");
  assert.equal(resolveAnchor(anchors, "a.h").ok, true);
});
