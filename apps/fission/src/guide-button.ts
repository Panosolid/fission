// The top bar's Guide button (in Menu at phone width) opens the guide, a
// scrolling, 3D explanation of how SpindleLabs works (@fission/viewport's
// guide/). A ?guide link opens it straight away, for showing someone.
import "./frame-guard.ts"; // a framed page stops here (audit S10)
import { openGuide } from "@fission/viewport";

const button = document.getElementById("guide-open");
button?.addEventListener("click", () => openGuide(button));
if (new URLSearchParams(location.search).has("guide")) openGuide(button);
