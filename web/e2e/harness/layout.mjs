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
    const targets = [...document.querySelectorAll('button, select, textarea, input[type="text"], input[type="password"], input:not([type]), input[type="range"], nav a')]
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { what: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') || el.textContent || el.id || '').trim().slice(0, 40)}`, height: Math.round(r.height) };
      });
    return {
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
    const small = m.targets.filter((t) => t.height < 44);
    expect(small, 'touch targets are at least 44 px tall').toEqual([]);
  }
  return m;
}
