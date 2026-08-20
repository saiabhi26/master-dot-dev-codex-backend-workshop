# Auction House — Part 6

```sh
npm install
npm start
```

`npm start` ensures the shared PostgreSQL, Redis, and RabbitMQ containers and the
`auction_part_6` database are ready, runs pending migrations, and starts the API, web app,
Auction Close Worker, and Notification Worker. Open <http://localhost:5106> (API `3106`).

Auction detail pages use WebSocket-only Socket.IO connections to join an Auction-specific
room. Accepted Bids are broadcast after commit as authoritative Auction and Bid History
snapshots. Initial connections and reconnections also fetch the latest REST snapshot.

Redis is required before the API begins listening. Runtime Redis loss makes
`/api/health` return 503 while `ioredis` reconnects; PostgreSQL remains the authoritative
source of Auction state.

The Auction Close Worker polls for newly Ended Auctions and records one immutable Auction
Result. Results with a winner are published to the durable `auction.ended` RabbitMQ queue.
The Notification Worker persists winner and Seller notifications and emits them to private
demo-identity Socket.IO rooms through Redis.

Unread notifications are reconciled from PostgreSQL whenever a demo identity connects or
reconnects. Popups are shown oldest-first. Dismissing one marks it read through the API and
broadcasts that read state to every open tab for the same identity.

To run the deterministic distributed topology, where sockets connect to API A on 3106 and
REST traffic is proxied to API B on 3206:

```sh
npm run start:distributed
```

The cross-instance acceptance test uses real Redis and headed Chrome:

```sh
npm run test:e2e:distributed
```
