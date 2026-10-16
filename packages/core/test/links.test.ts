import { test } from "node:test";
import assert from "node:assert/strict";
import { breakLink, fetchLinked, linkTo, resolveLink, type LinkSource, type SourceLookup } from "../src/model/links.ts";
import { RepresentationRegistry, type SolidRep } from "../src/model/representation.ts";

/** A tiny project: one part whose width the test can change. */
function setup() {
  let width = 40;
  let exists = true;
  const registry = new RepresentationRegistry();
  registry.registerProducer("part", "solid", (): SolidRep => ({ kind: "solid", spec: { box: { width, depth: 30, height: 20 } } }));
  const lookup: SourceLookup = (s) => (exists && s.origin.id === "feature-1" ? { type: "part", id: "feature-1" } : null);
  const source: LinkSource = { kind: "object", origin: { workspace: "design", id: "feature-1", label: "Feature 1 (box)" } };
  return { registry, lookup, source, setWidth: (w: number) => (width = w), remove: () => (exists = false) };
}

const widthOf = (r: unknown) => (r as SolidRep).spec as { box: { width: number } };

test("a paste makes a live link that follows the source", async () => {
  const { registry, lookup, source, setWidth } = setup();
  const link = linkTo("plate-model-1", source, ["solid", "mesh"]);
  assert.equal(link.mode, "live");
  assert.equal(widthOf((await fetchLinked(link, lookup, registry)).representation).box.width, 40);
  setWidth(55);
  assert.equal(widthOf((await fetchLinked(link, lookup, registry)).representation).box.width, 55);
});

test("breaking a link freezes what it showed, and the copy stops following", async () => {
  const { registry, lookup, source, setWidth } = setup();
  const frozen = await breakLink(linkTo("l", source, ["solid"]), lookup, registry);
  setWidth(99);
  assert.equal(frozen.mode, "frozen");
  assert.equal(widthOf(frozen.representation).box.width, 40);
  assert.deepEqual(frozen.source, source, "a frozen copy still knows where it came from");
  assert.deepEqual(resolveLink(frozen, lookup), { state: "frozen" });
});

test("a link whose source is gone warns, never breaks silently", async () => {
  const { registry, lookup, source, remove } = setup();
  const link = linkTo("l", source, ["solid"]);
  remove();
  const status = resolveLink(link, lookup);
  assert.deepEqual(status, {
    state: "unresolved",
    warning: "Linked to Feature 1 (box) in Design, which can't be found after the last edit. Pick a new source or break the link to keep the last copy.",
  });
  await assert.rejects(fetchLinked(link, lookup, registry), /can't be found after the last edit/);
});
