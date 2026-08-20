# Auction House — Part 4

```sh
npm install
npm start
```

`npm start` ensures the shared PostgreSQL and Redis containers and the `auction_part_4`
database are ready, runs pending migrations, and starts both apps. Open
<http://localhost:5104> (API `3104`).

Auction detail pages use WebSocket-only Socket.IO connections to join an Auction-specific
room. Accepted Bids are broadcast after commit as authoritative Auction and Bid History
snapshots. Initial connections and reconnections also fetch the latest REST snapshot.

Redis is required before the API begins listening. Runtime Redis loss makes
`/api/health` return 503 while `ioredis` reconnects; PostgreSQL remains the authoritative
source of Auction state.

To run the deterministic distributed topology, where sockets connect to API A on 3104 and
REST traffic is proxied to API B on 3204:

```sh
npm run start:distributed
```

The cross-instance acceptance test uses real Redis and headed Chrome:

```sh
npm run test:e2e:distributed
```
