import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyRequest } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import type { AuctionNotification } from './auction-event.js';

const connectionString = process.env.DATABASE_URL ?? 'postgres://auction:auction@localhost:55432/auction_part_7';

const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  status: z.enum(['open']).optional(),
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
const notificationListSchema = z.object({ recipient: z.enum(demoIdentities) });
const notificationParamsSchema = z.object({ id: z.coerce.number().int().positive() });
const notificationReadSchema = z.object({ recipient: z.enum(demoIdentities) });
const checkoutIdentitySchema = z.object({ identity: z.enum(demoIdentities) });
const stripeSessionSchema = z.object({
  id: z.string().startsWith('cs_'),
  object: z.literal('checkout.session'),
  url: z.string().url(),
  status: z.enum(['open', 'complete']),
  payment_status: z.enum(['unpaid', 'paid']),
  client_reference_id: z.string().uuid(),
});
const stripeWebhookSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('checkout.session.completed'),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.object({
    object: z.object({
      id: z.string().startsWith('cs_'),
      object: z.literal('checkout.session'),
      status: z.literal('complete'),
      payment_status: z.literal('paid'),
      client_reference_id: z.string().uuid(),
      amount_total: z.number().int().positive().safe(),
      currency: z.literal('usd'),
    }),
  }),
});

const artByCategory: Record<(typeof categories)[number], string> = {
  GPUs: 'gpu',
  CPUs: 'cpu',
  Memory: 'memory',
  Chassis: 'chassis',
  Networking: 'switch',
  Cooling: 'cooling',
};

export type AuctionRow = {
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

export type BidRow = {
  id: number;
  bidder: string;
  amountCents: number;
  placedAt: Date;
};

type Queryable = pg.Pool | pg.PoolClient;

export type AuctionSnapshot = {
  auction: AuctionRow;
  bids: BidRow[];
};

export type PaymentStatusUpdate = {
  auctionId: number;
  status: 'Paid';
};

type BuildAppOptions = {
  instanceId?: string;
  isRealtimeReady?: () => boolean;
  onAuctionUpdated?: (snapshot: AuctionSnapshot) => void | Promise<void>;
  onPaymentUpdated?: (update: PaymentStatusUpdate) => void | Promise<void>;
  onNotificationRead?: (recipient: string, notificationId: number) => void | Promise<void>;
  stripeBaseUrl?: string;
  webBaseUrl?: string;
  stripeWebhookSecret?: string;
  stripeFetch?: typeof fetch;
};

type NotificationRow = Omit<AuctionNotification, 'createdAt'> & { createdAt: Date };

type CheckoutRow = {
  auctionId: number;
  auctionTitle: string;
  seller: string;
  winner: string | null;
  finalPriceCents: number;
  paymentId: string | null;
  paymentStatus: 'pending' | 'paid' | null;
  stripeSessionId: string | null;
  stripeCheckoutUrl: string | null;
  createdAt: Date | null;
  paidAt: Date | null;
};

type JsonRequest = FastifyRequest & { rawJsonBody?: Buffer };

const checkoutSelect = `SELECT
  a.id AS "auctionId",
  a.title AS "auctionTitle",
  a.seller,
  result.winner,
  result.final_price_cents AS "finalPriceCents",
  payment.id AS "paymentId",
  payment.status AS "paymentStatus",
  payment.stripe_session_id AS "stripeSessionId",
  payment.stripe_checkout_url AS "stripeCheckoutUrl",
  payment.created_at AS "createdAt",
  payment.paid_at AS "paidAt"
FROM auctions a
LEFT JOIN auction_results result ON result.auction_id = a.id
LEFT JOIN winner_payments payment ON payment.auction_id = result.auction_id`;

function publicCheckout(row: CheckoutRow) {
  return {
    auctionId: row.auctionId,
    auctionTitle: row.auctionTitle,
    seller: row.seller,
    winner: row.winner,
    finalPriceCents: row.finalPriceCents,
    paymentId: row.paymentId,
    status: row.paymentStatus ?? 'pending',
    stripeSessionId: row.stripeSessionId,
    createdAt: row.createdAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
  };
}

async function findCheckout(database: Queryable, auctionId: number) {
  const result = await database.query<CheckoutRow>(`${checkoutSelect} WHERE a.id = $1`, [auctionId]);
  return result.rows[0];
}

function authorizeCheckout(row: CheckoutRow | undefined, identity: string, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  if (!row) return reply.code(404).send({ code: 'AUCTION_NOT_FOUND', error: 'Auction not found.' });
  if (!row.winner) return reply.code(409).send({ code: 'AUCTION_RESULT_PENDING', error: 'Winner Checkout will be ready when the Auction Result is available.' });
  if (row.winner !== identity) return reply.code(403).send({ code: 'WINNER_REQUIRED', error: 'Only the winning Bidder can check out this Auction.' });
  return null;
}

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
    CASE WHEN a.closes_at > clock_timestamp() THEN 'Open' ELSE 'Ended' END AS status
  FROM auctions a
  LEFT JOIN bids b ON b.auction_id = a.id
`;

async function findAuction(database: Queryable, id: number) {
  const result = await database.query<AuctionRow>(`${auctionSelect}
    WHERE a.id = $1
    GROUP BY a.id`, [id]);
  return result.rows[0];
}

async function findBids(database: Queryable, auctionId: number) {
  const result = await database.query<BidRow>(`SELECT
    id,
    bidder,
    amount_cents AS "amountCents",
    placed_at AS "placedAt"
  FROM bids
  WHERE auction_id = $1
  ORDER BY placed_at DESC, id DESC`, [auctionId]);
  return result.rows;
}

async function findPaymentStatus(database: Queryable, auctionId: number) {
  const result = await database.query<{ paymentStatus: 'Pending' | 'Paid' | null }>(`SELECT CASE
    WHEN auction_result.winner IS NULL THEN NULL
    WHEN payment.status = 'paid' THEN 'Paid'
    ELSE 'Pending'
  END AS "paymentStatus"
  FROM auction_results auction_result
  LEFT JOIN winner_payments payment ON payment.auction_id = auction_result.auction_id
  WHERE auction_result.auction_id = $1`, [auctionId]);
  return result.rows[0]?.paymentStatus ?? null;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 1000 });
  const instanceId = options.instanceId ?? 'api';
  const stripeBaseUrl = options.stripeBaseUrl ?? process.env.STRIPE_BASE_URL ?? 'http://127.0.0.1:7107';
  const webBaseUrl = options.webBaseUrl ?? process.env.WEB_BASE_URL ?? 'http://localhost:5107';
  const stripeWebhookSecret = options.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_local_part_7';
  const stripeFetch = options.stripeFetch ?? fetch;

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const rawBody = body as Buffer;
    (request as JsonRequest).rawJsonBody = rawBody;
    try {
      done(null, JSON.parse(rawBody.toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-api-instance', instanceId);
  });

  app.get('/api/health', async (request, reply) => {
    let db: 'ok' | 'down' = 'ok';
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      db = 'down';
      request.log.error({ err: error }, 'database health check failed');
    }

    const redis = options.isRealtimeReady?.() === false ? 'down' : 'ok';
    const health = { ok: db === 'ok' && redis === 'ok', db, redis, instanceId, requestId: request.id };
    return health.ok ? health : reply.code(503).send(health);
  });

  app.get('/api/auctions', async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid auction query', issues: parsed.error.issues });
    }

    const search = parsed.data.q || null;
    const openOnly = parsed.data.status === 'open';
    const result = await pool.query<AuctionRow>(`${auctionSelect}
      WHERE ($1::text IS NULL
        OR a.title ILIKE '%' || $1 || '%'
        OR a.category ILIKE '%' || $1 || '%'
        OR a.kicker ILIKE '%' || $1 || '%')
        AND ($3::boolean = false OR a.closes_at > clock_timestamp())
      GROUP BY a.id
      ORDER BY a.closes_at ASC, a.id ASC
      LIMIT $2`, [search, parsed.data.limit, openOnly]);

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

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const lockedAuction = await client.query<{ id: number; seller: string; closesAt: Date }>(
        `SELECT id, seller, closes_at AS "closesAt"
         FROM auctions
         WHERE id = $1
         FOR UPDATE`,
        [params.data.id],
      );
      if (!lockedAuction.rowCount) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return reply.code(404).send({ error: 'Auction not found' });
      }

      const auction = await findAuction(client, params.data.id);
      const evaluatedAt = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      if (evaluatedAt.rows[0].now >= lockedAuction.rows[0].closesAt) {
        const bids = await findBids(client, params.data.id);
        await client.query('ROLLBACK');
        transactionOpen = false;
        return reply.code(409).send({
          code: 'AUCTION_ENDED',
          error: 'This auction has ended and is no longer accepting bids.',
          auction,
          bids,
        });
      }

      if (parsed.data.bidder === lockedAuction.rows[0].seller) {
        const bids = await findBids(client, params.data.id);
        await client.query('ROLLBACK');
        transactionOpen = false;
        return reply.code(403).send({
          code: 'SELLER_CANNOT_BID',
          error: 'You cannot bid on an auction you are selling.',
          auction,
          bids,
        });
      }

      const minimumBidCents = auction.currentPriceCents + 100;
      if (parsed.data.amountCents < minimumBidCents) {
        const bids = await findBids(client, params.data.id);
        await client.query('ROLLBACK');
        transactionOpen = false;
        return reply.code(409).send({
          code: 'BID_STALE',
          error: `Another bidder moved first. The minimum bid is ${minimumBidCents} cents.`,
          minimumBidCents,
          auction,
          bids,
        });
      }

      await client.query(`INSERT INTO bids (auction_id, bidder, amount_cents)
        VALUES ($1, $2, $3)`, [params.data.id, parsed.data.bidder, parsed.data.amountCents]);

      const acceptedAuction = await findAuction(client, params.data.id);
      const bids = await findBids(client, params.data.id);
      await client.query('COMMIT');
      transactionOpen = false;
      const snapshot = { auction: acceptedAuction, bids };
      const logBroadcastFailure = (error: unknown) => {
        request.log.error({ err: error, auctionId: params.data.id }, 'auction realtime broadcast failed');
      };
      try {
        void Promise.resolve(options.onAuctionUpdated?.(snapshot)).catch(logBroadcastFailure);
      } catch (error) {
        logBroadcastFailure(error);
      }
      return reply.code(201).send(snapshot);
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/auctions/:id', async (request, reply) => {
    const parsed = auctionParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid auction id' });

    const auction = await findAuction(pool, parsed.data.id);
    if (!auction) return reply.code(404).send({ error: 'Auction not found' });
    return {
      auction,
      bids: await findBids(pool, parsed.data.id),
      paymentStatus: await findPaymentStatus(pool, parsed.data.id),
    };
  });

  app.get('/api/auctions/:id/checkout', async (request, reply) => {
    const params = auctionParamsSchema.safeParse(request.params);
    const query = checkoutIdentitySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: 'Invalid Winner Checkout request.' });

    const checkout = await findCheckout(pool, params.data.id);
    const authorizationError = authorizeCheckout(checkout, query.data.identity, reply);
    if (authorizationError) return authorizationError;
    return { checkout: publicCheckout(checkout!) };
  });

  app.post('/api/auctions/:id/checkout', async (request, reply) => {
    const params = auctionParamsSchema.safeParse(request.params);
    const body = checkoutIdentitySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Invalid Winner Checkout request.' });

    const client = await pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      await client.query('SELECT auction_id FROM auction_results WHERE auction_id = $1 FOR UPDATE', [params.data.id]);
      let checkout = await findCheckout(client, params.data.id);
      const authorizationError = authorizeCheckout(checkout, body.data.identity, reply);
      if (authorizationError) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return authorizationError;
      }

      if (!checkout!.paymentId) {
        const paymentId = randomUUID();
        await client.query(`INSERT INTO winner_payments (id, auction_id, winner, amount_cents)
          VALUES ($1, $2, $3, $4)`, [paymentId, params.data.id, checkout!.winner, checkout!.finalPriceCents]);
        checkout = await findCheckout(client, params.data.id);
      }

      if (checkout!.paymentStatus === 'paid') {
        await client.query('COMMIT');
        transactionOpen = false;
        return { checkout: publicCheckout(checkout!), checkoutUrl: null };
      }

      if (!checkout!.stripeSessionId) {
        let response: Response;
        try {
          response = await stripeFetch(`${stripeBaseUrl}/v1/checkout/sessions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              mode: 'payment',
              client_reference_id: checkout!.paymentId,
              line_items: [{
                price_data: {
                  currency: 'usd',
                  product_data: { name: checkout!.auctionTitle },
                  unit_amount: checkout!.finalPriceCents,
                },
                quantity: 1,
              }],
              success_url: `${webBaseUrl}/auctions/${params.data.id}/checkout?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
              cancel_url: `${webBaseUrl}/auctions/${params.data.id}/checkout?checkout=canceled`,
            }),
          });
        } catch (error) {
          request.log.error({ err: error, auctionId: params.data.id }, 'mock Stripe session creation failed');
          await client.query('ROLLBACK');
          transactionOpen = false;
          return reply.code(503).send({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', error: 'Payment checkout is temporarily unavailable. Try again.' });
        }
        const rawSession: unknown = await response.json().catch(() => null);
        const session = stripeSessionSchema.safeParse(rawSession);
        if (!response.ok || !session.success || session.data.client_reference_id !== checkout!.paymentId) {
          request.log.error({ auctionId: params.data.id, providerStatus: response.status }, 'mock Stripe returned an invalid Checkout Session');
          await client.query('ROLLBACK');
          transactionOpen = false;
          return reply.code(502).send({ code: 'PAYMENT_PROVIDER_INVALID_RESPONSE', error: 'Payment checkout could not be prepared. Try again.' });
        }
        await client.query(`UPDATE winner_payments
          SET stripe_session_id = $2, stripe_checkout_url = $3
          WHERE id = $1`, [checkout!.paymentId, session.data.id, session.data.url]);
        checkout = await findCheckout(client, params.data.id);
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return { checkout: publicCheckout(checkout!), checkoutUrl: checkout!.stripeCheckoutUrl };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/webhooks/stripe', async (request, reply) => {
    const rawBody = (request as JsonRequest).rawJsonBody;
    const signature = request.headers['x-stripe-signature'];
    if (!rawBody || typeof signature !== 'string') {
      return reply.code(401).send({ error: 'Missing mock Stripe signature.' });
    }
    const expected = createHmac('sha256', stripeWebhookSecret).update(rawBody).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'hex');
    } catch {
      return reply.code(401).send({ error: 'Invalid mock Stripe signature.' });
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return reply.code(401).send({ error: 'Invalid mock Stripe signature.' });
    }

    const event = stripeWebhookSchema.safeParse(request.body);
    if (!event.success) return reply.code(400).send({ error: 'Invalid mock Stripe event.' });
    const session = event.data.data.object;
    const client = await pool.connect();
    let transactionOpen = false;
    let paymentUpdate: PaymentStatusUpdate | null = null;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const payment = await client.query<{
        id: string;
        auctionId: number;
        status: 'pending' | 'paid';
        amountCents: number;
        currency: string;
        stripeSessionId: string | null;
      }>(`SELECT id, auction_id AS "auctionId", status, amount_cents AS "amountCents", currency,
          stripe_session_id AS "stripeSessionId"
        FROM winner_payments
        WHERE id = $1
        FOR UPDATE`, [session.client_reference_id]);
      const row = payment.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return reply.code(404).send({ error: 'Winner Payment not found.' });
      }
      if (
        row.stripeSessionId !== session.id
        || row.amountCents !== session.amount_total
        || row.currency !== session.currency
      ) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return reply.code(409).send({ error: 'Mock Stripe event does not match the Winner Payment.' });
      }
      if (row.status === 'pending') {
        await client.query(`UPDATE winner_payments
          SET status = 'paid', paid_at = clock_timestamp(), stripe_event_id = $2
          WHERE id = $1`, [row.id, event.data.eventId]);
        paymentUpdate = { auctionId: row.auctionId, status: 'Paid' };
      }
      await client.query('COMMIT');
      transactionOpen = false;
      if (paymentUpdate) {
        try {
          await options.onPaymentUpdated?.(paymentUpdate);
        } catch (error) {
          request.log.error({ err: error, auctionId: paymentUpdate.auctionId }, 'payment status broadcast failed');
        }
      }
      return { received: true };
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get('/api/notifications', async (request, reply) => {
    const parsed = notificationListSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid notification recipient' });

    const result = await pool.query<NotificationRow>(`SELECT
      id,
      event_id AS "eventId",
      auction_id AS "auctionId",
      recipient,
      kind,
      auction_title AS "auctionTitle",
      winner,
      final_price_cents AS "finalPriceCents",
      created_at AS "createdAt"
    FROM auction_notifications
    WHERE recipient = $1 AND read_at IS NULL
    ORDER BY created_at ASC, id ASC`, [parsed.data.recipient]);

    return {
      notifications: result.rows.map((notification) => ({
        ...notification,
        createdAt: notification.createdAt.toISOString(),
      })),
    };
  });

  app.patch('/api/notifications/:id/read', async (request, reply) => {
    const params = notificationParamsSchema.safeParse(request.params);
    const body = notificationReadSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid notification read request' });
    }

    const updated = await pool.query<{ id: number }>(`UPDATE auction_notifications
      SET read_at = COALESCE(read_at, clock_timestamp())
      WHERE id = $1 AND recipient = $2
      RETURNING id`, [params.data.id, body.data.recipient]);
    if (!updated.rowCount) return reply.code(404).send({ error: 'Notification not found' });

    try {
      await options.onNotificationRead?.(body.data.recipient, params.data.id);
    } catch (error) {
      request.log.error({ err: error, notificationId: params.data.id }, 'notification read broadcast failed');
    }
    return { id: params.data.id, read: true };
  });

  app.addHook('onClose', async () => pool.end());
  return app;
}
