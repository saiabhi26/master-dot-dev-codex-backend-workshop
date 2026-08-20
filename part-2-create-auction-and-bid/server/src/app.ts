import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';

const connectionString = process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_2';

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const auctionParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const demoIdentities = ['rack_runner', 'byte_bidder', 'server_sage'] as const;
const categories = ['GPUs', 'CPUs', 'Memory', 'Chassis', 'Networking', 'Cooling'] as const;
const createAuctionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  category: z.enum(categories),
  condition: z.string().trim().min(1).max(120),
  location: z.string().trim().min(1).max(120),
  startingPriceCents: z.number().int().min(1).max(1_000_000_000),
  closesAt: z.iso.datetime({ offset: true }).refine(
    (value) => new Date(value).getTime() > Date.now(),
    'Closing time must be in the future',
  ),
  seller: z.enum(demoIdentities),
});
const createBidSchema = z.object({
  bidder: z.enum(demoIdentities),
  amountCents: z.number().int().min(1).max(1_000_000_000),
});

const artByCategory: Record<(typeof categories)[number], string> = {
  GPUs: 'gpu',
  CPUs: 'cpu',
  Memory: 'memory',
  Chassis: 'chassis',
  Networking: 'switch',
  Cooling: 'cooling',
};

type AuctionRow = {
  id: number;
  title: string;
  kicker: string;
  category: string;
  art: string;
  startingPriceCents: number;
  currentPriceCents: number;
  bidCount: number;
  currentBidder: string | null;
  seller: string;
  sellerRating: string;
  location: string;
  condition: string;
  description: string;
  specs: Array<[string, string]>;
  closesAt: Date;
  status: 'Open' | 'Ended';
};

type BidRow = {
  id: number;
  bidder: string;
  amountCents: number;
  placedAt: Date;
};

const auctionSelect = `
  SELECT
    a.id,
    a.title,
    a.kicker,
    a.category,
    a.art,
    a.starting_price_cents AS "startingPriceCents",
    COALESCE(MAX(b.amount_cents), a.starting_price_cents)::integer AS "currentPriceCents",
    COUNT(b.id)::integer AS "bidCount",
    (ARRAY_AGG(b.bidder ORDER BY b.amount_cents DESC, b.placed_at DESC)
      FILTER (WHERE b.id IS NOT NULL))[1] AS "currentBidder",
    a.seller,
    a.seller_rating AS "sellerRating",
    a.location,
    a.condition,
    a.description,
    a.specs,
    a.closes_at AS "closesAt",
    CASE WHEN a.closes_at > now() THEN 'Open' ELSE 'Ended' END AS status
  FROM auctions a
  LEFT JOIN bids b ON b.auction_id = a.id
`;

async function findAuction(pool: pg.Pool, id: number) {
  const result = await pool.query<AuctionRow>(`${auctionSelect}
    WHERE a.id = $1
    GROUP BY a.id`, [id]);
  return result.rows[0];
}

async function findBids(pool: pg.Pool, auctionId: number) {
  const result = await pool.query<BidRow>(`SELECT
    id,
    bidder,
    amount_cents AS "amountCents",
    placed_at AS "placedAt"
  FROM bids
  WHERE auction_id = $1
  ORDER BY placed_at DESC, id DESC`, [auctionId]);
  return result.rows;
}

export function buildApp() {
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/api/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true, db: 'ok', requestId: request.id };
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
      return reply.code(503).send({ ok: false, db: 'down', requestId: request.id });
    }
  });

  app.get('/api/auctions', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid auction query', issues: parsed.error.issues });
    }

    const search = parsed.data.q || null;
    const result = await pool.query<AuctionRow>(`${auctionSelect}
      WHERE ($1::text IS NULL
        OR a.title ILIKE '%' || $1 || '%'
        OR a.category ILIKE '%' || $1 || '%'
        OR a.kicker ILIKE '%' || $1 || '%')
      GROUP BY a.id
      ORDER BY a.closes_at ASC, a.id ASC
      LIMIT $2`, [search, parsed.data.limit]);

    return { auctions: result.rows };
  });

  app.post('/api/auctions', async (request, reply) => {
    const parsed = createAuctionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Check the highlighted auction fields', issues: parsed.error.issues });
    }

    const auction = parsed.data;
    const inserted = await pool.query<{ id: number }>(`INSERT INTO auctions (
      title, kicker, category, art, starting_price_cents, seller, seller_rating,
      location, condition, description, specs, closes_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]'::jsonb, $11)
    RETURNING id`, [
      auction.title,
      'Fresh from the racks',
      auction.category,
      artByCategory[auction.category],
      auction.startingPriceCents,
      auction.seller,
      'New demo seller',
      auction.location,
      auction.condition,
      auction.description,
      auction.closesAt,
    ]);

    return reply.code(201).send({ auction: await findAuction(pool, inserted.rows[0].id) });
  });

  app.post('/api/auctions/:id/bids', async (request, reply) => {
    const params = auctionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid auction id' });
    const parsed = createBidSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Check the highlighted bid fields', issues: parsed.error.issues });
    }

    const auction = await findAuction(pool, params.data.id);
    if (!auction) return reply.code(404).send({ error: 'Auction not found' });
    if (parsed.data.amountCents <= auction.currentPriceCents) {
      return reply.code(400).send({
        error: `Bid must be greater than ${auction.currentPriceCents} cents`,
        currentPriceCents: auction.currentPriceCents,
      });
    }

    await pool.query(`INSERT INTO bids (auction_id, bidder, amount_cents)
      VALUES ($1, $2, $3)`, [params.data.id, parsed.data.bidder, parsed.data.amountCents]);

    return reply.code(201).send({
      auction: await findAuction(pool, params.data.id),
      bids: await findBids(pool, params.data.id),
    });
  });

  app.get('/api/auctions/:id', async (request, reply) => {
    const parsed = auctionParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid auction id' });

    const auction = await findAuction(pool, parsed.data.id);
    if (!auction) return reply.code(404).send({ error: 'Auction not found' });
    return { auction, bids: await findBids(pool, parsed.data.id) };
  });

  app.addHook('onClose', async () => pool.end());
  return app;
}
