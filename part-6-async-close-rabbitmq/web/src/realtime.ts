import { io } from 'socket.io-client';

import { fetchAuction, fetchUnreadNotifications, type AuctionItem, type AuctionNotification, type Bid } from './catalog';
import type { DemoIdentity } from './catalog';

export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

type AuctionSnapshot = {
  auction: AuctionItem;
  bids: Bid[];
};

type JoinResult = { ok: true; instanceId: string } | { ok: false; error: string };

export function subscribeToNotifications(
  identity: DemoIdentity,
  onNotification: (notification: AuctionNotification) => void,
  onReconciled: (notifications: AuctionNotification[]) => void,
  onRead: (notificationId: number) => void,
) {
  const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, {
    auth: { identity },
    transports: ['websocket'],
  });
  socket.on('notification:received', onNotification);
  socket.on('notification:read', onRead);
  socket.on('connect', () => {
    void fetchUnreadNotifications(identity).then(onReconciled).catch(() => undefined);
  });
  return () => { socket.disconnect(); };
}

export function subscribeToAuction(
  auctionId: number,
  applySnapshot: (auction: AuctionItem) => void,
  setStatus: (status: RealtimeStatus) => void,
  setInstanceId: (instanceId: string | null) => void,
) {
  const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, {
    autoConnect: false,
    transports: ['websocket'],
  });
  let stopped = false;
  let hasBeenLive = false;
  let joinTimer: number | null = null;

  const clearJoinTimer = () => {
    if (joinTimer !== null) window.clearTimeout(joinTimer);
    joinTimer = null;
  };

  socket.on('auction:updated', (snapshot: AuctionSnapshot) => {
    applySnapshot({ ...snapshot.auction, bids: snapshot.bids ?? [] });
  });

  socket.on('connect', () => {
    setStatus(hasBeenLive ? 'reconnecting' : 'connecting');
    clearJoinTimer();
    joinTimer = window.setTimeout(() => setStatus('unavailable'), 5_000);

    socket.emit('auction:join', auctionId, async (result: JoinResult) => {
      clearJoinTimer();
      if (stopped || !result.ok) {
        if (!stopped) setStatus('unavailable');
        return;
      }

      try {
        applySnapshot(await fetchAuction(auctionId));
        if (!stopped && socket.connected) {
          hasBeenLive = true;
          setInstanceId(result.instanceId);
          setStatus('live');
        }
      } catch {
        if (!stopped) setStatus('unavailable');
      }
    });
  });

  socket.on('disconnect', (reason) => {
    if (!stopped && reason !== 'io client disconnect') {
      setInstanceId(null);
      setStatus('reconnecting');
    }
  });
  socket.on('connect_error', () => {
    if (!stopped) setStatus(hasBeenLive ? 'reconnecting' : 'unavailable');
  });
  socket.io.on('reconnect_attempt', () => {
    if (!stopped) setStatus('reconnecting');
  });
  socket.io.on('reconnect_failed', () => {
    if (!stopped) setStatus('unavailable');
  });

  socket.connect();

  return () => {
    stopped = true;
    clearJoinTimer();
    setInstanceId(null);
    socket.disconnect();
  };
}
