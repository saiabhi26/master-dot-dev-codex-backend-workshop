import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const identities = ['rack_runner', 'byte_bidder', 'server_sage'] as const;
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

async function waitUntil(epochMs: number) {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function submitBid(page: Page, amount: string) {
  await page.getByLabel('Your bid').fill(amount);
  await page.getByRole('button', { name: 'Place bid' }).click();
  await expect(page.getByRole('button', { name: 'Place bid' })).toBeEnabled();
}

test('Bidding War reproduces concurrent bid acceptance in four tiled windows', async ({ browser }) => {
  const contexts = await Promise.all(slots.map(() => browser.newContext({ viewport: null })));
  const [creator, ...bidders] = await Promise.all(
    contexts.map((context, index) => openTiledWindow(context, slots[index])),
  );

  try {
    await creator.goto('/auctions/new');
    await chooseIdentity(creator, 'rack_runner');

    const closesAt = Date.now() + 20_000;
    const localClosingTime = await creator.evaluate((epochMs) => {
      const date = new Date(epochMs);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 19);
    }, closesAt);

    await creator.getByLabel('Title').fill(`Bidding War ${Date.now()}`);
    await creator.getByLabel('Description').fill('Three bidders collide in a deliberately chaotic concurrency reproduction.');
    await creator.getByLabel('Condition').fill('Battle tested');
    await creator.getByLabel('Location').fill('Concurrency Lab');
    await creator.getByLabel('Starting price (USD)').fill('100.00');
    await creator.getByLabel('Closing time').fill(localClosingTime);
    await Promise.all([
      creator.waitForURL(/\/auctions\/\d+$/),
      creator.getByRole('button', { name: 'Create auction' }).click(),
    ]);

    const auctionUrl = creator.url();
    await labelWindow(creator, 'SELLER · auction control', '#334155');

    await Promise.all(bidders.map(async (page, index) => {
      await page.goto(auctionUrl);
      await chooseIdentity(page, identities[index]);
      await labelWindow(page, `BIDDER ${index + 1} · ${identities[index]}`, ['#dc2626', '#2563eb', '#7c3aed'][index]);
      await page.getByLabel('Your bid').fill('110.00');
    }));

    // The reproduction: three identical bids race from three independent sessions.
    // Sequential correctness permits exactly one $110 bid; the current API commonly accepts all three.
    const simultaneousClickAt = Date.now() + 750;
    await Promise.all(bidders.map((page) => page.evaluate(async (epochMs) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, epochMs - Date.now())));
      const button = [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Place bid');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Place bid button not found');
      button.click();
    }, simultaneousClickAt)));
    await Promise.all(bidders.map((page) => expect(page.getByRole('button', { name: 'Place bid' })).toBeEnabled()));

    await Promise.all(bidders.map((page) => page.reload()));
    await Promise.all(bidders.map((page, index) => labelWindow(page, `BIDDER ${index + 1} · ${identities[index]}`, ['#dc2626', '#2563eb', '#7c3aed'][index])));
    const acceptedConcurrentBids = await bidders[0].locator('.bid-history li').count();
    expect(acceptedConcurrentBids).toBeGreaterThanOrEqual(2);
    await expect(bidders[0].locator('.bid-history li').filter({ hasText: '$110' }))
      .toHaveCount(acceptedConcurrentBids);

    // Keep the war moving at different moments, with the last request crossing the closing instant.
    await waitUntil(closesAt - 9_000);
    await submitBid(bidders[0], '120.00');
    await waitUntil(closesAt - 5_000);
    await submitBid(bidders[1], '130.00');
    await waitUntil(closesAt - 700);
    await submitBid(bidders[2], '140.00');
    await waitUntil(closesAt + 150);
    await submitBid(bidders[0], '150.00');

    await Promise.all([creator, ...bidders].map((page) => page.reload()));
    await labelWindow(creator, 'SELLER · auction ended', '#334155');
    await Promise.all(bidders.map((page, index) => labelWindow(page, `BIDDER ${index + 1} · ${identities[index]}`, ['#dc2626', '#2563eb', '#7c3aed'][index])));

    await expect(creator.getByText('Ended', { exact: true })).toBeVisible();
    await expect(creator.locator('.bid-history li')).toHaveCount(acceptedConcurrentBids + 4);
    await expect(creator.locator('.current-price')).toContainText('$150');

    if (keepOpen) {
      console.log('\nBidding War reproduced. Four tiled Chrome windows will remain open for inspection.\n');
      await new Promise<void>(() => {});
    }
  } finally {
    if (!keepOpen) await Promise.all(contexts.map((context) => context.close()));
  }
});
