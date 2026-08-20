import './otel.js';

import { createAdapter } from '@socket.io/redis-adapter';
import { Redis, type RedisOptions } from 'ioredis';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { AuctionNotification } from './auction-event.js';

const { buildApp } = await import('./app.js');
type AuctionSnapshot = import('./app.js').AuctionSnapshot;

const runtimeSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3106),
  INSTANCE_ID: z.string().trim().min(1).max(80).optional(),
  REDIS_URL: z.string().url().refine(
    (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
    'REDIS_URL must use redis:// or rediss://',
  ).default('redis://localhost:56379'),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
});
const runtime = runtimeSchema.parse(process.env);
const instanceId = runtime.INSTANCE_ID ?? `api-${runtime.API_PORT}`;

type ServerToClientEvents = {
  'auction:updated': (snapshot: AuctionSnapshot) => void;
  'notification:received': (notification: AuctionNotification) => void;
  'notification:read': (notificationId: number) => void;
};

type JoinResult = { ok: true; instanceId: string } | { ok: false; error: string };
type ClientToServerEvents = {
  'auction:join': (auctionId: number, acknowledge: (result: JoinResult) => void) => void;
};

const redisOptions: RedisOptions = {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => Math.min(attempt * 250, 2_000),
};
const redisPublisher = new Redis(runtime.REDIS_URL, redisOptions);
const redisSubscriber = new Redis(runtime.REDIS_URL, redisOptions);
const isRealtimeReady = () => (
  redisPublisher.status === 'ready' && redisSubscriber.status === 'ready'
);

let io: Server<ClientToServerEvents, ServerToClientEvents>;
const app = buildApp({
  instanceId,
  isRealtimeReady,
  onAuctionUpdated(snapshot) {
    io.to(`auction:${snapshot.auction.id}`).emit('auction:updated', snapshot);
  },
  onNotificationRead(recipient, notificationId) {
    io.to(`user:${recipient}`).emit('notification:read', notificationId);
  },
});
io = new Server<ClientToServerEvents, ServerToClientEvents>(app.server, {
  transports: ['websocket'],
});

for (const [role, client] of [
  ['publisher', redisPublisher],
  ['subscriber', redisSubscriber],
] as const) {
  client.on('ready', () => app.log.info({ redisRole: role }, 'Redis connection ready'));
  client.on('close', () => app.log.warn({ redisRole: role }, 'Redis connection closed'));
  client.on('error', (error) => app.log.warn({ err: error, redisRole: role }, 'Redis connection error'));
}

const auctionIdSchema = z.number().int().positive();
const identitySchema = z.enum(['rack_runner', 'byte_bidder', 'server_sage']);
io.on('connection', (socket) => {
  const identity = identitySchema.safeParse(socket.handshake.auth.identity);
  if (identity.success) void socket.join(`user:${identity.data}`);

  socket.on('auction:join', async (rawAuctionId, acknowledge) => {
    const parsed = auctionIdSchema.safeParse(rawAuctionId);
    if (!parsed.success) {
      acknowledge({ ok: false, error: 'Invalid auction id' });
      return;
    }

    for (const room of socket.rooms) {
      if (room.startsWith('auction:')) await socket.leave(room);
    }
    await socket.join(`auction:${parsed.data}`);
    acknowledge({ ok: true, instanceId });
  });
});

app.addHook('onClose', async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  redisPublisher.disconnect();
  redisSubscriber.disconnect();
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'API shutdown started');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error, signal }, 'API shutdown failed');
    process.exit(1);
  }
}
process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

async function connectRedis() {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clients = [redisPublisher, redisSubscriber];
  const readyCleanups: Array<() => void> = [];
  const readyPromise = Promise.all(clients.map((client) => new Promise<void>((resolve) => {
    if (client.status === 'ready') {
      resolve();
      return;
    }
    const onReady = () => resolve();
    client.once('ready', onReady);
    readyCleanups.push(() => client.off('ready', onReady));
  })));
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Redis was not ready within ${runtime.REDIS_CONNECT_TIMEOUT_MS}ms`)),
      runtime.REDIS_CONNECT_TIMEOUT_MS,
    );
  });

  try {
    for (const client of clients) void client.connect().catch(() => undefined);
    await Promise.race([readyPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const cleanup of readyCleanups) cleanup();
  }
}

try {
  await connectRedis();
  io.adapter(createAdapter(redisPublisher, redisSubscriber));
  await app.listen({ port: runtime.API_PORT });
} catch (error) {
  app.log.error({ err: error }, 'API startup failed');
  redisPublisher.disconnect();
  redisSubscriber.disconnect();
  process.exit(1);
}
