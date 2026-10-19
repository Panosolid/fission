// readDesignDocument checks the form of every solid feature, not only the
// last one (from 24d1 every solid feature is its own body), and a
// profile's kind that isn't text is refused in words (issue #139: an array
// there reached Object.hasOwn, which turned it into text and threw the
// engine's "Cannot convert object to primitive value"). A profile's id that
// isn't text is refused the same way (issue #139 again: an object whose
// toString is not a function reached the id check's regular expression,
// and the profile's own messages, which turn it into text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { insertPreset, partDocument, readDesignDocument } from "../src/document.ts";

/** A 10 mm cube, then a cylinder after it: two bodies. */
const twoBodies = () => JSON.parse(JSON.stringify(insertPreset(partDocument("box", 10, 10, 10), "cylinder", 5, 5, 5).doc));

test("a malformed size on an earlier solid feature is refused as it is on the last one", () => {
  const good = twoBodies();
  assert.doesNotThrow(() => readDesignDocument(good));
  for (const bad of ["x", null, [], {}]) {
    const first = twoBodies();
    first.timeline.features[0].intent.parameters.width = bad;
    assert.throws(() => readDesignDocument(first), /width must be a number/, `earlier box width ${JSON.stringify(bad)}`);
    const last = twoBodies();
    last.timeline.features[1].intent.parameters.diameter = bad;
    assert.throws(() => readDesignDocument(last), /diameter must be a number/, `last cylinder diameter ${JSON.stringify(bad)}`);
  }
  // A size the kernel refuses is the kernel's to judge when it builds
  // (the item fails), not the reader's: it is a number of mm.
  const tiny = twoBodies();
  tiny.timeline.features[0].intent.parameters.width = -5;
  assert.doesNotThrow(() => readDesignDocument(tiny));
});

test("a profile whose kind is not text is refused in words, earlier or last", () => {
  for (const kind of [[["a", { toString: {} }]], { toString: 1 }, 7, null, ["plate"]]) {
    const doc = JSON.parse(JSON.stringify(partDocument("plate", 40, 30, 5)));
    doc.profiles[0].kind = kind;
    assert.throws(() => readDesignDocument(doc), /profile profile-\d+ has an unknown kind/, JSON.stringify(kind));
    const earlier = JSON.parse(JSON.stringify(insertPreset(partDocument("plate", 40, 30, 5), "box", 5, 5, 5).doc));
    earlier.profiles[0].kind = kind;
    assert.throws(() => readDesignDocument(earlier), /profile profile-\d+ has an unknown kind/, `earlier: ${JSON.stringify(kind)}`);
  }
});

test("a profile whose id is not text is refused in words, before anything turns it into text", () => {
  // The fuzzer's three shapes (an object whose toString is an object or
  // true, an array holding one) and the plain ones: none is a string, so
  // none can be one of Design's ids ("profile-1").
  for (const id of [{ toString: { "": 1 } }, [{ toString: "" }], { toString: true }, 7, null, ["profile-1"]]) {
    const doc = JSON.parse(JSON.stringify(partDocument("plate", 40, 30, 5)));
    doc.profiles[0].id = id;
    assert.throws(() => readDesignDocument(doc), /^Error: Design profile 1 has no id$/, JSON.stringify(id));
  }
  // The same file with its id as text still opens: the check refuses only the id.
  assert.doesNotThrow(() => readDesignDocument(JSON.parse(JSON.stringify(partDocument("plate", 40, 30, 5)))));
});
