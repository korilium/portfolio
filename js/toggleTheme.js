// The initial theme is applied by the inline script in each page's <head>
// (before first paint); this only wires up the toggle button.
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  const root = document.documentElement;
  const sync = () => {
    const isLight = root.getAttribute("data-theme") === "light";
    toggle.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
  };
  sync();

  toggle.addEventListener("click", () => {
    const theme = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("theme", theme); } catch (e) { /* storage blocked */ }
    sync();
  });
});
