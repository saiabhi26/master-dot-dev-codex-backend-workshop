import { z } from 'zod';

export const auctionEndedEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().min(1),
  auctionId: z.number().int().positive(),
  auctionTitle: z.string().min(1).max(120),
  seller: z.string().min(1).max(80),
  winner: z.string().min(1).max(80),
  finalPriceCents: z.number().int().positive(),
  closesAt: z.iso.datetime({ offset: true }),
});

export type AuctionEndedEvent = z.infer<typeof auctionEndedEventSchema>;

export const auctionEndedQueue = 'auction.ended';

export type AuctionNotification = {
  id: number;
  eventId: string;
  auctionId: number;
  recipient: string;
  kind: 'winner' | 'seller';
  auctionTitle: string;
  winner: string;
  finalPriceCents: number;
  createdAt: string;
};
