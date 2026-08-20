# Auction House

This context describes auctions offered by sellers and the direct bids placed on them by bidders.

## Language

**Auction**:
A seller's listing for an item, offered from a starting price until a specified closing time.
_Avoid_: Product, item, lot

**Starting Price**:
The price of an auction before its first bid is placed.
_Avoid_: Opening bid, reserve price

**Closing Time**:
The instant at which an Open Auction becomes an Ended Auction.
_Avoid_: Expiration date, deadline

**Open Auction**:
An auction whose closing time is still in the future.
_Avoid_: Active listing, live item

**Ended Auction**:
An auction whose closing time has been reached or passed.
_Avoid_: Closed listing, expired item

**Bid**:
A bidder's direct offer to pay a specific amount for an auction; it is not a private maximum or proxy instruction.
_Avoid_: Maximum bid, automatic bid, offer

**Current Price**:
The highest bid amount for an auction, or its starting price when no bids have been placed.
_Avoid_: Maximum bid

**Minimum Bid Increment**:
The fixed one-dollar amount by which a new Bid must exceed the Current Price.
_Avoid_: Bid step, price step

**Minimum Bid**:
The lowest amount that can become the next accepted Bid, equal to the Current Price plus the Minimum Bid Increment.
_Avoid_: Next price, suggested bid

**Stale Bid**:
A Bid whose amount was based on an earlier Current Price and is below the Minimum Bid when authoritatively evaluated.
_Avoid_: Losing bid, conflicting offer

**Seller Bid**:
A Bid submitted by an Auction's own Seller.
_Avoid_: Self-offer, shill bid

**Bid History**:
The public chronological record of bids placed on an auction, including each bidder, amount, and placement time.
_Avoid_: Activity log, offer history

**Seller**:
The demo identity that creates and offers an auction.
_Avoid_: Vendor, owner

**Bidder**:
The demo identity that places a bid on an auction.
_Avoid_: Buyer, customer

**Auction Result**:
The immutable outcome recorded once an Ended Auction is processed, containing its winning Bidder and final Current Price, or no winner when it received no Bids.
_Avoid_: Close job, winner row, processed auction

**Auction Notification**:
A recipient-specific notice that an Auction Result is available. A winning Bidder receives a win notice and the Seller receives a sold notice.
_Avoid_: Alert event, RabbitMQ message, popup record

**Winner Checkout**:
The winning Bidder's act of paying the final Current Price recorded in an Auction Result.
_Avoid_: Order checkout, winning purchase

**Winner Payment**:
The durable payment obligation and outcome for exactly one Auction Result with a winner. It is for the Auction Result's final Current Price in USD and belongs to its winning Bidder.
_Avoid_: Charge row, payment attempt, Stripe payment

**Pending Winner Payment**:
A Winner Payment that has not yet been confirmed as paid.
_Avoid_: Unpaid Auction, open charge

**Paid Winner Payment**:
A Winner Payment whose full amount has been captured.
_Avoid_: Successful attempt, completed order
