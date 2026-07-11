// meso.poker — theme toggle (shared origin: meso.utilities).
// Restores the saved theme on load and wires the topbar toggle button.
const root = document.documentElement;
const toggle = document.getElementById("theme-toggle");
const icon = toggle ? toggle.querySelector(".theme-icon") : null;

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  if (icon) icon.textContent = theme === "dark" ? "🌙" : "☀️";
  try {
    localStorage.setItem("meso-theme", theme);
  } catch {
    /* storage may be unavailable; theme just won't persist */
  }
}

try {
  const saved = localStorage.getItem("meso-theme");
  if (saved === "light" || saved === "dark") applyTheme(saved);
} catch {
  /* ignore */
}

if (toggle) {
  toggle.addEventListener("click", () => {
    applyTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
}
