import { expect, test, type BrowserContext, type Page } from '@playwright/test';

type WindowSlot = { left: number; top: number; width: number; height: number };

const slots: WindowSlot[] = [
  { left: 0, top: 25, width: 720, height: 820 },
  { left: 720, top: 25, width: 720, height: 820 },
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

async function chooseIdentity(page: Page, identity: 'rack_runner' | 'byte_bidder') {
  await page.getByLabel('Demo user').selectOption(identity);
}

test('Redis forwards a committed Bid from API B to a browser connected to API A', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ viewport: null }), browser.newContext({ viewport: null })]);
  const [seller, bidder] = await Promise.all(
    contexts.map((context, index) => openTiledWindow(context, slots[index])),
  );

  try {
    await seller.goto('/api/health');
    await expect(seller.locator('body')).toContainText('"redis":"ok"');
    await expect(seller.locator('body')).toContainText('"instanceId":"api-b"');

    await seller.goto('/auctions/new');
    await chooseIdentity(seller, 'rack_runner');
    const localClosingTime = await seller.evaluate(() => {
      const date = new Date(Date.now() + 300_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16);
    });
    await seller.getByLabel('Title').fill(`Distributed Realtime ${Date.now()}`);
    await seller.getByLabel('Description').fill('A cross-instance Auction proving Redis-backed realtime delivery.');
    await seller.getByLabel('Condition').fill('Distribution tested');
    await seller.getByLabel('Location').fill('Redis Lab');
    await seller.getByLabel('Starting price (USD)').fill('100.00');
    await seller.getByLabel('Closing time').fill(localClosingTime);
    await Promise.all([
      seller.waitForURL(/\/auctions\/\d+$/),
      seller.getByRole('button', { name: 'Create auction' }).click(),
    ]);

    await bidder.goto(seller.url());
    await chooseIdentity(bidder, 'byte_bidder');
    await Promise.all([seller, bidder].map(async (page) => {
      const status = page.getByRole('status');
      await expect(status).toHaveText('Live');
      await expect(status).toHaveAttribute('data-realtime-instance', 'api-a');
    }));

    await bidder.getByLabel('Your bid').fill('101.00');
    const bidResponsePromise = bidder.waitForResponse((response) => (
      response.request().method() === 'POST' && response.url().endsWith('/bids')
    ));
    await bidder.getByRole('button', { name: 'Place bid' }).click();
    const bidResponse = await bidResponsePromise;

    expect(bidResponse.status()).toBe(201);
    expect(bidResponse.headers()['x-api-instance']).toBe('api-b');
    await expect(seller.locator('.current-price')).toContainText('$101');
    await expect(seller.locator('.bid-history li')).toHaveCount(1);
    await expect(seller.locator('.bid-history li')).toContainText('byte_bidder');
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
