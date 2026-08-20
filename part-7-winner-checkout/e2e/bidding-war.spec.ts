import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const identities = ['rack_runner', 'byte_bidder', 'server_sage'] as const;
const bidderIdentities = ['byte_bidder', 'server_sage', 'byte_bidder'] as const;
const keepOpen = process.env.KEEP_BIDDING_WAR_OPEN === '1';

test.setTimeout(keepOpen ? 0 : 75_000);

type WindowSlot = { left: number; top: number; width: number; height: number };

const slots: WindowSlot[] = [
  { left: 0, top: 25, width: 720, height: 430 },
  { left: 720, top: 25, width: 720, height: 430 },
  { left: 0, top: 455, width: 720, height: 430 },
  { left: 720, top: 455, width: 720, height: 430 },
];

async function openTiledWindow(context: BrowserContext, slot: WindowSlot) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { ...slot, windowState: 'normal' },
  });
  await cdp.detach();
  return page;
}

async function labelWindow(page: Page, label: string, color: string) {
  await page.evaluate(({ text, background }) => {
    document.querySelector('[data-bidding-war-label]')?.remove();
    const badge = document.createElement('div');
    badge.dataset.biddingWarLabel = 'true';
    badge.textContent = text;
    Object.assign(badge.style, {
      position: 'fixed',
      zIndex: '99999',
      top: '10px',
      left: '10px',
      padding: '8px 12px',
      borderRadius: '999px',
      background,
      color: 'white',
      font: '700 14px system-ui',
      boxShadow: '0 3px 12px rgba(0,0,0,.3)',
    });
    document.body.append(badge);
  }, { text: label, background: color });
}

async function chooseIdentity(page: Page, identity: (typeof identities)[number]) {
  await page.getByLabel('Demo user').selectOption(identity);
}

async function demoPause(milliseconds: number) {
  if (keepOpen) await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('Bidding War accepts only valid concurrent Bids in four tiled windows', async ({ browser }) => {
  const contexts = await Promise.all(slots.map(() => browser.newContext({ viewport: null })));
  const [creator, ...bidders] = await Promise.all(
    contexts.map((context, index) => openTiledWindow(context, slots[index])),
  );

  try {
    await creator.goto('/api/health');
    await expect(creator.locator('body')).toContainText('"ok":true');
    await creator.goto('/auctions/new');
    await chooseIdentity(creator, 'rack_runner');

    const closesAt = Date.now() + 180_000;
    const localClosingTime = await creator.evaluate((epochMs) => {
      const date = new Date(epochMs);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    }, closesAt);

    await creator.getByLabel('Title').fill(`Bidding War ${Date.now()}`);
    await creator.getByLabel('Description').fill('Three bidders collide while protected concurrency keeps every accepted Bid valid.');
    await creator.getByLabel('Condition').fill('Battle tested');
    await creator.getByLabel('Location').fill('Concurrency Lab');
    await creator.getByLabel('Starting price (USD)').fill('100.00');
    await creator.getByLabel('Closing time').fill(localClosingTime);
    await Promise.all([
      creator.waitForURL(/\/auctions\/\d+$/),
      creator.getByRole('button', { name: 'Create auction' }).click(),
    ]);

    const auctionUrl = creator.url();
    await labelWindow(creator, 'SELLER · auction created', '#334155');

    await Promise.all(bidders.map(async (page, index) => {
      await page.goto(auctionUrl);
      await chooseIdentity(page, bidderIdentities[index]);
      await labelWindow(page, `BIDDER ${index + 1} · READY`, ['#dc2626', '#2563eb', '#7c3aed'][index]);
      await page.getByLabel('Your bid').fill('110.00');
    }));
    await Promise.all([creator, ...bidders].map((page) => (
      expect(page.getByRole('status')).toHaveText('Live')
    )));

    if (keepOpen) console.log('\nThree bidders are READY with identical $110 bids. Collision in 3 seconds…\n');
    await demoPause(3_000);

    // Three identical Bids race from independent sessions. Exactly one may be accepted.
    const simultaneousClickAt = Date.now() + 750;
    await Promise.all(bidders.map((page) => page.evaluate(async (epochMs) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, epochMs - Date.now())));
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Place bid');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Place bid button not found');
      button.click();
    }, simultaneousClickAt)));
    await Promise.all(bidders.map((page) => expect(page.getByRole('button', { name: 'Place bid' })).toBeEnabled()));

    await expect.poll(async () => {
      const staleStates = await Promise.all(bidders.map((page) => page.locator('.bid-error').isVisible()));
      return staleStates.filter(Boolean).length;
    }).toBe(2);
    await expect(creator.locator('.current-price')).toContainText('$110');
    await expect(creator.locator('.bid-history li')).toHaveCount(1);

    await Promise.all(bidders.map(async (page, index) => {
      const stale = await page.locator('.bid-error').isVisible();
      await labelWindow(
        page,
        stale ? `BIDDER ${index + 1} · STALE · MIN $111` : `BIDDER ${index + 1} · ACCEPTED $110`,
        stale ? '#b45309' : '#15803d',
      );
      await page.locator('.auction-panel').scrollIntoViewIfNeeded();
    }));

    if (keepOpen) {
      await labelWindow(creator, 'SELLER · 1 ACCEPTED BID', '#334155');
      await creator.locator('.auction-panel').scrollIntoViewIfNeeded();
      console.log('\nProtected collision complete: one ACCEPTED, two STALE. Four Chrome windows remain open.\n');
      await new Promise<void>(() => {});
    }

    await contexts[0].setOffline(true);
    await bidders[0].getByLabel('Your bid').fill('120.00');
    await bidders[0].getByRole('button', { name: 'Place bid' }).click();
    await expect(bidders[0].locator('.current-price')).toContainText('$120');
    await contexts[0].setOffline(false);
    await expect(creator.getByRole('status')).toHaveText('Live', { timeout: 15_000 });
    await expect(creator.locator('.current-price')).toContainText('$120');
    await expect(creator.locator('.bid-history li')).toHaveCount(2);

    const acceptedConcurrentBids = await bidders[0].locator('.bid-history li').count();
    expect(acceptedConcurrentBids).toBe(2);
    await expect(bidders[0].locator('.bid-history li').filter({ hasText: '$110' }))
      .toHaveCount(1);
    await expect(bidders[0].locator('.current-price')).toContainText('$120');
    await expect(bidders[0].locator('.bid-minimum')).toContainText('$121');

  } finally {
    if (!keepOpen) await Promise.all(contexts.map((context) => context.close()));
  }
});
