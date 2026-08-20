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

**Bid History**:
The public chronological record of bids placed on an auction, including each bidder, amount, and placement time.
_Avoid_: Activity log, offer history

**Seller**:
The demo identity that creates and offers an auction.
_Avoid_: Vendor, owner

**Bidder**:
The demo identity that places a bid on an auction.
_Avoid_: Buyer, customer
