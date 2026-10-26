// Set the theme before first paint so the page doesn't flash light
(() => {
  let saved; try { saved = localStorage.getItem('theme'); } catch (e) {}
  document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
})();
