# Auction House — Part 5

- `server/` contains the Fastify API and PostgreSQL migrations.
- `web/` contains the React + Vite UI.
- PostgreSQL and Redis are shared from `../docker-compose.yml`; this part uses
  `auction_part_5` on host port 55432 and Redis on loopback port 56379. The API runs on
  3105 and the web app on 5105.

Stable root commands: `npm run db:up`, `npm run db:down`, `npm run db:reset`,
`npm run migrate`, `npm run dev`, `npm start`, and `npm test`. Use
`npm run test:e2e:distributed` for the real two-API Redis acceptance test.

Build the least that demonstrates the slice; no speculative abstraction. Before claiming
done, tests must pass and the health page must render an OK response in a browser.

Read `CONTEXT.md` for canonical auction language and `GRILL.md` for locked capability
decisions before changing behavior.
