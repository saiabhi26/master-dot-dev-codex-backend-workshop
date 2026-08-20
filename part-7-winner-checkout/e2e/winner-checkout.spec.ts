import { expect, test } from '@playwright/test';
import pg from 'pg';

const connectionString = 'postgres://auction:auction@localhost:55432/auction_part_7';

test('winning Bidder completes hosted checkout and receives one durable receipt', async ({ page, request }) => {
  await page.goto('/api/health');
  await expect(page.locator('body')).toContainText('"ok":true');
  await expect(page.locator('body')).toContainText('"db":"ok"');
  await expect(page.locator('body')).toContainText('"redis":"ok"');

  const previousNotifications = await request.get('/api/notifications?recipient=byte_bidder');
  expect(previousNotifications.status()).toBe(200);
  for (const notification of (await previousNotifications.json()).notifications as Array<{ id: number }>) {
    const dismissed = await request.patch(`/api/notifications/${notification.id}/read`, {
      data: { recipient: 'byte_bidder' },
    });
    expect(dismissed.status()).toBe(200);
  }

  const title = `Winner checkout ${Date.now()}`;
  const created = await request.post('/api/auctions', {
    data: {
      title,
      description: 'An Auction proving winner-only, replay-safe hosted checkout.',
      category: 'CPUs',
      condition: 'Payment tested',
      location: 'Checkout Lab',
      startingPriceCents: 42_300,
      closesAt: new Date(Date.now() + 5_000).toISOString(),
      seller: 'rack_runner',
    },
  });
  expect(created.status()).toBe(201);
  const auctionId = (await created.json()).auction.id as number;
  const bid = await request.post(`/api/auctions/${auctionId}/bids`, {
    data: { bidder: 'byte_bidder', amountCents: 42_400 },
  });
  expect(bid.status()).toBe(201);

  await page.goto('/');
  await page.getByLabel('Demo user').selectOption('byte_bidder');
  const notification = page.getByRole('dialog');
  await expect(notification).toContainText('You won the Auction!', { timeout: 20_000 });
  await expect(notification).toContainText(title);
  await notification.getByRole('link', { name: /Complete checkout/ }).click();

  await expect(page.getByRole('heading', { name: 'Complete your Winner Checkout.' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const unreadAfterCheckoutNavigation = await request.get('/api/notifications?recipient=byte_bidder');
  expect((await unreadAfterCheckoutNavigation.json()).notifications).not.toContainEqual(expect.objectContaining({ auctionId }));
  await expect(page.locator('.checkout-line-item').getByText('$424', { exact: true })).toBeVisible();

  const sellerPage = await page.context().newPage();
  await sellerPage.goto(`/auctions/${auctionId}`);
  await sellerPage.getByLabel('Demo user').selectOption('rack_runner');
  await expect(sellerPage.locator('.seller-payment-status')).toHaveText('Pending');

  const concurrent = await Promise.all(Array.from({ length: 3 }, () => request.post(`/api/auctions/${auctionId}/checkout`, {
    data: { identity: 'byte_bidder' },
  })));
  expect(concurrent.every((response) => response.status() === 200)).toBe(true);
  const sessions = await Promise.all(concurrent.map(async (response) => (await response.json()).checkout.stripeSessionId as string));
  expect(new Set(sessions).size).toBe(1);

  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/127\.0\.0\.1:7107\/checkout\/cs_test_/);
  await expect(page.getByRole('heading', { name: 'Pay with card' })).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  await page.getByLabel('Card number').fill('4242 4242 4242 4242');
  await page.getByLabel('Expiration').fill('12 / 30');
  await page.getByLabel('CVC').fill('123');
  await page.getByRole('button', { name: 'Pay $424.00' }).click();

  await page.waitForURL(new RegExp(`localhost:5107/auctions/${auctionId}/checkout\\?checkout=success`));
  await expect(page.getByRole('heading', { name: 'Payment complete.' })).toBeVisible();
  await expect(page.getByText('Paid in full')).toBeVisible();
  await expect(page.getByText(sessions[0])).toBeVisible();
  await expect(sellerPage.locator('.seller-payment-status')).toHaveText('Paid', { timeout: 10_000 });

  const database = new pg.Client({ connectionString });
  await database.connect();
  try {
    const payment = await database.query<{ count: string; status: string; amountCents: number }>(`SELECT
      COUNT(*)::text AS count,
      MAX(status) AS status,
      MAX(amount_cents)::integer AS "amountCents"
    FROM winner_payments
    WHERE auction_id = $1`, [auctionId]);
    expect(payment.rows[0]).toEqual({ count: '1', status: 'paid', amountCents: 42_400 });
  } finally {
    await database.end();
  }
});
