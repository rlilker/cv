// Scroll-spy: highlight the nav link for whichever section is in view.
// Progressive enhancement only — the nav is plain anchors without this.
const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav-menu a[href^="/#"]')];
const sections = links
  .map((link) => document.getElementById(link.hash.slice(1)))
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
        const isCurrent = best !== null && link.hash === `#${best.id}`;
        if (isCurrent) link.setAttribute('aria-current', 'true');
        else link.removeAttribute('aria-current');
      }
    },
    { rootMargin: '-20% 0px -60% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
  );

  for (const section of sections) observer.observe(section);
}

// Mobile hamburger toggle logic
const navPill = document.getElementById('main-nav');
const navToggle = document.querySelector<HTMLButtonElement>('.nav-toggle');
const navMenu = document.getElementById('nav-menu');

if (navPill && navToggle && navMenu) {
  const closeMenu = () => {
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', 'Open navigation menu');
    navPill.classList.remove('is-open');
  };

  navToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = navPill.classList.contains('is-open');
    navToggle.setAttribute('aria-expanded', String(!isOpen));
    navToggle.setAttribute('aria-label', isOpen ? 'Open navigation menu' : 'Close navigation menu');
    navPill.classList.toggle('is-open', !isOpen);
  });

  navMenu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      closeMenu();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navPill.classList.contains('is-open')) {
      closeMenu();
      navToggle.focus();
    }
    if (e.key === 'Tab' && navPill.classList.contains('is-open') && matchMedia('(max-width: 720px)').matches) {
      const focusable = [navToggle, ...navMenu.querySelectorAll<HTMLAnchorElement>('a')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  matchMedia('(max-width: 720px)').addEventListener('change', closeMenu);

  document.addEventListener('click', (e) => {
    if (navPill.classList.contains('is-open') && !navPill.contains(e.target as Node)) {
      closeMenu();
    }
  });
}
