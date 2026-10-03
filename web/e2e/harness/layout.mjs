import { expect } from '@playwright/test';

/** Real measurements (getBoundingClientRect), never computed widths (SOP G4). */
export async function measure(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el || !visible(el)) return null;
      const r = el.getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    };
    // Every interactive element, including in-content links. A 1 px box is the sr-only skip link (visually hidden
    // until focused), not a target.
    const targets = [...document.querySelectorAll('a[href], button, [role="button"], select, textarea, input[type="text"], input[type="password"], input:not([type]), input[type="range"]')]
      .filter((el) => visible(el) && el.getBoundingClientRect().width > 1 && el.getBoundingClientRect().height > 1)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { what: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') || el.textContent || el.id || '').trim().slice(0, 40)}`, width: Math.round(r.width), height: Math.round(r.height) };
      });
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      fonts: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')),
      sidebar: box('[data-testid="sidebar"]'),
      bottomNav: box('[data-testid="bottom-nav"]'),
      targets,
    };
  });
}

export async function assertLayout(page, viewport, { touch = false } = {}) {
  const m = await measure(page);
  expect(m.overflowX, `no horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(0);
  expect(m.fonts, 'Space Grotesk is actually rendered').toContain('Space Grotesk Variable');
  if (touch) {
    expect(m.coarse, `the ${viewport.width}px touch viewport reports a coarse pointer`).toBe(true);
    const small = m.targets.filter((t) => Math.min(t.width, t.height) < 44);
    expect(small, 'touch targets are at least 44 x 44 px').toEqual([]);
  }
  return m;
}
