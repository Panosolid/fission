// The guide's words (Guide, opened from the top bar): how Design works and
// how the kernel works underneath, one chapter per idea, in plain words for
// someone who builds things but has never used CAD. Each chapter names the
// 3D scene drawn behind it (scenes.ts) and the special words it explains;
// a word is always explained in the first chapter that uses it, and the
// last chapter lists every word (tests check both). Anything not built yet
// says so in its own text: the guide never pretends.

export type SceneId =
  | "hero"
  | "parametric"
  | "sketch"
  | "extrude"
  | "timeline"
  | "history"
  | "constraints"
  | "stack-journey"
  | "stack-rust"
  | "stack-wasm"
  | "brep"
  | "coedges"
  | "curves"
  | "placement"
  | "tolerance"
  | "validate"
  | "mesh"
  | "volume"
  | "precision"
  | "boolean"
  | "testing"
  | "workspaces"
  | "assistant";

export interface Term {
  term: string;
  meaning: string;
  /** How the word is spotted in text, when more than the word and its plural (case is ignored). */
  match?: RegExp;
}

export type Status = "built" | "partly" | "planned";

export interface Chapter {
  id: string;
  part: "Using Design" | "Inside the kernel" | "Around the kernel" | "Words";
  title: string;
  /** built: works today; partly: some of it works ("being built" or "not built yet" says which); planned: "not built yet". */
  status: Status;
  text: string[];
  terms: Term[];
  scene: SceneId;
  /** The sky colour behind this chapter's scene. */
  tint: string;
}

export const CHAPTERS: Chapter[] = [
  {
    id: "welcome",
    part: "Using Design",
    title: "How Fission works",
    status: "built",
    text: [
      "Fission is a free CAD app for designing real things. You draw a part with exact sizes, and the same project can later be rendered, printed, cut on a laser or milled on a CNC machine.",
      "This guide goes from what you see on screen down to the maths underneath. Scroll to move through it; the picture follows you. Drag the picture to turn it.",
    ],
    terms: [
      { term: "CAD", meaning: "Computer-aided design: drawing real objects on a computer with exact sizes, so they can be made." },
      { term: "CNC", meaning: "A machine that cuts material away with a spinning tool, following a path the computer gives it." },
      { term: "project", meaning: "Everything you made, in every part of the app, kept together in one .fission.json file." },
    ],
    scene: "hero",
    tint: "#2747ff",
  },
  {
    id: "parametric",
    part: "Using Design",
    title: "A part is a recipe",
    status: "built",
    text: [
      "In Fission a part is not a lump of clay you push around. It is a recipe: a list of steps, each with numbers you typed, like a box 40 mm wide.",
      "Change a number and the recipe runs again, so the shape follows. That is what parametric means: the shape comes from its parameters. Scroll, and watch the width change.",
    ],
    terms: [
      { term: "parameter", meaning: "A number in the recipe that you can change later, like a width or a hole size." },
      { term: "parametric", meaning: "Built from a recipe of steps and numbers, so changing a number rebuilds the shape." },
    ],
    scene: "parametric",
    tint: "#3a3df0",
  },
  {
    id: "sketch",
    part: "Using Design",
    title: "Sketches: drawing on a flat sheet",
    status: "built",
    text: [
      "Most parts start as a sketch: a flat drawing on a plane, like drawing on a sheet of paper laid on a table or stuck to a wall.",
      "You draw lines, rectangles, circles and arcs. Clicks can snap to the grid, to the middle of a line or to the end of another, so points that should meet really do meet.",
      "When the lines join into a loop with no gaps and no crossings, the loop is a profile. Before anything is built, the kernel checks the loop: closed, not crossing itself, and every piece at least a micrometre long.",
    ],
    terms: [
      { term: "sketch", meaning: "A flat drawing of lines, arcs and circles on a plane; the start of most parts." },
      { term: "plane", meaning: "A perfectly flat surface that goes on forever; a sketch is drawn on one." },
      { term: "snapping", meaning: "Pulling a click onto a nearby exact spot (a grid point, a midpoint, an end) so it lands precisely.", match: /\bsnap(s|ping)?\b/i },
      { term: "profile", meaning: "A closed loop of sketch lines with no gaps or crossings; the shape a solid is made from." },
      { term: "loop", meaning: "A closed ring with no gaps: a profile in a sketch, or the ring of edges round a face (one more for each hole in it)." },
      { term: "kernel", meaning: "The maths engine inside Fission that builds, checks and measures every shape." },
    ],
    scene: "sketch",
    tint: "#1f5fe0",
  },
  {
    id: "extrude",
    part: "Using Design",
    title: "Extrude: from flat to solid",
    status: "built",
    text: [
      "Extrude pushes a profile straight out of its plane, like squeezing icing through a shaped nozzle. A rectangle becomes a block; a circle becomes a rod; the slot here becomes a bar with rounded ends.",
      "You type the distance. The volume Fission shows is worked out exactly from the shape, never estimated from the picture, so a rod 20 mm across and 10 mm long reads 1000π mm³.",
    ],
    terms: [{ term: "extrude", meaning: "Push a profile straight out of its plane by a distance to make a solid.", match: /\bextrud(e|es|ed|ing)\b/i }],
    scene: "extrude",
    tint: "#2a6bd6",
  },
  {
    id: "timeline",
    part: "Using Design",
    title: "The timeline: the recipe, in order",
    status: "partly",
    text: [
      "Every step you take is a feature, kept in order on the timeline: Sketch 1, Extrude 1, Sketch 2 and so on. Fission already lists your sketches and extrudes there and saves them with the project.",
      "The goal is that you can go back, change an early feature, and everything after it replays. That replaying, and the rules for what happens when a later step loses what it was built on, are being built now.",
      "Replaying is harder than it sounds. A later step might say put a hole on the top side. After an edit, which side is the top one? Giving every side a name that survives a rebuild is called topological naming, and Fission is building it in.",
    ],
    terms: [
      { term: "feature", meaning: "One step in the timeline: a sketch, an extrude, later a fillet or a hole." },
      { term: "timeline", meaning: "The list of features in the order they were made; replaying it rebuilds the part." },
      { term: "topological naming", meaning: "Giving each side and edge of a part a name that survives a rebuild, so later steps still find what they were attached to." },
    ],
    scene: "timeline",
    tint: "#5236e0",
  },
  {
    id: "history",
    part: "Using Design",
    title: "Undo and your project file",
    status: "built",
    text: [
      "The whole project is one file, a .fission.json. Every area of the app keeps its share of the project in it, and Fission saves it in your browser a moment after each change.",
      "Undo works on that whole project: each change you make becomes one step you can take back or do again, whichever area of the app made it.",
    ],
    terms: [],
    scene: "history",
    tint: "#4b3fd0",
  },
  {
    id: "constraints",
    part: "Using Design",
    title: "Constraints and dimensions",
    status: "planned",
    text: [
      "Today a sketch stays exactly where you clicked. Real parts need rules too: this line stays level, these two are the same length, this gap is 20 mm.",
      "Those rules are constraints, and a dimension is a constraint with a number. A solver moves the points until every rule holds at once, like the wobbly outline settling into a true rectangle here.",
      "This is not built yet. Its answers will be checked against SolveSpace, another free CAD program, as a second opinion.",
    ],
    terms: [
      { term: "constraint", meaning: "A rule a sketch must keep, like level, the same length or touching." },
      { term: "dimension", meaning: "A constraint with a number: this line is 20 mm, this angle is 30°." },
      { term: "solver", meaning: "The maths that moves sketch points until every constraint holds at once." },
    ],
    scene: "constraints",
    tint: "#6a2fd8",
  },
  {
    id: "journey",
    part: "Inside the kernel",
    title: "From your click to a shape",
    status: "built",
    text: [
      "Under the buttons, Fission has two halves. The app draws the screen and keeps your project. The kernel does the geometry: it builds shapes, checks them and measures them.",
      "When you press OK on an extrude, the app sends the profile and the distance to the kernel, which runs in the background of your browser tab so the screen never freezes. The kernel sends back the solid, its exact volume, and triangles to draw.",
      "Keeping the halves apart means the maths can be tested on its own, on thousands of random shapes every night, without a browser.",
    ],
    terms: [{ term: "geometry", meaning: "The exact shape of each piece: this side is flat, that edge is a perfect circle of radius 5 mm." }],
    scene: "stack-journey",
    tint: "#1d4fd8",
  },
  {
    id: "rust",
    part: "Inside the kernel",
    title: "Rust: the kernel's language",
    status: "built",
    text: [
      "The kernel is written in Rust, a programming language that runs as fast as C++ (what most paid CAD is written in) but its compiler refuses to build programs with a whole family of mistakes, like using memory that was already given back.",
      "Fission adds its own rule on top: no kernel operation may crash, whatever it is given. A nonsense request gets a clear invalid input answer instead.",
    ],
    terms: [
      { term: "Rust", meaning: "A fast programming language whose compiler refuses code with many common mistakes; the kernel is written in it." },
      { term: "compiler", meaning: "The program that turns code a person writes into instructions a computer runs." },
    ],
    scene: "stack-rust",
    tint: "#c2410c",
  },
  {
    id: "wasm",
    part: "Inside the kernel",
    title: "WebAssembly: the kernel in your browser",
    status: "built",
    text: [
      "Browsers normally run JavaScript. WebAssembly (WASM) is a second, compact language that browsers run almost as fast as an installed program.",
      "The Rust kernel is compiled into WebAssembly, so the whole kernel runs inside your browser tab on your own computer: nothing to install, and no shape is sent to a server.",
      "The same Rust also builds as a normal program for testing. Fission makes sure both give bit-for-bit the same answers, even for sine and cosine, by doing that maths in its own code instead of trusting each computer's.",
    ],
    terms: [
      { term: "WebAssembly", meaning: "A compact program format browsers run at near-installed speed; the kernel is compiled into it.", match: /\b(WebAssembly|WASM)\b/i },
      { term: "JavaScript", meaning: "The language every browser runs; the app around the kernel is written in TypeScript, JavaScript with checked types.", match: /\b(JavaScript|TypeScript)\b/i },
    ],
    scene: "stack-wasm",
    tint: "#6d28d9",
  },
  {
    id: "brep",
    part: "Inside the kernel",
    title: "B-rep: a solid is stored as its skin",
    status: "built",
    text: [
      "The kernel stores a solid by its skin: the surfaces that wrap it, and exactly how they meet. That is a B-rep, short for boundary representation.",
      "Scroll and the bracket comes apart into its skin. Each face is one smooth piece of surface. Faces meet along edges. Edges end at vertices.",
      "This bracket has 10 faces (one is the inside of the hole and one is the curved corner), 24 edges and 16 vertices. Nothing is approximated: the hole is a perfect circle.",
    ],
    terms: [
      { term: "B-rep", meaning: "Boundary representation: a solid stored as its skin of faces, edges and vertices, each with an exact shape." },
      { term: "face", meaning: "One smooth piece of a solid's skin: a flat side, the inside of a hole, a rounded corner." },
      { term: "edge", meaning: "Where two faces meet: a straight line, an arc or a full circle." },
      { term: "vertex", meaning: "A point where edges end. Plural: vertices.", match: /\b(vertex|vertices)\b/i },
    ],
    scene: "brep",
    tint: "#1b4dff",
  },
  {
    id: "coedges",
    part: "Inside the kernel",
    title: "Topology: what touches what",
    status: "built",
    text: [
      "A B-rep has two halves. Geometry is the exact shapes. Topology is the connections: which edges go round which face, which faces share an edge.",
      "Each face is bounded by loops: an outer loop, plus one more for each hole. A loop is made of coedges, each one a use of an edge in a direction. Every edge is used exactly twice, once by each of its two faces and in opposite directions, like the two halves of a zip.",
      "The counts must also add up. Vertices − edges + faces − holes in faces = 2 − 2 × (holes through the part). The bracket: 16 − 24 + 10 − 2 = 0, so it has exactly one hole through it. A count that comes out wrong means a broken solid.",
    ],
    terms: [
      { term: "topology", meaning: "Which pieces of a B-rep connect to which, ignoring their exact shapes." },
      { term: "coedge", meaning: "One use of an edge by a face, with a direction; each edge has exactly two." },
    ],
    scene: "coedges",
    tint: "#0f6fb8",
  },
  {
    id: "curves",
    part: "Inside the kernel",
    title: "Exact curves and surfaces",
    status: "partly",
    text: [
      "Under every edge is an exact curve and under every face an exact surface. Today the kernel knows lines and circles, and planes, cylinders and spheres: enough for blocks, rods, holes, slots and balls.",
      "Free-form shapes, like a car body or a phone's rounded back, need NURBS: smooth curves pulled into shape by control points, like a bendy ruler held by pins. Scroll to drag a point. NURBS are not built yet.",
    ],
    terms: [
      { term: "NURBS", meaning: "Smooth free-form curves and surfaces shaped by control points; the standard in CAD for anything not a simple shape." },
      { term: "control point", meaning: "A point that pulls a NURBS curve towards it without the curve passing through it." },
    ],
    scene: "curves",
    tint: "#0e7490",
  },
  {
    id: "placement",
    part: "Inside the kernel",
    title: "Moving a part without changing it",
    status: "built",
    text: [
      "Each body keeps its shape in its own small world, plus a placement: one turn and one shift that put it where it sits in your design.",
      "Moving or turning a part changes only the placement, so the exact shape is never rounded again and again. The turn is stored as a quaternion, four numbers that describe any turn without the gimbal lock that three angles suffer from.",
    ],
    terms: [
      { term: "placement", meaning: "The turn and shift that put a body's shape where it sits, kept apart from the shape itself." },
      { term: "quaternion", meaning: "Four numbers that describe a turn in 3D smoothly, with no angle where it gets stuck." },
    ],
    scene: "placement",
    tint: "#0f766e",
  },
  {
    id: "tolerance",
    part: "Inside the kernel",
    title: "Tolerance: how close counts as touching",
    status: "built",
    text: [
      "Computers round every number a tiny bit, so two corners that should meet can end up a hair apart. Fission's tolerance is 10 nanometres, thousands of times thinner than a human hair: points closer than that are the same point.",
      "Scroll to close the gap. At 11 nm the two ends are still apart; at 9 nm they count as one. The tolerance lives in one place in the kernel, and parts from 1 micrometre to 1 kilometre stay well inside what it can handle.",
    ],
    terms: [{ term: "tolerance", meaning: "The distance under which two points count as the same: 10 nanometres in Fission." }],
    scene: "tolerance",
    tint: "#15803d",
  },
  {
    id: "validate",
    part: "Inside the kernel",
    title: "Every result is checked",
    status: "built",
    text: [
      "Before any shape reaches you, the kernel checks it, a step called validation. Is the skin closed, with every edge used twice in opposite directions? Do the counts add up? Does every edge lie on both its faces to within the tolerance?",
      "It also checks that no face or edge passes through another, that the outside faces outwards, and that the triangles drawn on screen close up with no cracks. A shape that fails is never shown as if it were fine.",
    ],
    terms: [{ term: "validation", meaning: "The kernel's check of every result: closed, consistent, within tolerance, not passing through itself.", match: /\bvalidat(e|es|ed|ion)\b/i }],
    scene: "validate",
    tint: "#16a34a",
  },
  {
    id: "mesh",
    part: "Inside the kernel",
    title: "Meshes: the triangles on screen",
    status: "built",
    text: [
      "Screens and 3D printers do not understand exact curves. They want flat triangles, so the kernel cuts each face into a mesh just for drawing and exporting. Scroll and the cylinder drops from smooth to a few flat sides.",
      "Each edge is cut once and both its faces share those same points, so the mesh has no cracks. Inside each face, the triangles are chosen to be as even as possible.",
      "STL, the file most 3D printers read, is just this list of triangles. Measurements never come from the triangles; they come from the exact B-rep.",
    ],
    terms: [
      { term: "mesh", meaning: "A surface made of flat triangles; what the screen draws and what STL files hold." },
      { term: "STL", meaning: "The file format most 3D printers read: a plain list of triangles." },
    ],
    scene: "mesh",
    tint: "#ca8a04",
  },
  {
    id: "volume",
    part: "Inside the kernel",
    title: "Measuring exactly from the skin",
    status: "built",
    text: [
      "How do you get the volume of a solid you only store the skin of? The divergence theorem: add up, over every face, its area times how far it sits out from a fixed point, along its outward direction, and divide by three.",
      "A 10 mm cube with a corner at the fixed point: the three faces touching that corner sit 0 away and add nothing. The other three each give 10 × 100, so 3000 ÷ 3 = 1000 mm³, exactly right.",
      "Curved faces have exact formulas too, so a rod's volume comes out with π in it, not as a guess from triangles.",
    ],
    terms: [{ term: "divergence theorem", meaning: "The maths rule that turns a sum over a solid's inside into a sum over its skin; how the kernel gets exact volumes." }],
    scene: "volume",
    tint: "#b45309",
  },
  {
    id: "precision",
    part: "Inside the kernel",
    title: "When normal numbers are not enough",
    status: "built",
    text: [
      "A computer number keeps about 16 digits. Take two huge numbers that are almost equal and subtract them, and most of those digits cancel out, leaving mostly rounding.",
      "Where that can happen, like the volume of a thin part far from the middle, the kernel carries each number as two, a big part plus the tiny error, for about 32 digits; this is called double-double. For yes-or-no questions, like which way a loop turns, it keeps every digit, so the answer is never wrong.",
    ],
    terms: [{ term: "double-double", meaning: "Keeping a number as two ordinary numbers, a value plus its rounding error, for about twice the digits." }],
    scene: "precision",
    tint: "#9d174d",
  },
  {
    id: "booleans",
    part: "Inside the kernel",
    title: "Booleans: join, cut, intersect",
    status: "planned",
    text: [
      "A boolean combines two solids. Join keeps both. Cut takes one away from the other, which is how a hole is drilled. Intersect keeps only the part they share. Scroll through all three.",
      "Booleans are the hardest part of any kernel: the two skins must be cut exactly where they cross, and the pieces stitched back into one valid skin. They are not built yet; their design has been reviewed and they follow the timeline work.",
    ],
    terms: [{ term: "boolean", meaning: "Combining two solids by join, cut or intersect." }],
    scene: "boolean",
    tint: "#be123c",
  },
  {
    id: "testing",
    part: "Inside the kernel",
    title: "How Fission is tested",
    status: "built",
    text: [
      "Geometry bugs are quiet: a face a ten-thousandth of a millimetre off looks fine until something fails three steps later. So nothing counts as done until a test checks it automatically.",
      "Some tests have answers worked out by hand. Random tests throw thousands of shapes at the kernel, each from a seed so a failure replays exactly. Fuzzing feeds it deliberately broken input. OpenCascade, a separate free kernel, acts as an oracle for volumes.",
      "Mutation testing breaks the kernel's code on purpose, one small change at a time, to prove the tests notice. And browser tests click through the real app, this guide included.",
    ],
    terms: [
      { term: "seed", meaning: "The starting number of a random test; the same seed always makes the same test, so failures replay." },
      { term: "fuzzing", meaning: "Feeding a program huge amounts of strange or broken input to find crashes." },
      { term: "oracle", meaning: "A separate, trusted program whose answers ours are compared with." },
      { term: "mutation testing", meaning: "Breaking the code on purpose to check that some test fails." },
    ],
    scene: "testing",
    tint: "#0369a1",
  },
  {
    id: "workspaces",
    part: "Around the kernel",
    title: "One project, ten workspaces",
    status: "partly",
    text: [
      "Design is where parts are made. Around it sit Render, Simulate, Manufacture, Laser, Slice, Circuit, Vector, Image and Layout, all reading the same project, so a change in Design shows up everywhere with no exporting.",
      "Design is real today and Image has its first tools. The other workspaces are placeholders that say so; they are being built one at a time.",
    ],
    terms: [{ term: "workspace", meaning: "One area of the app for one kind of work, like Design or Slice; all share the same project." }],
    scene: "workspaces",
    tint: "#4338ca",
  },
  {
    id: "assistant",
    part: "Around the kernel",
    title: "The optional AI assistant",
    status: "partly",
    text: [
      "The assistant is off unless you turn it on, and you choose what runs it: Chrome's built-in model, one downloaded into the browser, Ollama on your computer, or your own key for an AI company.",
      "It can only use the same commands you can. It shows a preview of what would change; you accept or reject, and an accepted change is one undo step. It never controls a printer, laser or CNC machine. Today it can change Design's starting shape; more is not built yet.",
    ],
    terms: [{ term: "preview", meaning: "A see-through picture of what a change would do, before anything changes." }],
    scene: "assistant",
    tint: "#7c3aed",
  },
  {
    id: "words",
    part: "Words",
    title: "Every word in this guide",
    status: "built",
    text: ["Every special word from the guide, in one place."],
    terms: [],
    scene: "hero",
    tint: "#2747ff",
  },
];

/** Every term from every chapter, sorted A to Z (the last chapter shows these). */
export function glossary(chapters: Chapter[] = CHAPTERS): Term[] {
  return chapters.flatMap((c) => c.terms).sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
}

/** A regex that finds a term (its own match, or the word with an optional plural s/es), ignoring case. */
export function termPattern(t: Term): RegExp {
  if (t.match) return new RegExp(t.match.source, "i");
  const escaped = t.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(s|es)?(?![\\w-])`, "i");
}

/** Where the scroll is: the chapter whose box holds the middle of the screen, and how far through it (0 to 1). */
export function chapterAt(scrollTop: number, viewHeight: number, tops: number[], heights: number[]): { index: number; progress: number } {
  if (tops.length === 0) return { index: 0, progress: 0 };
  const middle = scrollTop + viewHeight / 2;
  let index = 0;
  for (let i = 0; i < tops.length; i++) if (middle >= tops[i]) index = i;
  const h = heights[index];
  const progress = h > 0 ? Math.min(1, Math.max(0, (middle - tops[index]) / h)) : 0;
  return { index, progress };
}

/** The chapter a key moves to from `index`, or null for a key that isn't for moving. */
export function chapterForKey(key: string, index: number, count: number): number | null {
  const clamp = (i: number) => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
    case "PageDown":
    case " ":
      return clamp(index + 1);
    case "ArrowUp":
    case "ArrowLeft":
    case "PageUp":
      return clamp(index - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * How far the camera stands from a scene's centre so a ball of `radius`
 * fills the given part of the screen: the narrower of the vertical field
 * of view and the horizontal one (from the aspect, width ÷ height) decides,
 * at distance radius ÷ sin(half that angle).
 */
export function cameraDistance(radius: number, verticalFovDeg: number, aspect: number): number {
  const halfV = (verticalFovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  return radius / Math.sin(Math.min(halfV, halfH));
}

/**
 * Where the scene sits on screen beside the words: on a wide screen the
 * words are on the left, so the scene's centre moves to 62% across; on a
 * tall or narrow one (under 760 px, or no wider than it is tall: the CSS's portrait) the words
 * are at the bottom, so it moves up to 30% down.
 * `area` is the part of the screen (width and height, as fractions) the
 * scene may fill.
 */
export function stageLayout(width: number, height: number): { centreX: number; centreY: number; areaW: number; areaH: number } {
  if (width >= 760 && width > height) return { centreX: 0.62, centreY: 0.5, areaW: 0.7, areaH: 0.9 };
  return { centreX: 0.5, centreY: 0.3, areaW: 0.95, areaH: 0.5 };
}
