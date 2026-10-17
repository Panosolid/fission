// The guide page (the top bar's Guide button, or a ?guide link): a full
// screen over the app that scrolls through the chapters. A 3D scene sits
// behind the words and follows the scroll (scenes.ts), with labels pinned
// to points in it. Arrow keys, Page Up/Down, Space, Home and End jump
// between chapters; Escape or Close returns to the app with nothing in it
// changed. While open it keeps every key and clipboard event to itself, so
// the app's shortcuts never fire behind it. Styles: packages/ui
// src/styles/guide.css.

import * as THREE from "three";
import { CHAPTERS, chapterAt, chapterForKey, glossary, stageLayout, type Chapter } from "./chapters.ts";
import { GUIDE_FOV, aimCamera, buildScene, type GuideScene } from "./scenes.ts";

const SPIN = 0.07; // radians a second when motion is allowed

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STATUS_NOTE: Record<Chapter["status"], string> = { built: "", partly: "Partly built", planned: "Not built yet" };

function chapterHtml(c: Chapter, i: number): string {
  const terms = c.id === "words" ? glossary() : c.terms;
  const dl = terms.length ? `<dl class="guide-terms">${terms.map((t) => `<div><dt>${escapeHtml(t.term)}</dt><dd>${escapeHtml(t.meaning)}</dd></div>`).join("")}</dl>` : "";
  const status = STATUS_NOTE[c.status] ? `<span class="guide-status" data-status="${c.status}">${STATUS_NOTE[c.status]}</span>` : "";
  return `<section class="guide-chapter" data-id="${c.id}" aria-labelledby="guide-h-${c.id}"${c.id === "words" ? ' data-words=""' : ""}>
    <div class="guide-card">
      <p class="guide-part">${escapeHtml(c.part)} · ${i + 1} of ${CHAPTERS.length}</p>
      <h2 id="guide-h-${c.id}">${escapeHtml(c.title)}</h2>${status}
      ${c.text.map((t) => `<p>${escapeHtml(t)}</p>`).join("")}
      ${dl}
    </div>
  </section>`;
}

let lastChapter = 0;

/** Opens the guide; `opener` gets focus back when it closes. Returns the dialog (for tests). */
export function openGuide(opener?: HTMLElement | null): HTMLDialogElement {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dialog = document.createElement("dialog");
  dialog.className = "guide";
  dialog.setAttribute("aria-labelledby", "guide-title");
  dialog.innerHTML = `
    <div class="guide-sky"></div>
    <canvas class="guide-canvas" aria-hidden="true"></canvas>
    <svg class="guide-leaders" aria-hidden="true"></svg>
    <div class="guide-labels" aria-hidden="true"></div>
    <div class="guide-scroll" tabindex="-1">
      ${CHAPTERS.map(chapterHtml).join("")}
      <div class="guide-end"></div>
    </div>
    <header class="guide-bar">
      <h1 id="guide-title" class="guide-title">How Fission works</h1>
      <button type="button" class="guide-close">Close</button>
      <div class="guide-progress" aria-hidden="true"><i></i></div>
    </header>
    <nav class="guide-rail" aria-label="Chapters">${CHAPTERS.map((c, i) => `<button type="button" data-index="${i}" aria-label="${escapeHtml(c.title)}" title="${escapeHtml(c.title)}"></button>`).join("")}</nav>
    <div class="guide-nav">
      <button type="button" class="guide-prev" aria-label="Previous chapter">↑</button>
      <button type="button" class="guide-next">Next ↓</button>
    </div>
    <p class="guide-no3d" hidden>This browser could not start 3D drawing (WebGL), so the pictures are off. The words all still work.</p>`;
  document.body.append(dialog);

  const $ = <T extends Element>(sel: string) => dialog.querySelector(sel) as T;
  const scroller = $<HTMLDivElement>(".guide-scroll");
  const canvas = $<HTMLCanvasElement>(".guide-canvas");
  const sky = $<HTMLDivElement>(".guide-sky");
  const bar = $<HTMLElement>(".guide-progress i");
  const labelBox = $<HTMLDivElement>(".guide-labels");
  const leaders = $<SVGSVGElement>(".guide-leaders");
  const sections = [...dialog.querySelectorAll<HTMLElement>(".guide-chapter")];
  const railButtons = [...dialog.querySelectorAll<HTMLButtonElement>(".guide-rail button")];
  const prev = $<HTMLButtonElement>(".guide-prev");
  const next = $<HTMLButtonElement>(".guide-next");

  let renderer: THREE.WebGLRenderer | null = null;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
  } catch {
    renderer = null;
  }
  dialog.dataset.webgl = renderer ? "on" : "off";
  $<HTMLElement>(".guide-no3d").hidden = renderer !== null;

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

  let current: GuideScene | null = null;
  let index = -1;
  let progress = 0;
  let frames = 0;
  let yaw = -0.75;
  let pitch = 0;
  let raf = 0;
  let dragging: { x: number; y: number } | null = null;
  const started = performance.now();

  function showChapter(i: number) {
    if (i === index) return;
    index = i;
    lastChapter = i;
    const c = CHAPTERS[i];
    dialog.dataset.chapter = c.id;
    sky.style.backgroundColor = c.tint;
    railButtons.forEach((b, j) => (j === i ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")));
    sections.forEach((sec, j) => sec.toggleAttribute("data-active", j === i));
    prev.disabled = i === 0;
    next.disabled = i === CHAPTERS.length - 1;
    if (current) {
      spin.remove(current.root);
      current.dispose();
    }
    current = renderer ? buildScene(c.scene) : null;
    if (current) spin.add(current.root);
    labelBox.replaceChildren();
    leaders.replaceChildren();
  }

  function measure() {
    const tops = sections.map((s) => s.offsetTop);
    const heights = sections.map((s) => s.offsetHeight);
    const at = chapterAt(scroller.scrollTop, scroller.clientHeight, tops, heights);
    showChapter(at.index);
    progress = at.progress;
    dialog.dataset.progress = progress.toFixed(3);
    const total = scroller.scrollHeight - scroller.clientHeight;
    bar.style.transform = `scaleX(${total > 0 ? scroller.scrollTop / total : 0})`;
    current?.update(progress);
  }

  function goTo(i: number) {
    const s = sections[i];
    const top = Math.max(0, s.offsetTop - scroller.clientHeight / 2 + 2);
    scroller.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
  }

  function placeLabels(w: number, h: number) {
    if (!current) return;
    // Labels never go under the words: on a wide screen they stay right of the card.
    const card = sections[index].querySelector(".guide-card")!.getBoundingClientRect();
    const minX = stageLayout(w, h).centreX > 0.5 && card.bottom > 0 && card.top < h ? card.right + 12 : 8;
    const anchors = current.anchors();
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
      const v = a.point.clone().applyMatrix4(current!.root.matrixWorld).project(camera);
      const px = ((v.x + 1) / 2) * w;
      const py = ((1 - v.y) / 2) * h;
      const shown = a.opacity > 0.01 && v.z < 1;
      if (el.textContent !== a.text) el.textContent = a.text;
      el.style.opacity = String(shown ? a.opacity : 0);
      const width = el.offsetWidth;
      const leftSide = px - reach - width > minX;
      const lx = leftSide ? px - reach - width : Math.max(minX, Math.min(w - width - 40, px + reach));
      const ly = Math.min(h - 40, Math.max(56, py - 34));
      el.style.transform = `translate(${lx}px, ${ly}px)`;
      const underY = ly + el.offsetHeight;
      const x0 = leftSide ? lx : lx + width;
      const x1 = leftSide ? lx + width : lx;
      g.innerHTML = shown ? `<polyline points="${x0},${underY} ${x1},${underY} ${px},${py}" /><circle cx="${px}" cy="${py}" r="3.5" />` : "";
      g.style.opacity = String(shown ? a.opacity : 0);
    });
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (!renderer || !current) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) renderer.setSize(w, h, false);
    aimCamera(camera, current.radius, w, h);
    if (!reduced && !dragging) yaw += SPIN / 60;
    spin.rotation.set(pitch, yaw + (reduced ? 0 : 0.08 * Math.sin((now - started) / 2400)), 0);
    renderer.render(world, camera);
    placeLabels(w, h);
    frames++;
    dialog.dataset.frames = String(frames);
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

  scroller.addEventListener("scroll", measure, { passive: true });
  addEventListener("resize", measure);
  railButtons.forEach((b, i) => b.addEventListener("click", () => goTo(i)));
  prev.addEventListener("click", () => goTo(Math.max(0, index - 1)));
  next.addEventListener("click", () => goTo(Math.min(CHAPTERS.length - 1, index + 1)));
  $(".guide-close").addEventListener("click", () => dialog.close());

  // The guide is modal: keys and the clipboard stay inside it.
  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === " " && (e.target as Element).closest("button")) return; // Space presses a focused button
    const to = chapterForKey(e.key, index, CHAPTERS.length);
    if (to === null || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    goTo(to);
  });
  for (const type of ["keyup", "copy", "cut", "paste"]) dialog.addEventListener(type, (e) => e.stopPropagation());

  dialog.addEventListener("close", () => {
    cancelAnimationFrame(raf);
    removeEventListener("resize", measure);
    current?.dispose();
    current = null;
    renderer?.dispose();
    renderer?.forceContextLoss();
    dialog.remove();
    opener?.focus();
  });

  dialog.showModal();
  scroller.focus({ preventScroll: true });
  if (lastChapter > 0) scroller.scrollTop = Math.max(0, sections[lastChapter].offsetTop - scroller.clientHeight / 2 + 2);
  measure();
  raf = requestAnimationFrame(frame);
  return dialog;
}
