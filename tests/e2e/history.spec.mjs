/**
 * The test-notification button and the day-grouped run tables.
 *
 * The browser cannot send a push itself - FCM credentials live on the Pi - so
 * the button queues a request the Pi's existing daemon picks up. These check
 * that the request is shaped the way the Pi filters for, and that the outcome
 * is reported honestly rather than assumed.
 */
import { test, expect, signedIn, writes, stubFirebase } from './fixtures/firebase-stub.mjs';

test.describe('test notification', () => {
  test('queues a request the Pi can act on', async ({ browser, baseURL }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubFirebase(page, {});
    await page.goto(`${baseURL}/family-assistant/dashboard`);
    await signedIn(page);

    await page.locator('#test-push').click();
    await expect(page.locator('#test-push-state')).toContainText('Asking the Pi');

    const req = (await writes(page)).find((w) => w.path?.[0] === 'test_messages');
    expect(req, 'no test_messages document was created').toBeTruthy();
    // The Pi only picks up status == 'pending'; any other value is ignored.
    expect(req.data.status).toBe('pending');
    expect(req.data.requested_by).toBe('ryan.lilker@gmail.com');
    await ctx.close();
  });

  test('reports "no devices" rather than implying success', async ({ browser, baseURL }) => {
    // Reporting zero deliveries plainly is the point of the button: the Pi has
    // been in that state, and it is why no notification ever arrived.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // The Pi's answer comes back through the shared stub's testMessageResult
    // option rather than a second route for the same URL: two routes on one URL
    // resolve in registration order, and the loser silently breaks boot().
    await stubFirebase(page, {
      testMessageResult: { status: 'sent', sent: 0, devices: 0 },
    });
    await page.goto(`${baseURL}/family-assistant/dashboard`);
    await signedIn(page);

    await page.locator('#test-push').click();
    await expect(page.locator('#test-push-state'))
      .toContainText('No subscribed devices', { timeout: 25_000 });
    await ctx.close();
  });
});
test.describe('run history tables', () => {
  async function withRuns(browser, baseURL, runs) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await stubFirebase(page, { runs });
    await page.goto(`${baseURL}/family-assistant/dashboard`);
    await signedIn(page);
    return { ctx, page };
  }

  test('renders one table per day, newest first', async ({ browser, baseURL }) => {
    const { ctx, page } = await withRuns(browser, baseURL, [
      { run_id: '20261003_050000', status: 'SUCCESS', emails_scanned: 2, events_created: 1, logs: ['ADDED Dentist'] },
      { run_id: '20261002_050000', status: 'WARN', emails_scanned: 0, events_created: 0, logs: ['nothing to do'] },
      { run_id: '20261001_050000', status: 'ERROR', emails_scanned: 1, events_created: 0, logs: [] },
    ]);

    await expect(page.locator('.run-table')).toHaveCount(3);
    const headings = await page.locator('.day-heading').allTextContents();
    expect(headings.length).toBe(3);
    expect(new Date(headings[0]).getTime())
      .toBeGreaterThan(new Date(headings[1]).getTime());
    await ctx.close();
  });

  test('pages at seven days', async ({ browser, baseURL }) => {
    // Ten days of runs is two pages of seven. Paging over runs instead of days
    // would make "7 days" meaningless.
    const runs = [];
    for (let i = 1; i <= 10; i += 1) {
      runs.push({
        run_id: `202610${String(i).padStart(2, '0')}_050000`,
        status: 'SUCCESS', logs: [],
      });
    }
    const { ctx, page } = await withRuns(browser, baseURL, runs);

    await expect(page.locator('.run-table')).toHaveCount(7);
    await expect(page.locator('#runs-page-label')).toContainText('Page 1 of 2');

    await page.locator('#runs-pager button', { hasText: 'Older' }).click();
    await expect(page.locator('.run-table')).toHaveCount(3);
    await expect(page.locator('#runs-page-label')).toContainText('Page 2 of 2');
    await ctx.close();
  });

  test('a very long log line does not push the table off a phone',
    async ({ browser, baseURL }) => {
      const { ctx, page } = await withRuns(browser, baseURL, [
        { run_id: '20261003_050000', status: 'SUCCESS', logs: [
          'ADDED 2026-10-06T09:00:00 - Geography Trip to Castleton (from: '
          + 'AWeeklyUpdateOnGeographyFromTheSchoolWithAnExtremelyLongSubject'
          + 'LineThatHasNoSpacesInItAll)',
        ] },
      ]);
      await page.locator('.run-table summary').first().click();

      const box = await page.evaluate(() => {
        const t = document.querySelector('.run-table');
        const pre = t.querySelector('pre');
        return {
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          tableRight: t.getBoundingClientRect().right,
          preRight: pre ? pre.getBoundingClientRect().right : 0,
        };
      });
      expect(box.scroll,
        'the page scrolls sideways').toBeLessThanOrEqual(box.client + 1);
      expect(box.tableRight).toBeLessThanOrEqual(box.client + 1);
      expect(box.preRight).toBeLessThanOrEqual(box.client + 1);
      await ctx.close();
    });
});