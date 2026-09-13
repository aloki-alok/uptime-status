(() => {
  const key = "status-theme";
  let saved = "light";
  try {
    saved = localStorage.getItem(key) === "dark" ? "dark" : "light";
  } catch {
    // The page remains usable when storage is unavailable.
  }

  function apply(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#101513" : "#f5f7f4");
    const button = document.querySelector("[data-theme-toggle]");
    if (button) {
      const dark = theme === "dark";
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(dark));
    }
  }

  apply(saved);
  document.addEventListener("DOMContentLoaded", () => {
    apply(saved);
    document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      apply(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Keep the current page preference even if it cannot be stored.
      }
    });
  });
})();
