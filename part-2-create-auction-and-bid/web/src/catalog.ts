export type ProductArtKind = 'gpu' | 'cpu' | 'memory' | 'chassis' | 'switch' | 'cooling';
export const demoIdentities = ['rack_runner', 'byte_bidder', 'server_sage'] as const;
export const auctionCategories = ['GPUs', 'CPUs', 'Memory', 'Chassis', 'Networking', 'Cooling'] as const;
export type DemoIdentity = (typeof demoIdentities)[number];
export type AuctionCategory = (typeof auctionCategories)[number];

export type AuctionItem = {
  id: number;
  title: string;
  kicker: string;
  category: string;
  art: ProductArtKind;
  startingPriceCents: number;
  currentPriceCents: number;
  bidCount: number;
  currentBidder: string | null;
  closesAt: string;
  status: 'Open' | 'Ended';
  seller: string;
  sellerRating: string;
  location: string;
  condition: string;
  description: string;
  specs: Array<[string, string]>;
  bids?: Bid[];
};

export type Bid = {
  id: number;
  bidder: string;
  amountCents: number;
  placedAt: string;
};

type AuctionListResponse = { auctions: AuctionItem[] };
type AuctionDetailResponse = { auction: AuctionItem; bids?: Bid[] };

export type CreateAuctionInput = {
  title: string;
  description: string;
  category: AuctionCategory;
  condition: string;
  location: string;
  startingPriceCents: number;
  closesAt: string;
  seller: DemoIdentity;
};

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Auction House could not load this data.');
  return body;
}

export async function fetchAuctions(query: string, limit?: number, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (limit) params.set('limit', String(limit));
  const suffix = params.size ? `?${params.toString()}` : '';
  return (await getJson<AuctionListResponse>(`/api/auctions${suffix}`, signal)).auctions;
}

export async function fetchAuction(id: number, signal?: AbortSignal) {
  const body = await getJson<AuctionDetailResponse>(`/api/auctions/${id}`, signal);
  return { ...body.auction, bids: body.bids ?? [] };
}

export async function createAuction(input: CreateAuctionInput) {
  const response = await fetch('/api/auctions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json() as AuctionDetailResponse & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'Auction House could not create this auction.');
  return body.auction;
}

export async function placeBid(auctionId: number, bidder: DemoIdentity, amountCents: number) {
  const response = await fetch(`/api/auctions/${auctionId}/bids`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bidder, amountCents }),
  });
  const body = await response.json() as AuctionDetailResponse & { error?: string; currentPriceCents?: number };
  if (!response.ok) {
    const message = body.currentPriceCents === undefined
      ? body.error ?? 'Auction House could not place this bid.'
      : `Your bid must be greater than ${formatCurrency(body.currentPriceCents)}.`;
    throw new Error(message);
  }
  return { ...body.auction, bids: body.bids ?? [] };
}

export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatTimeLeft(closesAt: string): string {
  const remainingMinutes = Math.max(0, Math.ceil((new Date(closesAt).getTime() - Date.now()) / 60_000));
  if (remainingMinutes === 0) return 'Ended';
  const days = Math.floor(remainingMinutes / 1_440);
  const hours = Math.floor((remainingMinutes % 1_440) / 60);
  const minutes = remainingMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
