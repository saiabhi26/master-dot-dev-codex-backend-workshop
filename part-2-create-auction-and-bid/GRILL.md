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
