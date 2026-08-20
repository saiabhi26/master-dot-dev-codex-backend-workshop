# Auction House — Part 7: Winner Checkout

```sh
npm install
npm install --prefix ../stripe-service
npm start
```

`npm start` ensures the shared PostgreSQL, Redis, and RabbitMQ containers and the
`auction_part_7` database are ready, runs pending migrations, and starts the API, web app,
Auction Close Worker, Notification Worker, and hosted mock Stripe service. Open
<http://localhost:5107> (API `3107`, mock Stripe `7107`).

An Auction Result with a winner can create exactly one durable Winner Payment. Only the winning
demo identity can open `/auctions/:id/checkout`. Continuing creates or reuses a Stripe-shaped
Checkout Session and redirects to the hosted card form. Use `4242 4242 4242 4242` with any valid
test expiry and three-digit CVC for a successful payment.

Auction House marks a Winner Payment Paid only after validating the mock Stripe HMAC signature,
event shape, Checkout Session, payment reference, amount, and USD currency. Replayed checkout
commands and completion events converge on the same persisted payment and receipt.

On an Ended Auction with a winner, the Seller sees the authoritative Buyer payment status as
Pending or Paid. The detail page recovers that status through REST and changes to Paid live in the
Auction Socket.IO room after the signed payment webhook commits.

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

To run the deterministic distributed topology, where sockets connect to API A on 3107 and
REST traffic is proxied to API B on 3207:

```sh
npm run start:distributed
```

The cross-instance acceptance test uses real Redis and headed Chrome:

```sh
npm run test:e2e:distributed
```

The headed Chrome checkout acceptance test covers the health page, winner notification, hosted
card form, signed webhook, replay safety, and durable receipt:

```sh
npm run test:e2e:checkout
```

Demo identities are stored per browser tab. The headed regression test verifies that navigating
one tab cannot adopt another tab's selected identity:

```sh
npm run test:e2e:identity
```
