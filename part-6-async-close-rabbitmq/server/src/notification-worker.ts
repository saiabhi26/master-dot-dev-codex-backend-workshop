import './otel.js';

import { Emitter } from '@socket.io/redis-emitter';
import amqp from 'amqplib';
import { Redis } from 'ioredis';
import pg from 'pg';
import { z } from 'zod';
import { auctionEndedEventSchema, auctionEndedQueue, type AuctionNotification } from './auction-event.js';

const runtime = z.object({
  DATABASE_URL: z.string().default('postgres://auction:auction@localhost:55432/auction_part_6'),
  RABBITMQ_URL: z.string().default('amqp://auction:auction@localhost:56726'),
  REDIS_URL: z.string().default('redis://localhost:56379'),
}).parse(process.env);

const pool = new pg.Pool({ connectionString: runtime.DATABASE_URL });
const redis = new Redis(runtime.REDIS_URL);
const emitter = new Emitter(redis);
let shuttingDown = false;

async function main() {
  const connection = await amqp.connect(runtime.RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertQueue(auctionEndedQueue, { durable: true });
  await channel.prefetch(10);

  await channel.consume(auctionEndedQueue, async (message) => {
    if (!message) return;
    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(message.content.toString('utf8'));
    } catch {
      console.error('Discarding auction-ended event with invalid JSON');
      channel.ack(message);
      return;
    }
    const parsed = auctionEndedEventSchema.safeParse(rawEvent);
    if (!parsed.success) {
      console.error('Discarding invalid auction-ended event', parsed.error.issues);
      channel.ack(message);
      return;
    }

    const event = parsed.data;
    try {
      const recipients = [
        { recipient: event.winner, kind: 'winner' as const },
        { recipient: event.seller, kind: 'seller' as const },
      ].filter((value, index, all) => all.findIndex((candidate) => candidate.recipient === value.recipient) === index);

      for (const target of recipients) {
        const inserted = await pool.query<{ id: number; createdAt: Date }>(`
          INSERT INTO auction_notifications (
            event_id, auction_id, recipient, kind, auction_title, winner, final_price_cents
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (event_id, recipient) DO UPDATE SET event_id = EXCLUDED.event_id
          RETURNING id, created_at AS "createdAt"
        `, [event.eventId, event.auctionId, target.recipient, target.kind, event.auctionTitle, event.winner, event.finalPriceCents]);
        const notification: AuctionNotification = {
          id: inserted.rows[0].id,
          eventId: event.eventId,
          auctionId: event.auctionId,
          recipient: target.recipient,
          kind: target.kind,
          auctionTitle: event.auctionTitle,
          winner: event.winner,
          finalPriceCents: event.finalPriceCents,
          createdAt: inserted.rows[0].createdAt.toISOString(),
        };
        emitter.to(`user:${target.recipient}`).emit('notification:received', notification);
      }
      channel.ack(message);
    } catch (error) {
      console.error('Auction notification failed; returning message to queue', error);
      channel.nack(message, false, true);
    }
  }, { noAck: false });

  console.log('Notification Worker is consuming auction-ended events');
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await channel.close();
    await connection.close();
    redis.disconnect();
    await pool.end();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((error) => {
  console.error('Notification Worker failed to start', error);
  redis.disconnect();
  void pool.end();
  process.exit(1);
});
