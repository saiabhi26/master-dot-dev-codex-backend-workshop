import { expect, test } from '@playwright/test';
import pg from 'pg';

const connectionString = 'postgres://auction:auction@localhost:55432/auction_part_7';

test('winner and Seller receive live popups after the close workflow', async ({ browser, request }) => {
  for (const recipient of ['rack_runner', 'byte_bidder']) {
    const unread = await request.get(`/api/notifications?recipient=${recipient}`);
    expect(unread.status()).toBe(200);
    for (const notification of (await unread.json()).notifications as Array<{ id: number }>) {
      const dismissed = await request.patch(`/api/notifications/${notification.id}/read`, { data: { recipient } });
      expect(dismissed.status()).toBe(200);
    }
  }

  const title = `Async close ${Date.now()}`;
  const createResponse = await request.post('/api/auctions', {
    data: {
      title,
      description: 'An Auction proving the RabbitMQ close and notification workflow.',
      category: 'GPUs',
      condition: 'Workflow tested',
      location: 'Message Lab',
      startingPriceCents: 10_000,
      closesAt: new Date(Date.now() + 12_000).toISOString(),
      seller: 'rack_runner',
    },
  });
  expect(createResponse.status()).toBe(201);
  const auctionId = (await createResponse.json()).auction.id as number;

  const bidResponse = await request.post(`/api/auctions/${auctionId}/bids`, {
    data: { bidder: 'byte_bidder', amountCents: 10_100 },
  });
  expect(bidResponse.status()).toBe(201);

  const sellerContext = await browser.newContext();
  const bidderContext = await browser.newContext();
  const seller = await sellerContext.newPage();
  const bidder = await bidderContext.newPage();
  try {
    await seller.goto('/api/health');
    await expect(seller.locator('body')).toContainText('"ok":true');
    await expect(seller.locator('body')).toContainText('"redis":"ok"');
    await Promise.all([seller.goto('/'), bidder.goto('/')]);
    await seller.getByLabel('Demo user').selectOption('rack_runner');
    await bidder.getByLabel('Demo user').selectOption('byte_bidder');

    const sellerPopup = seller.getByRole('dialog');
    const bidderPopup = bidder.getByRole('dialog');
    await expect(sellerPopup).toContainText('Your Auction sold!', { timeout: 20_000 });
    await expect(sellerPopup).toContainText('byte_bidder won with $101');
    await expect(sellerPopup).toContainText(title);
    await expect(bidderPopup).toContainText('You won the Auction!');
    await expect(bidderPopup).toContainText('Your winning Bid was $101');
    await expect(bidderPopup).toContainText(title);

    const database = new pg.Client({ connectionString });
    await database.connect();
    try {
      const persisted = await database.query<{ recipient: string; kind: string }>(`
        SELECT recipient, kind
        FROM auction_notifications
        WHERE auction_id = $1
        ORDER BY kind
      `, [auctionId]);
      expect(persisted.rows).toEqual([
        { recipient: 'rack_runner', kind: 'seller' },
        { recipient: 'byte_bidder', kind: 'winner' },
      ]);
    } finally {
      await database.end();
    }

    await sellerPopup.getByRole('link', { name: /View Auction/ }).click();
    await expect(seller).toHaveURL(new RegExp(`/auctions/${auctionId}$`));
    await expect(sellerPopup).toBeHidden();
    const sellerUnread = await request.get('/api/notifications?recipient=rack_runner');
    expect((await sellerUnread.json()).notifications).not.toContainEqual(expect.objectContaining({ auctionId }));
  } finally {
    await sellerContext.close();
    await bidderContext.close();
  }
});

test('an Auction without Bids records a result without notifying the Seller', async ({ request }) => {
  const title = `No Bid close ${Date.now()}`;
  const response = await request.post('/api/auctions', {
    data: {
      title,
      description: 'An Auction proving that a no-Bid result does not create notifications.',
      category: 'Memory',
      condition: 'Workflow tested',
      location: 'Message Lab',
      startingPriceCents: 20_000,
      closesAt: new Date(Date.now() + 3_000).toISOString(),
      seller: 'rack_runner',
    },
  });
  expect(response.status()).toBe(201);
  const auctionId = (await response.json()).auction.id as number;

  const database = new pg.Client({ connectionString });
  await database.connect();
  try {
    await expect.poll(async () => {
      const result = await database.query<{ winner: string | null; publishedAt: Date | null }>(`
        SELECT winner, published_at AS "publishedAt"
        FROM auction_results
        WHERE auction_id = $1
      `, [auctionId]);
      return result.rows[0] ?? null;
    }, { timeout: 10_000 }).toMatchObject({ winner: null, publishedAt: expect.any(Date) });

    const notifications = await database.query('SELECT id FROM auction_notifications WHERE auction_id = $1', [auctionId]);
    expect(notifications.rowCount).toBe(0);
  } finally {
    await database.end();
  }
});

test('offline notifications reconcile oldest-first and dismissal synchronizes across tabs', async ({ browser, request }) => {
  const previousUnread = await request.get('/api/notifications?recipient=server_sage');
  expect(previousUnread.status()).toBe(200);
  for (const notification of (await previousUnread.json()).notifications as Array<{ id: number }>) {
    const dismissed = await request.patch(`/api/notifications/${notification.id}/read`, {
      data: { recipient: 'server_sage' },
    });
    expect(dismissed.status()).toBe(200);
  }

  const firstTitle = `Offline first ${Date.now()}`;
  const secondTitle = `Offline second ${Date.now()}`;

  async function createWonAuction(title: string, closesInMilliseconds: number) {
    const created = await request.post('/api/auctions', {
      data: {
        title,
        description: 'An Auction proving recoverable notification delivery.',
        category: 'Networking',
        condition: 'Recovery tested',
        location: 'Reconnect Lab',
        startingPriceCents: 30_000,
        closesAt: new Date(Date.now() + closesInMilliseconds).toISOString(),
        seller: 'rack_runner',
      },
    });
    expect(created.status()).toBe(201);
    const auctionId = (await created.json()).auction.id as number;
    const bid = await request.post(`/api/auctions/${auctionId}/bids`, {
      data: { bidder: 'server_sage', amountCents: 30_100 },
    });
    expect(bid.status()).toBe(201);
  }

  await createWonAuction(firstTitle, 3_000);
  await createWonAuction(secondTitle, 5_000);

  const database = new pg.Client({ connectionString });
  await database.connect();
  try {
    await expect.poll(async () => {
      const unread = await database.query<{ auctionTitle: string }>(`SELECT auction_title AS "auctionTitle"
        FROM auction_notifications
        WHERE recipient = 'server_sage' AND read_at IS NULL
          AND auction_title IN ($1, $2)
        ORDER BY created_at, id`, [firstTitle, secondTitle]);
      return unread.rows.map((row) => row.auctionTitle);
    }, { timeout: 12_000 }).toEqual([firstTitle, secondTitle]);
  } finally {
    await database.end();
  }

  const context = await browser.newContext();
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  try {
    await firstTab.goto('/');
    await firstTab.getByLabel('Demo user').selectOption('server_sage');
    await expect(firstTab.getByRole('dialog')).toContainText(firstTitle);

    await secondTab.goto('/');
    await secondTab.getByLabel('Demo user').selectOption('server_sage');
    await expect(secondTab.getByRole('dialog')).toContainText(firstTitle);

    await firstTab.getByRole('button', { name: 'Dismiss notification' }).click();
    await expect(firstTab.getByRole('dialog')).toContainText(secondTitle);
    await expect(secondTab.getByRole('dialog')).toContainText(secondTitle);

    await secondTab.getByRole('button', { name: 'Dismiss notification' }).click();
    await expect(firstTab.getByRole('dialog')).toHaveCount(0);
    await expect(secondTab.getByRole('dialog')).toHaveCount(0);

    await firstTab.reload();
    await expect(firstTab.getByRole('dialog')).toHaveCount(0);
    const unreadResponse = await request.get('/api/notifications?recipient=server_sage');
    expect(unreadResponse.status()).toBe(200);
    expect((await unreadResponse.json()).notifications).toEqual([]);
  } finally {
    await context.close();
  }
});
