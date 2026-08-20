CREATE TABLE auctions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  kicker text NOT NULL CHECK (char_length(kicker) BETWEEN 1 AND 160),
  category text NOT NULL CHECK (category IN ('GPUs', 'CPUs', 'Memory', 'Chassis', 'Networking', 'Cooling')),
  art text NOT NULL CHECK (art IN ('gpu', 'cpu', 'memory', 'chassis', 'switch', 'cooling')),
  starting_price_cents integer NOT NULL CHECK (starting_price_cents > 0),
  seller text NOT NULL CHECK (char_length(seller) BETWEEN 1 AND 80),
  seller_rating text NOT NULL CHECK (char_length(seller_rating) BETWEEN 1 AND 40),
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 120),
  condition text NOT NULL CHECK (char_length(condition) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  specs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(specs) = 'array'),
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bids (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_id integer NOT NULL REFERENCES auctions(id),
  bidder text NOT NULL CHECK (char_length(bidder) BETWEEN 1 AND 80),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  placed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bids_auction_amount_idx ON bids (auction_id, amount_cents DESC, placed_at DESC);
CREATE INDEX auctions_closes_at_idx ON auctions (closes_at);

WITH seeded AS (
  INSERT INTO auctions (
    title, kicker, category, art, starting_price_cents, seller, seller_rating,
    location, condition, description, specs, closes_at, created_at
  ) VALUES
    ('NVIDIA H100 SXM 80GB', 'Retired from a very serious rack', 'GPUs', 'gpu', 1625000, 'North Loop Compute', '99.8% positive', 'Minneapolis, MN', 'Used · Fully tested', 'A production-pulled H100 accelerator with a clean diagnostic report. It spent its first career training recommendation models and is ready for something more interesting.', '[["Memory","80GB HBM3"],["Interface","SXM5"],["TDP","700W"],["Included","Protective carrier"]]', now() + interval '2 hours 14 minutes', now() - interval '7 days'),
    ('AMD EPYC 9654 · 96 cores', 'Has seen things. Mostly Kubernetes.', 'CPUs', 'cpu', 332500, 'Decommissioned Dreams', '100% positive', 'Columbus, OH', 'Open box · Bench tested', 'Ninety-six Zen 4 cores looking for a loving socket. Removed during a capacity refresh, cleaned, inspected, and tested under sustained all-core load.', '[["Cores / threads","96 / 192"],["Base clock","2.4 GHz"],["Socket","SP5"],["L3 cache","384MB"]]', now() + interval '5 hours 48 minutes', now() - interval '7 days'),
    ('1.5TB DDR5 ECC memory kit', 'Enough RAM to finally open Chrome', 'Memory', 'memory', 379000, 'Heap & Sons', '99.6% positive', 'Ashburn, VA', 'Used · Matched set', 'A matched set of twenty-four 64GB DDR5 ECC RDIMMs. Every module passed a 72-hour memory test, which is more rest than any of us got this week.', '[["Capacity","24 × 64GB"],["Speed","DDR5-4800"],["Type","ECC RDIMM"],["Test result","0 errors / 72 hours"]]', now() + interval '38 minutes', now() - interval '7 days'),
    ('Supermicro 4U GPU chassis', 'Rack mount, emotionally available', 'Chassis', 'chassis', 122000, 'Bare Metal Matchmakers', '98.9% positive', 'Chicago, IL', 'Used · Minor rack wear', 'A dense 4U platform for up to eight double-width accelerators. Fans are loud, airflow is excellent, and the bezel has only the tasteful amount of data-center patina.', '[["GPU capacity","8 × double-width"],["Power","4 × 2,000W"],["Drive bays","24 × 2.5-inch"],["Rails","Included"]]', now() + interval '1 day 3 hours', now() - interval '7 days'),
    ('NVIDIA Quantum-2 400Gb switch', 'Latency has left the chat', 'Networking', 'switch', 1095000, 'Layer Eight Supply', '99.9% positive', 'Dallas, TX', 'Certified refurbished', 'A 64-port NDR InfiniBand switch for clusters that have places to be. Firmware is current, ports are verified, and both redundant power supplies are included.', '[["Ports","64 × NDR 400Gb/s"],["Throughput","51.2Tb/s"],["Form factor","1U"],["Airflow","Port-to-power"]]', now() + interval '7 hours 6 minutes', now() - interval '7 days'),
    ('Direct-to-chip cooling loop', 'Please don''t spill it', 'Cooling', 'cooling', 28000, 'Cool Story Systems', '99.3% positive', 'Austin, TX', 'New old stock', 'A sealed dual-block liquid cooling assembly sized for a 2U compute sled. Pressure-tested, leak-free, and considerably less alarming than the prototype looked.', '[["Cold plates","2 × nickel-plated copper"],["Tubing","EPDM, quick disconnect"],["Rated load","1,200W"],["Coolant","Not included"]]', now() + interval '2 days 11 hours', now() - interval '7 days')
  RETURNING id, title, starting_price_cents
), bid_targets(title, current_price_cents, bid_count, current_bidder) AS (
  VALUES
    ('NVIDIA H100 SXM 80GB', 1845000, 22, 'tensor_tamer'),
    ('AMD EPYC 9654 · 96 cores', 472500, 14, 'thread_ripper_47'),
    ('1.5TB DDR5 ECC memory kit', 689000, 31, 'segfault_sally'),
    ('Supermicro 4U GPU chassis', 212000, 9, 'four_u_and_me'),
    ('NVIDIA Quantum-2 400Gb switch', 1275000, 18, 'packet_wrangler'),
    ('Direct-to-chip cooling loop', 98000, 7, 'thermal_throttler')
)
INSERT INTO bids (auction_id, bidder, amount_cents, placed_at)
SELECT
  seeded.id,
  CASE WHEN series.n = bid_targets.bid_count THEN bid_targets.current_bidder
       ELSE (ARRAY['rack_runner', 'byte_bidder', 'server_sage'])[((series.n - 1) % 3) + 1]
  END,
  seeded.starting_price_cents
    + ((bid_targets.current_price_cents - seeded.starting_price_cents) * series.n / bid_targets.bid_count),
  now() - ((bid_targets.bid_count - series.n) * interval '17 minutes')
FROM seeded
JOIN bid_targets USING (title)
CROSS JOIN LATERAL generate_series(1, bid_targets.bid_count) AS series(n);
