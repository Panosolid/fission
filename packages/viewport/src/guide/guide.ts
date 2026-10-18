// The guide page (the top bar's Guide button, or a ?guide link): a full
// screen over the app that scrolls through the chapters. A 3D scene sits
// behind the words and follows the scroll (scenes.ts), with labels pinned
// to points in it. Arrow keys, Page Up/Down, Home and End jump between
// chapters; Space (or the Play button) plays it, scrolling at a steady pace
// until Space again, the reader's own scrolling, or the end; a hint on the
// first chapter says so; Escape or Close returns to the app with nothing in it
// changed. While open it keeps every key and clipboard event to itself, so
// the app's shortcuts never fire behind it. Styles: packages/ui
// src/styles/guide.css.
//
// Moving between chapters: Next, the keys and the dots glide the scroll
// (eased, chapters.ts glideAt) to exactly where the chapter's words come to
// rest, so they arrive and stop rather than jump. Each chapter's card fits
// the screen with no scroll bar of its own: its word list folds behind a
// button that turns the card over. On a narrow screen each card sits as
// high as it needs and the scene fills the space above it. Two canvases
// take turns: a new chapter's scene draws on the spare one and fades in
// while the old one fades out (chapters.ts blendAt), both still turning.

import * as THREE from "three";
import { CHAPTERS, blendAt, playStep, chapterAt, chapterForKey, glideAt, glideDuration, glossary, restingScroll, stageLayout, type Chapter } from "./chapters.ts";
import { GUIDE_FOV, aimCamera, buildScene, type GuideScene } from "./scenes.ts";

const SPIN = 0.07; // radians a second when motion is allowed
const BLEND_MS = 700; // how long one scene takes to fade into the next
const NARROW_TOP = 0.35; // where a scene is framed above the words when no card says otherwise
const NARROW_MIN_TOP = 0.2; // on a narrow screen a card starts no higher than this far down (the words are short enough to sit lower with the usual fonts; a wide font may need the room)
const WORDS_TOP = 72; // px below the top where the last chapter's long, unpinned list comes to rest (just under the bar)

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STATUS_NOTE: Record<Chapter["status"], string> = { built: "", partly: "Partly built", planned: "Not built yet" };

function chapterHtml(c: Chapter, i: number): string {
  const status = STATUS_NOTE[c.status] ? `<span class="guide-status" data-status="${c.status}">${STATUS_NOTE[c.status]}</span>` : "";
  const dl = (terms: Chapter["terms"]) => `<dl class="guide-terms">${terms.map((t) => `<div><dt>${escapeHtml(t.term)}</dt><dd>${escapeHtml(t.meaning)}</dd></div>`).join("")}</dl>`;
  const text = c.text.map((t) => `<p>${escapeHtml(t)}</p>`).join("");
  // The last chapter is the full list; every other card keeps its words on the back, behind a button naming them.
  const body =
    c.id === "words"
      ? text + dl(glossary())
      : c.terms.length === 0
        ? text
        : `<div class="guide-faces">
        <div class="guide-face" data-face="text">${text}<button type="button" class="guide-flip" aria-label="Explain the words: ${escapeHtml(c.terms.map((t) => t.term).join(", "))}"><span>Words</span> ${c.terms.map((t) => escapeHtml(t.term)).join(" · ")}</button></div>
        <div class="guide-face" data-face="words">${dl(c.terms)}<button type="button" class="guide-flip">← Back to the text</button></div>
      </div>`;
  return `<section class="guide-chapter" data-id="${c.id}" aria-labelledby="guide-h-${c.id}"${c.id === "words" ? ' data-words=""' : ""}>
    <div class="guide-card">
      <p class="guide-part">${escapeHtml(c.part)} · ${i + 1} of ${CHAPTERS.length}</p>
      <h2 id="guide-h-${c.id}">${escapeHtml(c.title)}</h2>${status}
      ${body}
    </div>
  </section>`;
}

let lastChapter = 0;

/** The dialog, with where each chapter's words rest and when each takes over (scroll px), for the browser tests. */
export type GuideDialog = HTMLDialogElement & { stops?: { rests: number[]; leads: number[] } };

/** Opens the guide; `opener` gets focus back when it closes. Returns the dialog (for tests). */
export function openGuide(opener?: HTMLElement | null): GuideDialog {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dialog = document.createElement("dialog");
  dialog.className = "guide";
  dialog.setAttribute("aria-labelledby", "guide-title");
  dialog.innerHTML = `
    <div class="guide-sky"></div>
    <canvas class="guide-canvas" aria-hidden="true"></canvas>
    <canvas class="guide-canvas" aria-hidden="true"></canvas>
    <svg class="guide-leaders" aria-hidden="true"></svg>
    <div class="guide-labels" aria-hidden="true"></div>
    <div class="guide-scroll" tabindex="-1">
      ${CHAPTERS.map(chapterHtml).join("")}
      <div class="guide-end"></div>
    </div>
    <header class="guide-bar">
      <h1 id="guide-title" class="guide-title">How Panoshape works</h1>
      <a class="guide-licences" href="third-party-licences.txt" target="_blank" rel="noopener" title="The licences of the free code Panoshape is built with, and their notices">Licences</a>
      <button type="button" class="guide-close">Close</button>
      <div class="guide-progress" aria-hidden="true"><i></i></div>
    </header>
    <nav class="guide-rail" aria-label="Chapters">${CHAPTERS.map((c, i) => `<button type="button" data-index="${i}" aria-label="${escapeHtml(c.title)}" title="${escapeHtml(c.title)}"></button>`).join("")}</nav>
    <p class="guide-hint" data-shown=""><span class="guide-hint-keys">Press <kbd>Space</kbd> to scroll through at a steady pace, and again to pause.</span><span class="guide-hint-touch">Tap <b>Play</b> to scroll through at a steady pace.</span></p>
    <div class="guide-nav">
      <button type="button" class="guide-play" aria-pressed="false" aria-label="Play">Play</button>
      <button type="button" class="guide-prev" aria-label="Previous chapter">↑</button>
      <button type="button" class="guide-next">Next ↓</button>
    </div>
    <p class="guide-no3d" hidden>This browser could not start 3D drawing (WebGL), so the pictures are off. The words all still work.</p>`;
  document.body.append(dialog);

  const $ = <T extends Element>(sel: string) => dialog.querySelector(sel) as T;
  const scroller = $<HTMLDivElement>(".guide-scroll");
  const sky = $<HTMLDivElement>(".guide-sky");
  const bar = $<HTMLElement>(".guide-progress i");
  const labelBox = $<HTMLDivElement>(".guide-labels");
  const leaders = $<SVGSVGElement>(".guide-leaders");
  const sections = [...dialog.querySelectorAll<HTMLElement>(".guide-chapter")];
  const cards = sections.map((s) => s.querySelector<HTMLElement>(".guide-card")!);
  const railButtons = [...dialog.querySelectorAll<HTMLButtonElement>(".guide-rail button")];
  const prev = $<HTMLButtonElement>(".guide-prev");
  const next = $<HTMLButtonElement>(".guide-next");
  const playButton = $<HTMLButtonElement>(".guide-play");
  const hint = $<HTMLParagraphElement>(".guide-hint");

  // Two canvases, each with its own renderer, so the old scene and the new one can both draw while one fades into the other.
  interface Layer {
    canvas: HTMLCanvasElement;
    renderer: THREE.WebGLRenderer | null;
    scene: GuideScene | null;
    /** Where the words start on a narrow screen when this scene came up (fraction of the height), for framing. */
    textTop: number;
  }
  const layers: Layer[] = [...dialog.querySelectorAll<HTMLCanvasElement>(".guide-canvas")].map((canvas) => {
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
    } catch {
      renderer = null;
    }
    return { canvas, renderer, scene: null, textTop: NARROW_TOP };
  });
  const webgl = layers.every((l) => l.renderer !== null);
  dialog.dataset.webgl = webgl ? "on" : "off";
  $<HTMLElement>(".guide-no3d").hidden = webgl;

  const world = new THREE.Scene();
  // A strong light from above right and a soft fill, so each side of a part gets its own shade.
  world.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a2140, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(3, 8, 4);
  const rim = new THREE.DirectionalLight(0x9fb4ff, 0.7);
  rim.position.set(-6, 1, -2);
  world.add(key, rim);
  const spin = new THREE.Group();
  world.add(spin);
  const camera = new THREE.PerspectiveCamera(GUIDE_FOV, 1, 0.05, 200);

  let incoming = 0; // the layer drawing the current chapter's scene; the other is fading out (or empty)
  let blendStart = -Infinity; // when the current blend began (performance.now)
  let fadeFrom = 0; // how visible the outgoing scene was when this blend began
  let index = -1;
  let progress = 0;
  let frames = 0;
  let yaw = -0.75;
  let pitch = 0;
  let raf = 0;
  let dragging: { x: number; y: number } | null = null;
  let rests: number[] = [];
  let leads: number[] = [];
  let glide: { from: number; to: number; start: number; duration: number; index: number } | null = null;
  let play: { y: number; last: number } | null = null; // a steady play (Space): where it has got to (unrounded) and when
  const started = performance.now();
  const current = () => layers[incoming].scene;
  const blendNow = (now: number) => blendAt(now - blendStart, reduced ? 0 : BLEND_MS);
  const narrow = () => stageLayout(innerWidth, innerHeight).centreX === 0.5;
  const textTopOf = (i: number) => (narrow() && cards[i].style.top ? parseFloat(cards[i].style.top) / scroller.clientHeight : NARROW_TOP);

  function showChapter(i: number) {
    if (i === index) return;
    index = i;
    lastChapter = i;
    const c = CHAPTERS[i];
    dialog.dataset.chapter = c.id;
    sky.style.backgroundColor = c.tint;
    railButtons.forEach((b, j) => (j === i ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")));
    sections.forEach((sec, j) => sec.toggleAttribute("data-active", j === i));
    if (i > 0) delete hint.dataset.shown; // the hint is for the start
    prev.disabled = i === 0;
    next.disabled = i === CHAPTERS.length - 1;
    labelBox.replaceChildren();
    leaders.replaceChildren();
    if (!webgl) return;
    // Whichever scene shows more right now fades out from where it is; the other is dropped, and the new one draws in its place.
    const now = performance.now();
    const e = blendNow(now);
    const shownIn = layers[incoming].scene ? e : 0;
    const shownOut = layers[1 - incoming].scene ? fadeFrom * (1 - e) : 0;
    if (shownIn >= shownOut) {
      fadeFrom = shownIn;
      incoming = 1 - incoming;
    } else fadeFrom = shownOut;
    const layer = layers[incoming];
    layer.scene?.dispose();
    layer.scene = buildScene(c.scene);
    layer.textTop = textTopOf(i);
    // The first scene, and every scene under reduced motion, is simply there.
    if (frames === 0 || reduced) {
      blendStart = -Infinity;
      dropOutgoing();
    } else {
      blendStart = now;
      dialog.dataset.blending = "";
    }
  }

  function dropOutgoing() {
    const out = layers[1 - incoming];
    out.scene?.dispose();
    out.scene = null;
    out.canvas.style.opacity = "0";
    layers[incoming].canvas.style.opacity = "1";
    delete dialog.dataset.blending;
  }

  /** Where each card rests and when each chapter takes over; on a narrow screen, first places each card as high as it needs. */
  function layout() {
    const h = scroller.clientHeight;
    const thin = narrow();
    cards.forEach((card, i) => {
      if (CHAPTERS[i].id === "words") return;
      card.style.top = thin ? `${Math.round(Math.max(NARROW_MIN_TOP * h, h - card.offsetHeight - 12))}px` : "";
    });
    sections[0].style.paddingTop = thin ? cards[0].style.top : "";
    rests = sections.map((s, i) => {
      const top = CHAPTERS[i].id === "words" ? WORDS_TOP : parseFloat(getComputedStyle(cards[i]).top);
      return restingScroll(s.offsetTop, parseFloat(getComputedStyle(s).paddingTop), top);
    });
    leads = sections.map((_, i) => 0.35 * (h - (CHAPTERS[i].id === "words" ? WORDS_TOP : parseFloat(getComputedStyle(cards[i]).top))));
    (dialog as GuideDialog).stops = { rests, leads };
    if (index >= 0) layers[incoming].textTop = textTopOf(index);
  }

  function measure() {
    const end = scroller.scrollHeight - scroller.clientHeight;
    const at = chapterAt(scroller.scrollTop, rests, leads, end);
    showChapter(at.index);
    progress = at.progress;
    dialog.dataset.progress = progress.toFixed(3);
    bar.style.transform = `scaleX(${end > 0 ? scroller.scrollTop / end : 0})`;
    current()?.update(progress);
  }

  /** Glides to where chapter `i`'s words come to rest. A jump of more than one chapter starts just short of it, so only its own card slides in. */
  function goTo(i: number) {
    stopPlay();
    const to = rests[i];
    if (reduced) {
      glide = null;
      scroller.scrollTop = to;
      return;
    }
    const from = Math.abs(i - (glide?.index ?? index)) > 1 ? (i > index ? to - leads[i] * 0.9 : to + scroller.clientHeight * 0.3) : scroller.scrollTop;
    if (from !== scroller.scrollTop) scroller.scrollTop = from;
    glide = { from, to, start: performance.now(), duration: glideDuration(to - from, scroller.clientHeight), index: i };
    dialog.dataset.gliding = "";
  }
  const stopGlide = () => {
    glide = null;
    delete dialog.dataset.gliding;
  };
  const target = () => glide?.index ?? index;

  function startPlay() {
    stopGlide();
    play = { y: scroller.scrollTop, last: performance.now() };
    dialog.dataset.playing = "";
    playButton.setAttribute("aria-pressed", "true");
    playButton.textContent = "Pause";
    playButton.setAttribute("aria-label", "Pause");
    delete hint.dataset.shown;
  }
  function stopPlay() {
    if (!play) return;
    play = null;
    delete dialog.dataset.playing;
    playButton.setAttribute("aria-pressed", "false");
    playButton.textContent = "Play";
    playButton.setAttribute("aria-label", "Play");
  }
  const togglePlay = () => (play ? stopPlay() : startPlay());

  function placeLabels(w: number, h: number, shown: number) {
    const scene = current();
    if (!scene) return;
    // Labels never go under the words: on a wide screen they stay right of the card.
    const card = sections[index].querySelector(".guide-card")!.getBoundingClientRect();
    const minX = stageLayout(w, h).centreX > 0.5 && card.bottom > 0 && card.top < h ? card.right + 12 : 8;
    const anchors = scene.anchors();
    while (labelBox.children.length < anchors.length) labelBox.append(document.createElement("span"));
    while (labelBox.children.length > anchors.length) labelBox.lastElementChild!.remove();
    const ns = "http://www.w3.org/2000/svg";
    while (leaders.children.length < anchors.length) leaders.append(document.createElementNS(ns, "g"));
    while (leaders.children.length > anchors.length) leaders.lastElementChild!.remove();
    spin.updateMatrixWorld(true);
    const reach = Math.min(150, w * 0.16);
    anchors.forEach((a, i) => {
      const el = labelBox.children[i] as HTMLSpanElement;
      const g = leaders.children[i] as SVGGElement;
      const v = a.point.clone().applyMatrix4(scene.root.matrixWorld).project(camera);
      const px = ((v.x + 1) / 2) * w;
      const py = ((1 - v.y) / 2) * h;
      const opacity = a.opacity * shown;
      const visible = opacity > 0.01 && v.z < 1;
      if (el.textContent !== a.text) el.textContent = a.text;
      el.style.opacity = String(visible ? opacity : 0);
      const width = el.offsetWidth;
      const leftSide = px - reach - width > minX;
      const lx = leftSide ? px - reach - width : Math.max(minX, Math.min(w - width - 40, px + reach));
      const ly = Math.min(h - 40, Math.max(56, py - 34));
      el.style.transform = `translate(${lx}px, ${ly}px)`;
      const underY = ly + el.offsetHeight;
      const x0 = leftSide ? lx : lx + width;
      const x1 = leftSide ? lx + width : lx;
      g.innerHTML = visible ? `<polyline points="${x0},${underY} ${x1},${underY} ${px},${py}" /><circle cx="${px}" cy="${py}" r="3.5" />` : "";
      g.style.opacity = String(visible ? opacity : 0);
    });
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (glide) {
      const y = glideAt(glide.from, glide.to, now - glide.start, glide.duration);
      scroller.scrollTop = y;
      if (y === glide.to) stopGlide();
    } else if (play) {
      const end = scroller.scrollHeight - scroller.clientHeight;
      play.y = playStep(play.y, now - play.last, scroller.clientHeight, end);
      play.last = now;
      scroller.scrollTop = play.y;
      if (play.y >= end) stopPlay();
    }
    if (!webgl || !current()) return;
    const w = scroller.clientWidth;
    const h = scroller.clientHeight;
    if (w === 0 || h === 0) return;
    if (!reduced && !dragging) yaw += SPIN / 60;
    spin.rotation.set(pitch, yaw + (reduced ? 0 : 0.08 * Math.sin((now - started) / 2400)), 0);
    const e = blendNow(now);
    if (e >= 1 && layers[1 - incoming].scene) dropOutgoing();
    const shown = [0, 0];
    shown[incoming] = e;
    shown[1 - incoming] = fadeFrom * (1 - e);
    layers.forEach((layer, i) => {
      if (!layer.scene || !layer.renderer) return;
      layer.canvas.style.opacity = String(shown[i]);
      const size = layer.renderer.getSize(new THREE.Vector2());
      if (size.x !== w || size.y !== h) layer.renderer.setSize(w, h, false);
      spin.clear();
      spin.add(layer.scene.root);
      aimCamera(camera, layer.scene.radius, w, h, layer.textTop);
      layer.renderer.render(world, camera);
    });
    // The labels belong to the current scene (and the camera is left aimed at it).
    spin.clear();
    spin.add(current()!.root);
    aimCamera(camera, current()!.radius, w, h, layers[incoming].textTop);
    placeLabels(w, h, e);
    frames++;
    dialog.dataset.frames = String(frames);
    dialog.dataset.blend = e.toFixed(3);
  }

  // Dragging with a mouse turns the picture (touch keeps scrolling).
  scroller.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || (e.target as Element).closest(".guide-card")) return;
    dragging = { x: e.clientX, y: e.clientY };
    scroller.setPointerCapture(e.pointerId);
    dialog.dataset.dragging = "";
  });
  scroller.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    yaw += (e.clientX - dragging.x) * 0.008;
    pitch = Math.max(-0.6, Math.min(0.6, pitch + (e.clientY - dragging.y) * 0.006));
    dragging = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => {
    dragging = null;
    delete dialog.dataset.dragging;
  };
  scroller.addEventListener("pointerup", endDrag);
  scroller.addEventListener("pointercancel", endDrag);

  // Turning a card over shows its words (and back); the card is the same size both ways round.
  dialog.addEventListener("click", (e) => {
    const flip = (e.target as Element).closest(".guide-flip");
    if (!flip) return;
    const card = flip.closest<HTMLElement>(".guide-card")!;
    const words = card.dataset.face !== "words";
    if (words) card.dataset.face = "words";
    else delete card.dataset.face;
    card.querySelector<HTMLButtonElement>(`.guide-face[data-face="${words ? "words" : "text"}"] .guide-flip`)!.focus({ preventScroll: true });
  });

  // The reader's own scrolling takes over from a glide or a play.
  for (const type of ["wheel", "touchstart"])
    scroller.addEventListener(
      type,
      () => {
        stopGlide();
        stopPlay();
      },
      { passive: true },
    );
  playButton.addEventListener("click", togglePlay);
  scroller.addEventListener("scroll", measure, { passive: true });
  const onResize = () => {
    layout();
    if (glide) glide.to = rests[glide.index];
    measure();
  };
  addEventListener("resize", onResize);
  railButtons.forEach((b, i) => b.addEventListener("click", () => goTo(i)));
  prev.addEventListener("click", () => goTo(Math.max(0, target() - 1)));
  next.addEventListener("click", () => goTo(Math.min(CHAPTERS.length - 1, target() + 1)));
  $(".guide-close").addEventListener("click", () => dialog.close());

  // The guide is modal: keys and the clipboard stay inside it.
  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.target as Element).closest("button")) return; // Enter presses a focused button
    // Space always plays or pauses, even with a button focused (that button is not pressed: Enter does that).
    if (e.key === " " && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      togglePlay();
      return;
    }
    const to = chapterForKey(e.key, target(), CHAPTERS.length);
    if (to === null || e.altKey || e.ctrlKey || e.metaKey) {
      if (e.key !== "Shift") stopPlay(); // any other key ends a play too (Shift alone is harmless)
      return;
    }
    e.preventDefault();
    goTo(to);
  });
  for (const type of ["keyup", "copy", "cut", "paste"]) dialog.addEventListener(type, (e) => e.stopPropagation());
  dialog.addEventListener("keyup", (e) => e.key === " " && e.preventDefault()); // a focused button would take Space's keyup as a press

  dialog.addEventListener("close", () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", onResize);
    for (const layer of layers) {
      layer.scene?.dispose();
      layer.scene = null;
      layer.renderer?.dispose();
      layer.renderer?.forceContextLoss();
    }
    dialog.remove();
    opener?.focus();
  });

  dialog.showModal();
  scroller.focus({ preventScroll: true });
  layout();
  if (lastChapter > 0) scroller.scrollTop = rests[lastChapter];
  measure();
  // The words' font can arrive after opening, changing the cards' heights.
  void document.fonts?.ready.then(() => dialog.isConnected && onResize());
  raf = requestAnimationFrame(frame);
  return dialog;
}
