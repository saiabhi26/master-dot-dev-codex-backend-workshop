import './otel.js';

import amqp from 'amqplib';
import pg from 'pg';
import { z } from 'zod';
import { auctionEndedEventSchema, auctionEndedQueue, type AuctionEndedEvent } from './auction-event.js';

const runtime = z.object({
  DATABASE_URL: z.string().default('postgres://auction:auction@localhost:55432/auction_part_7'),
  RABBITMQ_URL: z.string().default('amqp://auction:auction@localhost:56726'),
  CLOSE_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
}).parse(process.env);

const pool = new pg.Pool({ connectionString: runtime.DATABASE_URL });
let stopped = false;

type ClosureRow = {
  auctionId: number;
  eventId: string;
  auctionTitle: string;
  seller: string;
  winner: string | null;
  finalPriceCents: number;
  closesAt: Date;
};

async function recordNewResults() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eligible = await client.query<ClosureRow>(`
      SELECT
        a.id AS "auctionId",
        'auction-ended:' || a.id AS "eventId",
        a.title AS "auctionTitle",
        a.seller,
        winning_bid.bidder AS winner,
        COALESCE(winning_bid.amount_cents, a.starting_price_cents)::integer AS "finalPriceCents",
        a.closes_at AS "closesAt"
      FROM auctions a
      LEFT JOIN LATERAL (
        SELECT bidder, amount_cents
        FROM bids
        WHERE auction_id = a.id
        ORDER BY amount_cents DESC, placed_at DESC, id DESC
        LIMIT 1
      ) winning_bid ON true
      WHERE a.closes_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM auction_results result WHERE result.auction_id = a.id)
      ORDER BY a.closes_at, a.id
      FOR UPDATE OF a SKIP LOCKED
      LIMIT 50
    `);

    for (const result of eligible.rows) {
      await client.query(`
        INSERT INTO auction_results (auction_id, event_id, winner, final_price_cents, closed_at)
        VALUES ($1, $2, $3, $4, clock_timestamp())
        ON CONFLICT (auction_id) DO NOTHING
      `, [result.auctionId, result.eventId, result.winner, result.finalPriceCents]);
    }
    await client.query('COMMIT');
    return eligible.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function publishPending(channel: amqp.Channel) {
  const client = await pool.connect();
  let published = 0;
  try {
    await client.query('BEGIN');
    const pending = await client.query<ClosureRow>(`
      SELECT
        result.auction_id AS "auctionId",
        result.event_id AS "eventId",
        a.title AS "auctionTitle",
        a.seller,
        result.winner,
        result.final_price_cents AS "finalPriceCents",
        a.closes_at AS "closesAt"
      FROM auction_results result
      JOIN auctions a ON a.id = result.auction_id
      WHERE result.published_at IS NULL
      ORDER BY result.closed_at, result.auction_id
      FOR UPDATE OF result SKIP LOCKED
      LIMIT 50
    `);

    for (const result of pending.rows) {
      if (!result.winner) {
        await client.query('UPDATE auction_results SET published_at = clock_timestamp() WHERE auction_id = $1', [result.auctionId]);
        continue;
      }
      const event: AuctionEndedEvent = auctionEndedEventSchema.parse({
        version: 1,
        eventId: result.eventId,
        auctionId: result.auctionId,
        auctionTitle: result.auctionTitle,
        seller: result.seller,
        winner: result.winner,
        finalPriceCents: result.finalPriceCents,
        closesAt: result.closesAt.toISOString(),
      });
      channel.sendToQueue(auctionEndedQueue, Buffer.from(JSON.stringify(event)), {
        contentType: 'application/json',
        persistent: true,
        messageId: event.eventId,
        type: 'auction.ended.v1',
      });
      await client.query('UPDATE auction_results SET published_at = clock_timestamp() WHERE auction_id = $1', [result.auctionId]);
      published += 1;
    }
    await client.query('COMMIT');
    return published;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const connection = await amqp.connect(runtime.RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue(auctionEndedQueue, { durable: true });
  connection.on('close', () => { if (!stopped) process.exitCode = 1; });
  console.log(`Auction Close Worker polling every ${runtime.CLOSE_POLL_INTERVAL_MS}ms`);

  while (!stopped) {
    try {
      const recorded = await recordNewResults();
      const published = await publishPending(channel);
      if (recorded || published) console.log({ recorded, published }, 'Auction closure poll completed');
    } catch (error) {
      console.error('Auction closure poll failed', error);
    }
    await delay(runtime.CLOSE_POLL_INTERVAL_MS);
  }

  await channel.close();
  await connection.close();
  await pool.end();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { stopped = true; });
}

main().catch((error) => {
  console.error('Auction Close Worker failed to start', error);
  process.exit(1);
});
