// Scroll-spy: highlight the nav link for whichever section is in view.
// Progressive enhancement only — the nav is plain anchors without this.
const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav-links a[href^="#"]')];
const sections = links
  .map((link) => document.querySelector<HTMLElement>(link.getAttribute('href')!))
  .filter((el): el is HTMLElement => el !== null);

if (sections.length > 0) {
  const visible = new Map<Element, number>();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) visible.set(entry.target, entry.intersectionRatio);

      let best: Element | null = null;
      let bestRatio = 0;
      for (const [el, ratio] of visible) {
        if (ratio > bestRatio) {
          best = el;
          bestRatio = ratio;
        }
      }

      for (const link of links) {
        const isCurrent = best !== null && link.getAttribute('href') === `#${best.id}`;
        if (isCurrent) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
  );

  for (const section of sections) observer.observe(section);
}
