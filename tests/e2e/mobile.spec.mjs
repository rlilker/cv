/**
 * Mobile layout.
 *
 * Every layout bug reported from the dashboard was a horizontal scrollbar on a
 * phone. These assert the property that actually matters - the document does
 * not scroll sideways - and name the offending element when it does, because
 * "something overflows" on its own is not an actionable failure.
 *
 * Runs in the mobile project only; the desktop project skips it.
 */
import { test, expect, signedIn } from './fixtures/firebase-stub.mjs';

test.describe('mobile layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'layout regressions are phone-specific');

  test('nothing overflows the viewport horizontally', async ({ dashboard: page }) => {
    const report = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > docWidth + 1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: typeof el.className === 'string' ? el.className : null,
            right: Math.round(r.right),
            docWidth,
          });
        }
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: docWidth,
        offenders: offenders.slice(0, 5),
      };
    });

    expect(
      report.scrollWidth,
      `page scrolls horizontally by ${report.scrollWidth - report.clientWidth}px; `
      + `offenders: ${JSON.stringify(report.offenders, null, 2)}`,
    ).toBeLessThanOrEqual(report.clientWidth + 1);
  });

  test('the sign-in button fits inside its container', async ({ dashboard: page }) => {
    // It was a hard-coded 320px, which does not fit a 360px phone once the
    // page gutters and card padding are added.
    const fits = await page.evaluate(() => {
      const slot = document.getElementById('signin-slot');
      const btn = slot?.querySelector('div, iframe');
      if (!slot || !btn) return { missing: true };
      const s = slot.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        slotLeft: s.left, slotRight: s.right,
        btnLeft: b.left, btnRight: b.right,
      };
    });

    expect(fits.missing, 'no rendered button found in the slot').toBeFalsy();
    expect(fits.btnRight, 'button overflows its slot on the right')
      .toBeLessThanOrEqual(fits.slotRight + 1);
    expect(fits.btnLeft, 'button starts left of its slot')
      .toBeGreaterThanOrEqual(fits.slotLeft - 1);
  });

  test('the settings fields are usable at phone width', async ({ dashboard: page }) => {
    await signedIn(page);
    // A field can be technically editable and still unusable if it is narrower
    // than a fingertip or clipped by its own card.
    const box = await page.locator('#whitelist').boundingBox();
    expect(box, 'the whitelist field has no box').toBeTruthy();
    expect(box.width).toBeGreaterThan(120);
    const viewport = page.viewportSize();
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  });
});