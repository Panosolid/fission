// The timeline (steps 24-25) on the real kernel: PENDING until the
// substeps that build it land. Each check below is marked todo with the
// substep it waits for (docs/progress/cad.md, "Timeline test plan"), so the
// list shows what is still unchecked and none of it can pass by accident.
// When a substep lands, its checks get bodies here (or in the kernel's own
// tests, for the kernel ones) the same day, and leave the todo list.
//
// The harness they use already exists and is tested against planted bugs:
// src/timeline-model.ts (the model) and src/timeline-session.ts (the
// seeded sessions; Design's timeline plugs in as a TimelineSubject).
import { test } from "node:test";

const pending = (name: string, substep: string) => test(name, { todo: `waits for ${substep}` });

pending("the kernel reports each face's role (an extrude's start, end and the side of each outline piece; a box's six directions; a cylinder's bottom, top and side; a sphere's halves) with its area and centroid, hand-worked for a 40 × 30 × 10 rectangle, a slot and a clockwise outline", "24b");
pending("Design names every face from its feature id, role and sketch curve id, the model's names exactly, for every case in test/timeline-model.test.ts", "24c");
pending("a selected face keeps its name through an edit that renumbers the kernel's faces (a corner moved, a side deleted and redrawn elsewhere), and a face that is gone is dropped with a note", "24c");
pending("the model's hand-worked rebuilds give the same volumes, names, areas and centroids on the real kernel", "24d");
pending("presets are ordinary features with counter ids; every solid feature is its own body; a version 2 file migrates to the timeline's version and opens byte-identical after one save", "24d");
pending("seeded sessions: Design's timeline as a TimelineSubject passes runSession for 12 seeds × 150 steps, reaching every kind of outcome", "24d");
pending("delete, reorder, suppress and the marker on the real document, each one undo step; refused reorders give their exact messages", "24e");
pending("each planted bug of MODEL_FAULTS, planted by hand once in Design's code, is caught by its check (recorded in the substep's line)", "24e");
pending("the timeline in the browser at 1280 and 375 px in Chromium, Firefox and WebKit: rows in build order, the marker dragged and tapped, suppress and delete from a row, failed items marked; pixel probes for each body drawn", "24f");
pending("editing an early feature rebuilds everything after it; references re-resolve through their names; one that can't shows a warning on the item holding it", "25a");
pending("project-fuzz with timelines (items, marker, suppressed, failed items) opens, shows and saves byte-identical; history-fuzz with timeline edits", "25b");
pending("naming success rate (references the model says survive, resolved to the right face) in tests/baseline.json at 100%, with the owner's OK", "25b");
