(() => {
  const viewport = document.querySelector(".sponsor-viewport");
  if (!viewport) return;
  const brands = viewport.querySelector(".sponsor-brands");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const canHover = matchMedia("(hover: hover)");
  let visible = false;
  let timer;

  function showNextBrand() {
    const maximum = viewport.scrollWidth - viewport.clientWidth;
    if (viewport.scrollLeft >= maximum - 1) {
      viewport.scrollLeft = 0;
      return;
    }

    const start = brands.getBoundingClientRect().left;
    const next = Array.from(brands.children)
      .map(brand => brand.getBoundingClientRect().left - start)
      .find(offset => offset > viewport.scrollLeft + 1);
    const left = Math.min(next ?? maximum, maximum, viewport.scrollLeft + viewport.clientWidth);
    viewport.scrollTo({ left, behavior: "smooth" });
  }

  function updatePlayback() {
    clearInterval(timer);
    if (!visible || document.hidden || reducedMotion.matches) return;
    if (viewport.scrollWidth <= viewport.clientWidth + 1) return;
    if (viewport.matches(":focus-within, :active") || (canHover.matches && viewport.matches(":hover"))) return;
    timer = setInterval(showNextBrand, 3500);
  }

  const resize = new ResizeObserver(updatePlayback);
  resize.observe(viewport);
  resize.observe(brands);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    updatePlayback();
  }).observe(viewport);
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) viewport.scrollTo({ left: viewport.scrollLeft, behavior: "instant" });
    updatePlayback();
  });
  document.addEventListener("visibilitychange", updatePlayback);
  viewport.addEventListener("pointerdown", () => clearInterval(timer));
  for (const event of ["pointerup", "pointercancel", "pointerenter", "pointerleave", "focusin", "focusout"]) {
    viewport.addEventListener(event, () => queueMicrotask(updatePlayback));
  }
})();
