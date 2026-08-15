// meso.poker — colour mode switch (shared origin: meso.utilities).
// Restores the saved mode on load and cycles the topbar button through all
// four. Dark and light are the originals; paper is a warm low-glare ground for
// bright rooms, mesoneer is the brand palette. Every mode is a token block in
// styles.css — nothing here knows a colour.
const root = document.documentElement;
const toggle = document.getElementById("theme-toggle");
const icon = toggle ? toggle.querySelector(".theme-icon") : null;

/** In cycle order. `note` is what the toast says after a switch. */
const MODES = [
  { id: "dark", icon: "🌙", label: "Dark", note: "the table at night" },
  { id: "light", icon: "☀️", label: "Light", note: "daylight, full contrast" },
  { id: "paper", icon: "📄", label: "Paper", note: "warm and low-glare" },
  { id: "mesoneer", icon: "🟣", label: "Mesoneer", note: "brand purple" },
];

function applyTheme(theme, announce = false) {
  const mode = MODES.find((m) => m.id === theme) ?? MODES[0];
  root.setAttribute("data-theme", mode.id);
  if (icon) {
    // The brand mode wears the logo tile; the rest wear their emoji.
    if (mode.id === "mesoneer") {
      icon.innerHTML = '<img class="theme-icon-mark" src="./mesoneer-logo.jpg" alt="" />';
    } else {
      icon.textContent = mode.icon;
    }
  }
  if (toggle) toggle.title = `Colour mode: ${mode.label} — click for the next`;
  try {
    localStorage.setItem("meso-theme", mode.id);
  } catch {
    /* storage may be unavailable; theme just won't persist */
  }
  // Four modes can't be told apart by an icon alone, so the switch names the
  // one you landed on. poker.js owns the toast and repaints the name wheel.
  if (announce) {
    dispatchEvent(new CustomEvent("meso-theme-change", { detail: mode }));
  }
}

try {
  const saved = localStorage.getItem("meso-theme");
  if (MODES.some((m) => m.id === saved)) applyTheme(saved);
} catch {
  /* ignore */
}

if (toggle) {
  toggle.addEventListener("click", () => {
    const at = MODES.findIndex((m) => m.id === root.getAttribute("data-theme"));
    applyTheme(MODES[(at + 1) % MODES.length].id, true);
  });
}
