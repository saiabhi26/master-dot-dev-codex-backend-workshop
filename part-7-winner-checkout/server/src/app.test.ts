import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp, type AuctionSnapshot, type PaymentStatusUpdate } from './app.js';

const broadcasts: AuctionSnapshot[] = [];
const notificationReadBroadcasts: Array<{ recipient: string; notificationId: number }> = [];
const paymentUpdates: PaymentStatusUpdate[] = [];
let failBroadcast = false;
let realtimeHealthy = true;
const stripeSessions = new Map<string, { id: string; object: 'checkout.session'; url: string; status: 'open'; payment_status: 'unpaid'; client_reference_id: string }>();
const stripeSessionRequests: string[] = [];
const stripeFetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const body = JSON.parse(String(init?.body)) as { client_reference_id: string };
  stripeSessionRequests.push(body.client_reference_id);
  const existing = stripeSessions.get(body.client_reference_id);
  if (existing) return new Response(JSON.stringify(existing), { status: 200, headers: { 'content-type': 'application/json' } });
  const id = `cs_test_${randomBytes(12).toString('hex')}`;
  const session = {
    id,
    object: 'checkout.session' as const,
    url: `http://stripe.test/checkout/${id}`,
    status: 'open' as const,
    payment_status: 'unpaid' as const,
    client_reference_id: body.client_reference_id,
  };
  stripeSessions.set(body.client_reference_id, session);
  return new Response(JSON.stringify(session), { status: 201, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
const app = buildApp({
  instanceId: 'test-api',
  isRealtimeReady: () => realtimeHealthy,
  onAuctionUpdated: (snapshot) => {
    if (failBroadcast) throw new Error('realtime unavailable');
    broadcasts.push(snapshot);
  },
  onNotificationRead: (recipient, notificationId) => {
    notificationReadBroadcasts.push({ recipient, notificationId });
  },
  onPaymentUpdated: (update) => {
    paymentUpdates.push(update);
  },
  stripeBaseUrl: 'http://stripe.test',
  webBaseUrl: 'http://auction.test',
  stripeWebhookSecret: 'test_checkout_secret',
  stripeFetch,
});
const connectionString = process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';
let createdAuctionId: number;

async function createConcurrencyAuction(title: string, closesAt = new Date(Date.now() + 60_000).toISOString()) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auctions',
    payload: {
      title,
      description: 'An auction created to verify protected concurrent bidding.',
      category: 'GPUs',
      condition: 'Concurrency tested',
      location: 'Test Lab',
      startingPriceCents: 10_000,
      closesAt,
      seller: 'rack_runner',
    },
  });

  expect(response.statusCode).toBe(201);
  return response.json().auction as { id: number; closesAt: string };
}

afterAll(async () => {
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  await cleanup.query("DELETE FROM bids WHERE auction_id IN (SELECT id FROM auctions WHERE title = 'Vitest demo auction' OR title LIKE 'Vitest concurrency %')");
  await cleanup.query("DELETE FROM auctions WHERE title = 'Vitest demo auction' OR title LIKE 'Vitest concurrency %'");
  await cleanup.end();
  await app.close();
});

describe('auction API', () => {
  it('reports a healthy database', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-api-instance']).toBe('test-api');
    expect(response.json()).toMatchObject({
      ok: true,
      db: 'ok',
      redis: 'ok',
      instanceId: 'test-api',
    });
  });

  it('reports an unhealthy realtime dependency', async () => {
    realtimeHealthy = false;
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ ok: false, db: 'ok', redis: 'down' });
    } finally {
      realtimeHealthy = true;
    }
  });

  it('lists seeded auctions ordered by closing time', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auctions?limit=100' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.auctions.length).toBeGreaterThanOrEqual(6);
    const closingTimes = body.auctions.map((auction: { closesAt: string }) => new Date(auction.closesAt).getTime());
    expect(closingTimes).toEqual([...closingTimes].sort((left, right) => left - right));
  });

  it('searches persisted auctions and retrieves their details', async () => {
    const searchResponse = await app.inject({ method: 'GET', url: '/api/auctions?q=memory' });
    const searchBody = searchResponse.json();

    expect(searchResponse.statusCode).toBe(200);
    const memoryAuction = searchBody.auctions.find(
      (auction: { title: string }) => auction.title === '1.5TB DDR5 ECC memory kit',
    );
    expect(memoryAuction).toBeDefined();

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/auctions/${memoryAuction.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().auction).toMatchObject({
      category: 'Memory',
      seller: 'Heap & Sons',
      specs: expect.any(Array),
    });
    expect(detailResponse.json().bids.length).toBeGreaterThanOrEqual(31);
  });

  it('returns 404 for an auction that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auctions/999999' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Auction not found' });
  });

  it('creates an auction for a fixed demo identity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auctions',
      payload: {
        title: 'Vitest demo auction',
        description: 'A persisted auction created through the public API.',
        category: 'GPUs',
        condition: 'Used · Fully tested',
        location: 'Seattle, WA',
        startingPriceCents: 125000,
        closesAt: new Date(Date.now() + 86_400_000).toISOString(),
        seller: 'rack_runner',
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    createdAuctionId = body.auction.id;
    expect(body.auction).toMatchObject({
      title: 'Vitest demo auction',
      seller: 'rack_runner',
      currentPriceCents: 125000,
      bidCount: 0,
      status: 'Open',
    });
  });

  it('excludes Ended Auctions from an Open Auction listing', async () => {
    const database = new pg.Client({ connectionString });
    await database.connect();
    try {
      await database.query("UPDATE auctions SET closes_at = clock_timestamp() - interval '1 second' WHERE id = $1", [createdAuctionId]);

      const openResponse = await app.inject({ method: 'GET', url: '/api/auctions?status=open' });
      expect(openResponse.statusCode).toBe(200);
      expect(openResponse.json().auctions).not.toContainEqual(expect.objectContaining({ id: createdAuctionId }));

      const allResponse = await app.inject({ method: 'GET', url: '/api/auctions' });
      expect(allResponse.json().auctions).toContainEqual(expect.objectContaining({ id: createdAuctionId, status: 'Ended' }));
    } finally {
      await database.query("UPDATE auctions SET closes_at = clock_timestamp() + interval '1 day' WHERE id = $1", [createdAuctionId]);
      await database.end();
    }
  });

  it('rejects an auction with an invalid demo identity and closing time', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auctions',
      payload: {
        title: 'Invalid auction',
        description: 'This should never be persisted.',
        category: 'GPUs',
        condition: 'Used',
        location: 'Seattle, WA',
        startingPriceCents: 125000,
        closesAt: new Date(Date.now() - 60_000).toISOString(),
        seller: 'not_a_demo_user',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Check the highlighted auction fields' });
  });

  it('lists unread notifications and synchronizes an identity-scoped dismissal', async () => {
    const database = new pg.Client({ connectionString });
    await database.connect();
    const eventId = `vitest-notification:${Date.now()}`;
    const inserted = await database.query<{ id: number }>(`INSERT INTO auction_notifications (
      event_id, auction_id, recipient, kind, auction_title, winner, final_price_cents
    ) VALUES ($1, $2, 'byte_bidder', 'winner', 'Vitest demo auction', 'byte_bidder', 125100)
    RETURNING id`, [eventId, createdAuctionId]);
    await database.end();
    const notificationId = inserted.rows[0].id;

    const invalidList = await app.inject({ method: 'GET', url: '/api/notifications?recipient=unknown_user' });
    expect(invalidList.statusCode).toBe(400);

    const unread = await app.inject({ method: 'GET', url: '/api/notifications?recipient=byte_bidder' });
    expect(unread.statusCode).toBe(200);
    expect(unread.json().notifications).toContainEqual(expect.objectContaining({
      id: notificationId,
      recipient: 'byte_bidder',
      kind: 'winner',
      auctionTitle: 'Vitest demo auction',
    }));

    const wrongIdentity = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/${notificationId}/read`,
      payload: { recipient: 'rack_runner' },
    });
    expect(wrongIdentity.statusCode).toBe(404);

    const dismissed = await app.inject({
      method: 'PATCH',
      url: `/api/notifications/${notificationId}/read`,
      payload: { recipient: 'byte_bidder' },
    });
    expect(dismissed.statusCode).toBe(200);
    expect(notificationReadBroadcasts).toContainEqual({ recipient: 'byte_bidder', notificationId });

    const reconciled = await app.inject({ method: 'GET', url: '/api/notifications?recipient=byte_bidder' });
    expect(reconciled.json().notifications).not.toContainEqual(expect.objectContaining({ id: notificationId }));
  });

  it('places a direct bid above Current Price and returns public Bid History', async () => {
    broadcasts.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: `/api/auctions/${createdAuctionId}/bids`,
      payload: { bidder: 'byte_bidder', amountCents: 130000 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      auction: {
        currentPriceCents: 130000,
        currentBidder: 'byte_bidder',
        bidCount: 1,
      },
      bids: [{ bidder: 'byte_bidder', amountCents: 130000 }],
    });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      auction: { id: createdAuctionId, currentPriceCents: 130000, bidCount: 1 },
      bids: [{ bidder: 'byte_bidder', amountCents: 130000 }],
    });
  });

  it('returns a stale conflict when a Bid is below the updated Minimum Bid', async () => {
    broadcasts.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: `/api/auctions/${createdAuctionId}/bids`,
      payload: { bidder: 'server_sage', amountCents: 130000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'BID_STALE',
      minimumBidCents: 130100,
      auction: { id: createdAuctionId, currentPriceCents: 130000, bidCount: 1 },
      bids: [{ bidder: 'byte_bidder', amountCents: 130000 }],
    });
    expect(broadcasts).toHaveLength(0);
  });

  it('returns an accepted Bid when its post-commit broadcast fails', async () => {
    const auction = await createConcurrencyAuction(`Vitest concurrency broadcast ${Date.now()}`);
    failBroadcast = true;
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/auctions/${auction.id}/bids`,
        payload: { bidder: 'byte_bidder', amountCents: 11_000 },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        auction: { id: auction.id, currentPriceCents: 11_000, bidCount: 1 },
      });
    } finally {
      failBroadcast = false;
    }
  });

  it('accepts exactly one of several simultaneous duplicate Bids', async () => {
    const auction = await createConcurrencyAuction(`Vitest concurrency duplicates ${Date.now()}`);
    const blocker = new pg.Client({ connectionString });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [auction.id]);
    let committed = false;

    let responses;
    try {
      const responsesPromise = Promise.all([
        ['byte_bidder', 11_000],
        ['server_sage', 11_000],
        ['byte_bidder', 11_000],
      ].map(([bidder, amountCents]) => app.inject({
        method: 'POST',
        url: `/api/auctions/${auction.id}/bids`,
        payload: { bidder, amountCents },
      })));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await blocker.query('COMMIT');
      committed = true;
      responses = await responsesPromise;
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      await blocker.end();
    }

    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    const conflicts = responses.filter((response) => response.statusCode === 409);
    expect(conflicts).toHaveLength(2);
    for (const conflict of conflicts) {
      expect(conflict.json()).toMatchObject({
        code: 'BID_STALE',
        minimumBidCents: 11_100,
        auction: { id: auction.id, currentPriceCents: 11_000, bidCount: 1 },
        bids: [{ amountCents: 11_000 }],
      });
    }
  });

  it('serializes unequal simultaneous Bids against the latest committed Current Price', async () => {
    const auction = await createConcurrencyAuction(`Vitest concurrency unequal ${Date.now()}`);

    const [lower, higher] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/auctions/${auction.id}/bids`,
        payload: { bidder: 'byte_bidder', amountCents: 11_000 },
      }),
      app.inject({
        method: 'POST',
        url: `/api/auctions/${auction.id}/bids`,
        payload: { bidder: 'server_sage', amountCents: 12_000 },
      }),
    ]);

    expect(higher.statusCode).toBe(201);
    expect([201, 409]).toContain(lower.statusCode);
    if (lower.statusCode === 409) {
      expect(lower.json()).toMatchObject({
        code: 'BID_STALE',
        minimumBidCents: 12_100,
        auction: { currentPriceCents: 12_000 },
      });
    }

    const detail = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}` });
    expect(detail.json()).toMatchObject({ auction: { currentPriceCents: 12_000 } });
  });

  it('returns 409 with the updated Minimum Bid for a stale lower Bid', async () => {
    const auction = await createConcurrencyAuction(`Vitest concurrency stale ${Date.now()}`);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/auctions/${auction.id}/bids`,
      payload: { bidder: 'byte_bidder', amountCents: 12_000 },
    });
    expect(accepted.statusCode).toBe(201);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/auctions/${auction.id}/bids`,
      payload: { bidder: 'server_sage', amountCents: 11_000 },
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: 'BID_STALE',
      minimumBidCents: 12_100,
      auction: { id: auction.id, currentPriceCents: 12_000, bidCount: 1 },
      bids: [{ bidder: 'byte_bidder', amountCents: 12_000 }],
    });
  });

  it('rejects a Seller Bid without changing the Auction', async () => {
    const auction = await createConcurrencyAuction(`Vitest concurrency seller ${Date.now()}`);

    const response = await app.inject({
      method: 'POST',
      url: `/api/auctions/${auction.id}/bids`,
      payload: { bidder: 'rack_runner', amountCents: 11_000 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'SELLER_CANNOT_BID',
      auction: { id: auction.id, currentPriceCents: 10_000, bidCount: 0 },
      bids: [],
    });

    const detail = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}` });
    expect(detail.json()).toMatchObject({
      auction: { currentPriceCents: 10_000, bidCount: 0 },
      bids: [],
    });
  });

  it('rejects a Bid that waits on the Auction lock across Closing Time', async () => {
    const auction = await createConcurrencyAuction(
      `Vitest concurrency closing ${Date.now()}`,
      new Date(Date.now() + 1_200).toISOString(),
    );
    const blocker = new pg.Client({ connectionString });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [auction.id]);
    let committed = false;

    try {
      const bidPromise = app.inject({
        method: 'POST',
        url: `/api/auctions/${auction.id}/bids`,
        payload: { bidder: 'byte_bidder', amountCents: 11_000 },
      });
      const delay = new Date(auction.closesAt).getTime() - Date.now() + 100;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      await blocker.query('COMMIT');
      committed = true;

      const response = await bidPromise;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'AUCTION_ENDED',
        auction: { id: auction.id, status: 'Ended', currentPriceCents: 10_000, bidCount: 0 },
        bids: [],
      });
    } finally {
      if (!committed) await blocker.query('ROLLBACK');
      await blocker.end();
    }
  });

  it('authorizes the winner, creates one replay-safe checkout, and records one signed payment', async () => {
    const auction = await createConcurrencyAuction(`Vitest concurrency checkout ${Date.now()}`);
    const bid = await app.inject({
      method: 'POST',
      url: `/api/auctions/${auction.id}/bids`,
      payload: { bidder: 'byte_bidder', amountCents: 12_500 },
    });
    expect(bid.statusCode).toBe(201);

    const database = new pg.Client({ connectionString });
    await database.connect();
    await database.query("UPDATE auctions SET closes_at = clock_timestamp() - interval '1 second' WHERE id = $1", [auction.id]);
    await database.query(`INSERT INTO auction_results (auction_id, event_id, winner, final_price_cents)
      VALUES ($1, $2, 'byte_bidder', 12500)`, [auction.id, `vitest-checkout:${auction.id}`]);

    const pendingDetail = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}` });
    expect(pendingDetail.statusCode).toBe(200);
    expect(pendingDetail.json()).toMatchObject({ paymentStatus: 'Pending' });

    const forbidden = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}/checkout?identity=server_sage` });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'WINNER_REQUIRED' });

    const initial = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}/checkout?identity=byte_bidder` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ checkout: { paymentId: null, status: 'pending', finalPriceCents: 12_500 } });

    const providerRequestsBefore = stripeSessionRequests.length;
    const created = await Promise.all(Array.from({ length: 4 }, () => app.inject({
      method: 'POST',
      url: `/api/auctions/${auction.id}/checkout`,
      payload: { identity: 'byte_bidder' },
    })));
    expect(created.every((response) => response.statusCode === 200)).toBe(true);
    const paymentIds = new Set(created.map((response) => response.json().checkout.paymentId));
    const sessionIds = new Set(created.map((response) => response.json().checkout.stripeSessionId));
    expect(paymentIds.size).toBe(1);
    expect(sessionIds.size).toBe(1);
    expect(stripeSessionRequests).toHaveLength(providerRequestsBefore + 1);

    const paymentId = created[0].json().checkout.paymentId as string;
    const sessionId = created[0].json().checkout.stripeSessionId as string;
    const event = {
      eventId: randomUUID(),
      eventType: 'checkout.session.completed',
      occurredAt: new Date().toISOString(),
      data: { object: { id: sessionId, object: 'checkout.session', status: 'complete', payment_status: 'paid', client_reference_id: paymentId, amount_total: 12_500, currency: 'usd' } },
    };
    const rawEvent = JSON.stringify(event);

    const forged = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': '00'.repeat(32) },
      payload: rawEvent,
    });
    expect(forged.statusCode).toBe(401);

    const mismatchedEvent = JSON.stringify({
      ...event,
      eventId: randomUUID(),
      data: { object: { ...event.data.object, amount_total: 12_501 } },
    });
    const mismatchedSignature = createHmac('sha256', 'test_checkout_secret').update(mismatchedEvent).digest('hex');
    const mismatched = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': mismatchedSignature },
      payload: mismatchedEvent,
    });
    expect(mismatched.statusCode).toBe(409);

    const signature = createHmac('sha256', 'test_checkout_secret').update(rawEvent).digest('hex');
    paymentUpdates.length = 0;
    const paid = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': signature },
      payload: rawEvent,
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({ received: true });

    const replay = await app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'x-stripe-signature': signature },
      payload: rawEvent,
    });
    expect(replay.statusCode).toBe(200);
    expect(paymentUpdates).toEqual([{ auctionId: auction.id, status: 'Paid' }]);

    const paidDetail = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}` });
    expect(paidDetail.statusCode).toBe(200);
    expect(paidDetail.json()).toMatchObject({ paymentStatus: 'Paid' });

    const receipt = await app.inject({ method: 'GET', url: `/api/auctions/${auction.id}/checkout?identity=byte_bidder` });
    expect(receipt.json()).toMatchObject({ checkout: { paymentId, stripeSessionId: sessionId, status: 'paid', paidAt: expect.any(String) } });
    const persisted = await database.query<{ count: string; status: string }>(`SELECT COUNT(*)::text AS count, MAX(status) AS status
      FROM winner_payments WHERE auction_id = $1`, [auction.id]);
    expect(persisted.rows[0]).toEqual({ count: '1', status: 'paid' });
    await database.end();
  });
});
