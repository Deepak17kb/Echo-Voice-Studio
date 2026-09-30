// Applies the saved theme before the first paint so dark mode never flashes light.
(function () {
  "use strict";
  try {
    var prefs = JSON.parse(window.localStorage.getItem("echo.prefs") || "{}");
    if (prefs.theme === "light" || prefs.theme === "dark") {
      document.documentElement.dataset.theme = prefs.theme;
    }
  } catch (error) {
    // Storage is unavailable (private window, blocked site data): follow the system theme.
  }
})();
