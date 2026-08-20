import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from './app.js';

const app = buildApp();
const connectionString = process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_3';
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
    expect(response.json()).toMatchObject({ ok: true, db: 'ok' });
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

  it('places a direct bid above Current Price and returns public Bid History', async () => {
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
  });

  it('returns a stale conflict when a Bid is below the updated Minimum Bid', async () => {
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
});
