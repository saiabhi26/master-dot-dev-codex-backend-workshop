import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { buildApp } from './app.js';

const app = buildApp();
const connectionString = process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_2';
let createdAuctionId: number;
afterAll(async () => {
  const cleanup = new pg.Client({ connectionString });
  await cleanup.connect();
  await cleanup.query("DELETE FROM bids WHERE auction_id IN (SELECT id FROM auctions WHERE title = 'Vitest demo auction')");
  await cleanup.query("DELETE FROM auctions WHERE title = 'Vitest demo auction'");
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
    const response = await app.inject({ method: 'GET', url: '/api/auctions?limit=6' });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.auctions).toHaveLength(6);
    expect(body.auctions[0]).toMatchObject({
      title: '1.5TB DDR5 ECC memory kit',
      currentPriceCents: 689000,
      bidCount: 31,
      currentBidder: 'segfault_sally',
    });
  });

  it('searches persisted auctions and retrieves their details', async () => {
    const searchResponse = await app.inject({ method: 'GET', url: '/api/auctions?q=memory' });
    const searchBody = searchResponse.json();

    expect(searchResponse.statusCode).toBe(200);
    expect(searchBody.auctions).toHaveLength(1);

    const detailResponse = await app.inject({
      method: 'GET',
      url: `/api/auctions/${searchBody.auctions[0].id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().auction).toMatchObject({
      category: 'Memory',
      seller: 'Heap & Sons',
      specs: expect.any(Array),
    });
    expect(detailResponse.json().bids).toHaveLength(31);
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

  it('rejects a bid that does not exceed Current Price', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/auctions/${createdAuctionId}/bids`,
      payload: { bidder: 'server_sage', amountCents: 130000 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bid must be greater than 130000 cents',
      currentPriceCents: 130000,
    });
  });
});
