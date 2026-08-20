CREATE TABLE auction_results (
  auction_id integer PRIMARY KEY REFERENCES auctions(id) ON DELETE CASCADE,
  event_id text NOT NULL UNIQUE,
  winner text,
  final_price_cents integer NOT NULL CHECK (final_price_cents > 0),
  closed_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX auction_results_unpublished_idx
  ON auction_results (closed_at, auction_id)
  WHERE published_at IS NULL;

CREATE TABLE auction_notifications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  auction_id integer NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  recipient text NOT NULL CHECK (char_length(recipient) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('winner', 'seller')),
  auction_title text NOT NULL CHECK (char_length(auction_title) BETWEEN 1 AND 120),
  winner text NOT NULL CHECK (char_length(winner) BETWEEN 1 AND 80),
  final_price_cents integer NOT NULL CHECK (final_price_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (event_id, recipient)
);

CREATE INDEX auction_notifications_recipient_unread_idx
  ON auction_notifications (recipient, created_at, id)
  WHERE read_at IS NULL;
