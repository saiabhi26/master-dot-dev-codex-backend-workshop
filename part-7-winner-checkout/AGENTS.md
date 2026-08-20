# Auction House — Part 7

- `server/` contains the Fastify API, PostgreSQL migrations, Auction Close Worker,
  and Notification Worker.
- `web/` contains the React + Vite UI.
- `../stripe-service/` contains the repository's hosted mock Stripe Checkout service.
- PostgreSQL, Redis, and RabbitMQ are shared from `../docker-compose.yml`; this part uses
  `auction_part_7` on host port 55432, Redis on loopback port 56379, and RabbitMQ on
  loopback port 56726. The API runs on 3107, the web app on 5107, and mock Stripe on 7107.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run migrate`, `npm run dev`, `npm start`, and `npm test`. Use
`npm run test:e2e:notifications` for the real RabbitMQ live-notification acceptance test and
`npm run test:e2e:checkout` for the headed hosted-checkout acceptance test. Use
`npm run test:e2e:identity` for the two-tab demo-identity isolation regression.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and the health page must render an OK response in a browser.

Read `CONTEXT.md` for canonical auction language and `GRILL.md` for locked capability
decisions before changing behavior.
