# GRILL.md — Part 2: Create Auctions and Bid

Pre-implementation grilling for the first persisted auction and bidding capability.

## Round 1 — Settled decisions

### Q1. What does a bid amount mean?

**Answer: direct bid.** Each accepted amount immediately becomes the current bid. The UI
uses “Your bid,” not “Your maximum bid”; proxy bidding is outside this capability.

### Q2. Who are sellers and bidders?

**Answer: fixed demo identities.** The active identity is selected in the UI and persisted
as text when acting as a seller or bidder. Authentication and account management are not
part of this capability.

### Q3. What is required to create an auction?

**Answer: a complete listing.** Title, description, category, condition, location, starting
price, and closing date/time are required. The seller is the active demo identity, the URL
uses the database ID, and existing generated artwork is selected from the category.

### Q4. How is money represented?

**Answer: integer cents.** The API and database exchange exact integer amounts and the web
app formats them as USD.

### Q5. What happens to the existing catalog?

**Answer: seed PostgreSQL.** The six existing auctions are inserted by migration and all
application reads come from PostgreSQL.

### Q6. What lifecycle exists in Part 2?

**Answer: Open and Ended.** State is derived from the auction closing time. Auction
creation requires a future closing time.

### Q7. What bidding rule belongs in Part 2?

**Answer: a bid must be strictly greater than the Current Price.** Minimum increments,
seller restrictions, ended-auction rejection, and concurrency protection remain outside
this capability.

### Q8. Where does auction creation live?

**Answer: a dedicated `/auctions/new` page.** Successful creation navigates to the new
auction's detail page.

### Q9. Which screens use persisted auctions?

**Answer: all auction browsing.** Home, search, and detail pages read from PostgreSQL.
Home shows the six auctions ending soonest; search covers all matching auctions.

### Q10. What submission feedback should users receive?

**Answer: practical inline feedback.** Forms show field-level validation and server errors,
disable submission while a request is active, preserve entered values after failures, and
show the persisted result immediately after success. Optimistic updates, toast libraries,
and automatic retries are outside this capability.

## Round 2 — Settled decisions

### Q11. Which fixed demo identities are available?

**Answer: three reusable handles.** Any selected identity can act as seller or bidder, and
the browser remembers the selection. The exact display handles are presentation copy, not
separate domain roles.

### Q12. Which auction categories are allowed?

**Answer: the existing controlled list.** GPUs, CPUs, Memory, Chassis, Networking, and
Cooling remain the canonical categories so every listing has consistent artwork and
search vocabulary.

### Q13. How are closing times entered and displayed?

**Answer: browser-local input backed by an absolute instant.** Sellers enter a future date
and time in their local zone. The browser sends UTC and viewers see the closing time in
their own local zone.

### Q14. Can Part 2 accept a bid after an auction has ended?

**Answer: yes, deliberately and temporarily.** Part 2 recognizes and displays Ended
Auctions but does not enforce the ended-auction bidding gate. That business rule remains
explicit Part 3 scope; the Part 2 bid form and API continue accepting a higher bid.

### Q15. What bid history is visible?

**Answer: the full public Bid History.** Auction details show bidder, amount, and placement
time for every bid, newest first.

### Q16. What is the source of truth for Current Price?

**Answer: persisted bids.** Current Price is derived from the highest Bid and falls back to
Starting Price when there are no bids. A second mutable current-price value is not stored.

### Q17. Where and how are inputs validated?

**Answer: practical Zod validation at the API boundary, mirrored in the web form.** Rules
cover required and bounded text, recognized categories, future closing time, integer-cent
prices, and bids greater than Current Price. The API is authoritative.

### Q18. How do seeded auctions remain current after a reset?

**Answer: relative closing times.** The migration seeds the six existing auctions using
intervals from migration time, preserving the useful ending-soon range after each reset.

### Q19. What API style connects the browser and Fastify?

**Answer: a small REST API.** It lists, retrieves, and creates auctions, with bid creation
modeled as a nested auction operation.

### Q20. Can auctions be edited or deleted?

**Answer: not in this capability.** Part 2 supports creation, browsing, and bidding only.
Editing, cancellation, and deletion are outside scope.

## Shared-understanding checkpoint

The decision frontier is empty. Implementation must not begin until the user confirms this
document and the proposed vertical feature slices.

---

# Part 3: Business Rules and Concurrency

Pre-implementation grilling for atomic bidding, authoritative auction closure, and graceful
conflict handling. Part 2 decisions remain the baseline except where Part 3 explicitly extends
them below.

## Round 1 — Settled decisions

### Q1. How are concurrent Bids evaluated?

**Answer: serialize per Auction.** Each Bid is evaluated against the latest committed Current
Price while holding an Auction-specific PostgreSQL row lock.

### Q2. What happens to equal simultaneous Bids?

**Answer: exactly one is accepted.** The first serialized Bid becomes the Current Price and the
others become Stale Bids.

### Q3. Where is the Closing Time boundary?

**Answer: strictly before Closing Time.** A Bid evaluated at or after Closing Time is rejected,
using authoritative database time rather than the browser clock.

### Q4. How are Current Price and Closing Time protected from races?

**Answer: one atomic decision.** Both checks and the accepted Bid insert occur in the same locked
database transaction.

### Q5. How are state conflicts represented by the API?

**Answer: distinct machine-readable conflicts.** Stale Bids and Ended Auctions return HTTP 409
with stable `BID_STALE` and `AUCTION_ENDED` codes and the latest Auction state.

### Q6. What does the browser do with a Stale Bid?

**Answer: refresh and preserve.** It updates Current Price and Bid History from the conflict
response, preserves the entered amount, and explains the new Minimum Bid inline.

### Q7. What does the browser do when the Auction has ended?

**Answer: replace the bid form with the final state.** It refreshes Current Price and Bid History
and preserves a rejected amount only as non-editable context.

### Q8. Are Bids retried automatically?

**Answer: no.** Every resubmission or increase in financial commitment requires explicit bidder
confirmation.

### Q9. Which adjacent bidding rules are in scope?

**Answer: prevent Seller Bids and require a Minimum Bid Increment.** Authentication, proxy
bidding, and auction extensions remain outside this capability.

## Round 2 — Settled decisions

### Q10. What is the Minimum Bid Increment policy?

**Answer: one dollar globally.** Every Bid must be at least Current Price plus $1. Sellers do
not configure the increment.

### Q11. How is a Seller Bid identified?

**Answer: exact persisted identity.** A Bid is a Seller Bid when its Bidder identity equals the
Auction's Seller identity, including for demo identities.

### Q12. How does the API reject a Seller Bid?

**Answer: HTTP 403 with a stable code.** The response uses `SELLER_CANNOT_BID` because the
identity is understood but prohibited from bidding on its own Auction.

### Q13. What does the Seller see instead of the bid form?

**Answer: a contextual explanation.** The page replaces bid controls with “You're selling this
Auction.”

### Q14. How is the Minimum Bid presented?

**Answer: label and prefill it.** The form displays the Minimum Bid and prepopulates that amount
while the input is empty.

### Q15. How does the browser reconcile a conflict?

**Answer: from the conflict response.** Each conflict carries the latest Auction and Bid History
so the browser can update atomically without a follow-up request.

### Q16. What happens to unequal concurrent Bids?

**Answer: serialized processing.** If the lower Bid obtains the Auction lock first, both can be
accepted in order; if the higher Bid obtains it first, the lower Bid becomes stale.

### Q17. What happens when an open page reaches Closing Time?

**Answer: transition locally and refresh once.** The browser replaces the form with a temporary
ended state at the displayed Closing Time and fetches the authoritative final Auction snapshot.

## Shared-understanding checkpoint

The decision frontier is empty. Implementation must not begin until the user confirms these
decisions and the proposed vertical feature slices.

---

# Part 4: Realtime Socket.IO and Redis

Pre-implementation grilling for immediate Auction detail updates and reliable fan-out when the
Fastify API is distributed. Part 3 decisions remain the baseline.

## Round 1 — Settled decisions

1. Accepted Bids update open Auction detail pages; Home and Search remain request-driven.
2. REST remains the only Bid command path; Socket.IO broadcasts committed results.
3. An update contains the authoritative Auction and complete Bid History snapshot.
4. Rejected Bids are not broadcast because they do not change shared state.
5. Each detail page joins a public `auction:{id}` room.
6. Initial connections and reconnections fetch the authoritative REST snapshot because socket
   delivery is not durable.
7. Clients use WebSocket-only transport, so distributed deployments do not require sticky
   sessions for HTTP long-polling.
8. Redis is required at startup; an instance must not silently claim distributed realtime health
   while broadcasting locally only.
9. Detail pages display Live, Reconnecting, or Unavailable connection feedback.
10. Verification must prove no-reload delivery across API processes with real Redis.

## Round 2 — Settled decisions

11. Distribution uses the standard Redis Pub/Sub adapter with `ioredis`.
12. A post-commit publication failure does not turn the accepted Bid REST response into an error;
    it is logged and reflected in realtime health.
13. Runtime Redis loss makes readiness unhealthy while the API retries Redis and preserves
    controlled REST availability.
14. Startup retries Redis for a bounded period, then exits unsuccessfully.
15. Browsers use monotonic `bidCount` ordering so delayed snapshots cannot replace newer state.
16. A page becomes Live only after room acknowledgement and successful REST reconciliation.
17. The submitting browser applies its REST response and socket event idempotently.
18. Distributed verification pins observing sockets to API A and the REST Bid to API B.

## Confirmed vertical slices

1. **Live Auction detail:** Socket.IO rooms, post-commit snapshots, reconciliation, monotonic
   application, connection feedback, and no-reload browser proof on one API instance.
2. **Distribution-safe realtime:** Redis adapter, startup/runtime health behavior, lifecycle
   cleanup, and deterministic cross-instance browser proof.

The user confirmed both slices, reviewed the Slice 1 browser handoff, and explicitly authorized
Slice 2. Both slices are implemented and verified.

---

# Part 7: Winner Checkout

Part 6 decisions remain the baseline.

## Round 1 — Settled decisions

1. Winner Checkout immediately captures payment; a successful checkout means the Auction Result
   is fully paid.
2. Only the winning Bidder may check out, and the API authoritatively verifies the selected demo
   identity against the Auction Result.
3. The charge is exactly the Auction Result's final price in USD. Shipping, tax, marketplace fees,
   and discounts are outside this capability.
4. Winner Checkout begins on a dedicated `/auctions/:id/checkout` page linked from the winner
   notification and Ended Auction detail.
5. Part 7 uses the repository's existing `stripe-service`, which provides a Stripe-shaped hosted
   Checkout Session flow.
6. The winning Bidder enters Stripe-style test card details. Card details are handled by the mock
   Stripe service and are never persisted by Auction House.
7. A durable Winner Payment records the provider identifier, amount, status, and timestamps, with
   at most one Winner Payment per Auction Result.
8. Double-clicks, retries, concurrent tabs, and repeated provider requests converge on one Winner
   Payment and must never create duplicate charges.
9. Winner Payment states were initially proposed as Pending, Paid, and Failed. Round 2 simplified
   the model to Pending and Paid only.
10. The winner sees checkout actions and a receipt; the Seller sees read-only Awaiting payment or
    Paid status.

## Round 1 — Open reconciliation

The existing mock Stripe service hosts the card form itself. Round 2 must settle how the dedicated
Auction House checkout page hands off to that hosted form and receives the winner afterward.

## Round 2 — Settled decisions

1. The dedicated Auction House checkout page shows the Auction and payment summary. Its Continue
   to payment action redirects to the mock Stripe service's hosted card form, which returns the
   winner to the Auction House checkout page.
2. Payment confirmation is synchronous: after the winner clicks Pay on the mock Stripe hosted
   form, the service validates the card and sends its completion webhook. Auction House records the
   Winner Payment as Paid before accepting the webhook, after which the service redirects the
   winner to the receipt. The Continue to payment action does not mark a payment Paid.
3. Winner Payments have only Pending and Paid states. A declined card is a recoverable payment
   attempt within hosted checkout and does not create a durable Failed state.
4. Cancelling hosted checkout returns to the Auction House checkout page with the Winner Payment
   still Pending. Retrying reuses the open Checkout Session.
5. If the in-memory mock Stripe service loses a Checkout Session after restart, Auction House
   safely creates a replacement for the same Winner Payment.
6. Auction House verifies the webhook HMAC over the raw body and validates the event type, session,
   Winner Payment reference, amount, currency, and current state. Replays are idempotent.
7. Successful payment produces a durable receipt showing the Auction title, amount, Paid status,
   payment time, and provider session reference, but no card details.
8. The Seller receives live payment-status updates through the existing Socket.IO infrastructure,
   with REST reconciliation after reconnect rather than a new popup notification.
9. Winner Checkout has no payment deadline; a Winner Payment remains Pending until paid.
10. Refunds, disputes, and Seller fulfilment are outside this capability.

## Shared-understanding checkpoint

The decision frontier is empty. Implementation must not begin until the user confirms the
following vertical feature slices.

## Confirmed vertical slices

1. **Winner pays and receives a receipt:** Persist one Pending Winner Payment per winning Auction
   Result; enforce winner-only access; show the dedicated Auction House checkout summary; create
   and reuse a hosted mock Stripe Checkout Session; validate the signed completion webhook and its
   business invariants; transition idempotently to Paid; and return the winner to a durable receipt.
   Verify the complete successful-card journey in the browser, including concurrent/replayed
   commands producing one Winner Payment and one paid outcome.
2. **Recoverable checkout and Seller visibility:** Keep declined and cancelled checkout Pending;
   reuse an open session; safely replace a session lost when the in-memory mock Stripe service
   restarts; reconcile winner state across tabs and reconnects; and update the Seller's Ended Auction
   payment status live through Socket.IO with REST recovery. Verify decline-to-retry, cancellation,
   provider restart recovery, and live Seller status in the browser.

The user confirmed both slices. Slice 1 is implemented and verified. The Seller visibility portion
of Slice 2 is implemented and verified; its checkout recovery cases remain pending.

---

# Part 6: Async Auction Close and RabbitMQ Notifications

Part 4 decisions remain the baseline. The following decisions were confirmed before Part 6
implementation.

## Settled decisions

1. Part 6 copies Part 4's source-controlled baseline but excludes generated artifacts.
2. An Auction Result is persisted once with the winner and final price; an Auction with no Bids
   has no winner and produces no notification.
3. Both the winning Bidder and Seller receive recipient-specific Auction Notifications.
4. Demo identities join private `user:{identity}` Socket.IO rooms during the handshake.
5. A persistent, dismissible popup appears on every screen and links to the Ended Auction.
6. The close worker polls every second by default and safely supports multiple instances using
   PostgreSQL row locks, `SKIP LOCKED`, and unique Auction Results.
7. The close worker publishes a versioned event with a stable ID and authoritative result fields.
8. RabbitMQ uses one durable queue, persistent messages, and manual acknowledgements. PostgreSQL
   tracks publication and deduplicates notifications. Publisher confirms, retry topology,
   backoff, and a dead-letter queue are intentionally outside this capability.
9. Part 6 uses API port 3106, web port 5106, database `auction_part_6`, RabbitMQ port 56726,
   and RabbitMQ management port 15676.

## Confirmed vertical slices

1. **Live Auction-ended notifications:** closure records, safe polling, RabbitMQ publication and
   consumption, persisted recipient notifications, identity rooms, and live winner/Seller popup.
2. **Recoverable notification experience:** unread reconciliation, oldest-first recovery, read
   endpoints, and synchronized cross-tab dismissal.

The user confirmed both slices, reviewed the Slice 1 browser handoff, and explicitly authorized
Slice 2. Both slices are implemented and verified.
