CREATE TABLE winner_payments (
  id uuid PRIMARY KEY,
  auction_id integer NOT NULL UNIQUE REFERENCES auction_results(auction_id) ON DELETE CASCADE,
  winner text NOT NULL CHECK (char_length(winner) BETWEEN 1 AND 80),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  stripe_session_id text UNIQUE,
  stripe_checkout_url text,
  stripe_event_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  CHECK ((status = 'pending' AND paid_at IS NULL) OR (status = 'paid' AND paid_at IS NOT NULL)),
  CHECK ((stripe_session_id IS NULL) = (stripe_checkout_url IS NULL))
);

CREATE INDEX winner_payments_winner_status_idx
  ON winner_payments (winner, status, created_at);
