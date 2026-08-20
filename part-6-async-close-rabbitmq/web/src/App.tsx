import { type FormEvent, useEffect, useRef, useState } from 'react';

import { BidRuleError, type AuctionCategory, type AuctionItem, type AuctionNotification, type DemoIdentity, auctionCategories, createAuction, demoIdentities, fetchAuction, fetchAuctions, formatCurrency, formatTimeLeft, markNotificationRead, placeBid } from './catalog';
import { ProductArt } from './components/ProductArt';
import { ProductCard } from './components/ProductCard';
import { SiteHeader } from './components/SiteHeader';
import { subscribeToAuction, subscribeToNotifications, type RealtimeStatus } from './realtime';

type Loadable<T> = { data: T | null; error: string | null };

function useAuctions(query: string, limit?: number, openOnly = false): Loadable<AuctionItem[]> {
  const [state, setState] = useState<Loadable<AuctionItem[]>>({ data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null });
    fetchAuctions(query, limit, controller.signal, openOnly)
      .then((data) => setState({ data, error: null }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ data: null, error: error instanceof Error ? error.message : 'Auctions could not be loaded.' });
        }
      });
    return () => controller.abort();
  }, [query, limit, openOnly]);
  return state;
}

function useAuction(id: number | null, refreshToken = 0): Loadable<AuctionItem> & { replaceData: (auction: AuctionItem) => void } {
  const [state, setState] = useState<Loadable<AuctionItem>>({ data: null, error: null });
  useEffect(() => {
    if (id === null) {
      setState({ data: null, error: 'Auction not found' });
      return;
    }
    const controller = new AbortController();
    setState((current) => current.data?.id === id ? { ...current, error: null } : { data: null, error: null });
    fetchAuction(id, controller.signal)
      .then((data) => setState((current) => (
        current.data?.id === data.id && current.data.bidCount > data.bidCount
          ? current
          : { data, error: null }
      )))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ data: null, error: error instanceof Error ? error.message : 'Auction could not be loaded.' });
        }
      });
    return () => controller.abort();
  }, [id, refreshToken]);
  return {
    ...state,
    replaceData: (auction) => setState((current) => (
      current.data?.id === auction.id && current.data.bidCount > auction.bidCount
        ? current
        : { data: auction, error: null }
    )),
  };
}

function CatalogState({ data: auctions, error }: Loadable<AuctionItem[]>) {
  if (error) return <div className="empty-state"><h2>Auctions unavailable</h2><p>{error}</p><button onClick={() => window.location.reload()}>Try again</button></div>;
  if (!auctions) return <div className="empty-state"><h2>Loading auctions…</h2><p>Checking the racks for available equipment.</p></div>;
  if (!auctions.length) return <div className="empty-state"><h2>No equipment found</h2><p>Try a broader term, like “GPU” or “memory.”</p><a href="/search">View all auctions</a></div>;
  return <div className="product-grid search-results">{auctions.map((item) => <ProductCard key={item.id} item={item} />)}</div>;
}

function HomePage() {
  const auctions = useAuctions('', 6, true);
  return <><section className="hero container"><div><p className="eyebrow">Compute deserves a second life</p><h1>Serious hardware.<br />Less serious prices.</h1><p>Bid on tested server equipment from data centers and operators across the country.</p><a className="hero-action" href="/search">Browse all auctions <span>→</span></a></div><div className="hero-rack" aria-hidden="true"><span className="rack-light one" /><span className="rack-light two" /><span className="rack-light three" /><div className="rack-unit"><b>GPU–08</b><i /><i /><i /><i /></div><div className="rack-unit"><b>CORE–96</b><i /><i /><i /><i /></div><div className="rack-unit"><b>MEM–1.5T</b><i /><i /><i /><i /></div></div></section><section className="catalog-section container"><div className="section-heading"><div><p className="eyebrow">Ending soon</p><h2>Equipment worth watching</h2></div><a href="/search">View all auctions <span>→</span></a></div><CatalogState data={auctions.data} error={auctions.error} /></section></>;
}

function SearchPage({ query }: { query: string }) {
  const auctions = useAuctions(query);
  const count = auctions.data?.length;
  return <main className="search-page container"><div className="breadcrumbs"><a href="/">Home</a><span>/</span><span>Search</span></div><div className="search-heading"><div><p className="eyebrow">Catalog</p><h1>{query ? `Results for “${query}”` : 'All auctions'}</h1><p>{count === undefined ? 'Loading live auctions…' : `${count} live ${count === 1 ? 'auction' : 'auctions'}`}</p></div><select aria-label="Sort auctions" defaultValue="ending"><option value="ending">Ending soonest</option><option>Price: low to high</option><option>Most bids</option></select></div><CatalogState data={auctions.data} error={auctions.error} /></main>;
}

type CreateFormValues = {
  title: string;
  description: string;
  category: AuctionCategory;
  condition: string;
  location: string;
  startingPrice: string;
  closesAt: string;
};

type CreateFormErrors = Partial<Record<keyof CreateFormValues | 'identity' | 'form', string>>;

function defaultClosingTime() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function parsePriceCents(value: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [dollars, fraction = ''] = normalized.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 1_000_000_000 ? cents : null;
}

function NewAuctionPage({ identity }: { identity: DemoIdentity | null }) {
  const [values, setValues] = useState<CreateFormValues>({
    title: '',
    description: '',
    category: 'GPUs',
    condition: 'Used · Fully tested',
    location: '',
    startingPrice: '',
    closesAt: defaultClosingTime(),
  });
  const [errors, setErrors] = useState<CreateFormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof CreateFormValues>(field: K, value: CreateFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined, form: undefined }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: CreateFormErrors = {};
    if (!identity) nextErrors.identity = 'Choose a demo user in the header before creating an auction.';
    if (!values.title.trim()) nextErrors.title = 'Enter an auction title.';
    else if (values.title.trim().length > 120) nextErrors.title = 'Keep the title to 120 characters or fewer.';
    if (!values.description.trim()) nextErrors.description = 'Describe the equipment being auctioned.';
    else if (values.description.trim().length > 2000) nextErrors.description = 'Keep the description to 2,000 characters or fewer.';
    if (!values.condition.trim()) nextErrors.condition = 'Enter the equipment condition.';
    if (!values.location.trim()) nextErrors.location = 'Enter the equipment location.';
    const startingPriceCents = parsePriceCents(values.startingPrice);
    if (startingPriceCents === null) nextErrors.startingPrice = 'Enter a price from $0.01 to $10,000,000 with at most two decimals.';
    const closingTime = new Date(values.closesAt);
    if (!values.closesAt || Number.isNaN(closingTime.getTime()) || closingTime.getTime() <= Date.now()) {
      nextErrors.closesAt = 'Choose a closing time in the future.';
    }
    if (Object.keys(nextErrors).length || !identity || startingPriceCents === null) {
      setErrors(nextErrors);
      return;
    }

    setSubmitting(true);
    setErrors({});
    try {
      const auction = await createAuction({
        title: values.title.trim(),
        description: values.description.trim(),
        category: values.category,
        condition: values.condition.trim(),
        location: values.location.trim(),
        startingPriceCents,
        closesAt: closingTime.toISOString(),
        seller: identity,
      });
      window.location.assign(`/auctions/${auction.id}`);
    } catch (error) {
      setErrors({ form: error instanceof Error ? error.message : 'Auction House could not create this auction.' });
      setSubmitting(false);
    }
  }

  return <main className="new-auction-page container"><div className="breadcrumbs"><a href="/">Home</a><span>/</span><span>Sell equipment</span></div><div className="create-heading"><p className="eyebrow">New auction</p><h1>Give great hardware a second life.</h1><p>Create the listing now. Bidding begins as soon as it is published.</p></div><div className="create-layout"><form className="create-form" onSubmit={submit} noValidate><div className="form-field form-field-wide"><label htmlFor="auction-title">Title</label><input id="auction-title" value={values.title} onChange={(event) => update('title', event.target.value)} aria-invalid={Boolean(errors.title)} placeholder="NVIDIA A100 PCIe 80GB" maxLength={121} />{errors.title && <small className="field-error">{errors.title}</small>}</div><div className="form-field form-field-wide"><label htmlFor="auction-description">Description</label><textarea id="auction-description" value={values.description} onChange={(event) => update('description', event.target.value)} aria-invalid={Boolean(errors.description)} placeholder="Share testing history, included accessories, and anything a bidder should know." rows={6} maxLength={2001} />{errors.description && <small className="field-error">{errors.description}</small>}</div><div className="form-field"><label htmlFor="auction-category">Category</label><select id="auction-category" value={values.category} onChange={(event) => update('category', event.target.value as AuctionCategory)}>{auctionCategories.map((category) => <option key={category}>{category}</option>)}</select></div><div className="form-field"><label htmlFor="auction-condition">Condition</label><input id="auction-condition" value={values.condition} onChange={(event) => update('condition', event.target.value)} aria-invalid={Boolean(errors.condition)} maxLength={120} />{errors.condition && <small className="field-error">{errors.condition}</small>}</div><div className="form-field"><label htmlFor="auction-location">Location</label><input id="auction-location" value={values.location} onChange={(event) => update('location', event.target.value)} aria-invalid={Boolean(errors.location)} placeholder="Portland, OR" maxLength={120} />{errors.location && <small className="field-error">{errors.location}</small>}</div><div className="form-field"><label htmlFor="starting-price">Starting price (USD)</label><input id="starting-price" value={values.startingPrice} onChange={(event) => update('startingPrice', event.target.value)} aria-invalid={Boolean(errors.startingPrice)} inputMode="decimal" placeholder="1250.00" />{errors.startingPrice && <small className="field-error">{errors.startingPrice}</small>}</div><div className="form-field form-field-wide"><label htmlFor="closing-time">Closing time</label><input id="closing-time" type="datetime-local" value={values.closesAt} onChange={(event) => update('closesAt', event.target.value)} aria-invalid={Boolean(errors.closesAt)} />{errors.closesAt && <small className="field-error">{errors.closesAt}</small>}</div>{errors.identity && <p className="form-error form-field-wide" role="alert">{errors.identity}</p>}{errors.form && <p className="form-error form-field-wide" role="alert">{errors.form}</p>}<div className="form-actions form-field-wide"><a href="/">Cancel</a><button disabled={submitting}>{submitting ? 'Creating auction…' : 'Create auction'}</button></div></form><aside className="identity-panel"><span className="avatar">{identity?.charAt(0).toUpperCase() ?? '?'}</span><div><small>Creating as</small><strong>{identity ?? 'Not signed in'}</strong><p>{identity ? 'This demo identity will be recorded as the seller.' : `Choose ${demoIdentities.join(', ')} in the header.`}</p></div></aside></div></main>;
}

function formatBidInput(cents: number) {
  return (cents / 100).toFixed(2);
}

function BidForm({ item, identity, onResolved, onEnded }: { item: AuctionItem; identity: DemoIdentity | null; onResolved: (auction: AuctionItem) => void; onEnded: (auction: AuctionItem, rejectedAmount: string) => void }) {
  const minimumBidCents = item.currentPriceCents + 100;
  const [amount, setAmount] = useState(() => formatBidInput(minimumBidCents));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setAmount((current) => current === '' ? formatBidInput(minimumBidCents) : current);
  }, [minimumBidCents]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!identity) {
      setError('Choose a demo user in the header before bidding.');
      return;
    }
    const amountCents = parsePriceCents(amount);
    if (amountCents === null) {
      setError('Enter a valid bid with at most two decimal places.');
      return;
    }
    if (amountCents < minimumBidCents) {
      setError(`Enter at least ${formatCurrency(minimumBidCents)} to continue.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const auction = await placeBid(item.id, identity, amountCents);
      setAmount('');
      onResolved(auction);
    } catch (bidError) {
      if (bidError instanceof BidRuleError) {
        if (bidError.code === 'AUCTION_ENDED') {
          onEnded(bidError.auction, amount);
          return;
        }
        onResolved(bidError.auction);
        setError(bidError.message);
      } else {
        setError(bidError instanceof Error ? bidError.message : 'Auction House could not place this bid.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return <form className="bid-form" onSubmit={submit} noValidate><label htmlFor="bid">Your bid {identity && <small>as {identity}</small>}</label><p className="bid-minimum">Minimum bid: <strong>{formatCurrency(minimumBidCents)}</strong></p><div className={error ? 'bid-input-error' : ''}><span>$</span><input id="bid" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value); setError(null); }} aria-invalid={Boolean(error)} /><button disabled={submitting}>{submitting ? 'Placing bid…' : 'Place bid'}</button></div>{error && <p className="bid-error" role="alert">{error}</p>}</form>;
}

function BidUnavailable({ reason, rejectedAmount }: { reason: 'ended' | 'seller'; rejectedAmount: string | null }) {
  if (reason === 'seller') {
    return <div className="bid-unavailable"><strong>You’re selling this Auction</strong><p>Sellers cannot bid on their own Auctions.</p></div>;
  }
  return <div className="bid-unavailable" role="status"><strong>Auction ended</strong><p>This Auction is no longer accepting Bids.</p>{rejectedAmount && <small>Your unaccepted bid was ${rejectedAmount}.</small>}</div>;
}

function formatBidTime(placedAt: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(placedAt));
}

function ItemPage({ id, identity }: { id: number | null; identity: DemoIdentity | null }) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [closingTimerToken, setClosingTimerToken] = useState(0);
  const [locallyEnded, setLocallyEnded] = useState(false);
  const [rejectedAmount, setRejectedAmount] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting');
  const [realtimeInstanceId, setRealtimeInstanceId] = useState<string | null>(null);
  const { data: item, error, replaceData } = useAuction(id, refreshToken);
  useEffect(() => {
    if (id === null) {
      setRealtimeStatus('unavailable');
      return;
    }
    setRealtimeStatus('connecting');
    return subscribeToAuction(id, replaceData, setRealtimeStatus, setRealtimeInstanceId);
  }, [id]);
  useEffect(() => {
    if (!item) return;
    if (item.status === 'Ended') {
      setLocallyEnded(true);
      return;
    }

    setLocallyEnded(false);
    const remaining = new Date(item.closesAt).getTime() - Date.now();
    if (remaining <= 0) {
      setLocallyEnded(true);
      setRefreshToken((current) => current + 1);
      return;
    }

    const timer = window.setTimeout(() => {
      if (new Date(item.closesAt).getTime() <= Date.now()) {
        setLocallyEnded(true);
        setRefreshToken((current) => current + 1);
      } else {
        setClosingTimerToken((current) => current + 1);
      }
    }, Math.min(remaining, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [item?.id, item?.closesAt, item?.status, closingTimerToken]);
  useEffect(() => {
    setRejectedAmount(null);
    setLocallyEnded(false);
  }, [id]);
  useEffect(() => { document.title = `${item?.title ?? 'Auction'} · Auction House`; }, [item]);
  if (error) return <main className="container empty-state"><h1>Auction not found</h1><p>{error}</p><a href="/">Back to Auction House</a></main>;
  if (!item) return <main className="container empty-state"><h1>Loading auction…</h1><p>Fetching the latest price from Auction House.</p></main>;
  return <main className="item-page container">
    <div className="breadcrumbs"><a href="/">Home</a><span>/</span><a href={`/search?q=${encodeURIComponent(item.category)}`}>{item.category}</a><span>/</span><span>{item.title}</span></div>
    <div className="item-layout">
      <div className="item-gallery"><ProductArt kind={item.art} label={`Illustration of ${item.title}`} /><div className="thumbnail-row"><button className="selected"><ProductArt kind={item.art} label="Main view" /></button><button><span>+</span><small>More photos soon</small></button></div></div>
      <section className="item-summary"><p className="product-category">{item.category} · {item.condition}</p><h1>{item.title}</h1><p className="item-kicker">{item.kicker}</p><div className="auction-panel"><div className="current-price"><span>Current bid</span><div className={`realtime-status ${realtimeStatus}`} role="status" data-realtime-instance={realtimeInstanceId ?? undefined}><i />{realtimeStatus === 'live' ? 'Live' : realtimeStatus === 'connecting' ? 'Connecting…' : realtimeStatus === 'reconnecting' ? 'Reconnecting…' : 'Unavailable'}</div><strong>{formatCurrency(item.currentPriceCents)}</strong><small>{item.bidCount} {item.bidCount === 1 ? 'bid' : 'bids'}</small></div><div className="bidder"><span>Current bidder</span><strong>{item.currentBidder ?? 'No bids yet'}</strong></div><div className="ending"><span>{item.status === 'Open' && !locallyEnded ? 'Time left' : 'Auction status'}</span><strong>{locallyEnded ? 'Ended' : formatTimeLeft(item.closesAt)}</strong></div>{item.status === 'Ended' || locallyEnded ? <BidUnavailable reason="ended" rejectedAmount={rejectedAmount} /> : identity === item.seller ? <BidUnavailable reason="seller" rejectedAmount={null} /> : <BidForm item={item} identity={identity} onResolved={replaceData} onEnded={(auction, amount) => { setRejectedAmount(amount); setLocallyEnded(true); replaceData(auction); }} />}</div><div className="seller-card"><span className="seller-avatar">{item.seller.charAt(0)}</span><div><small>Sold by</small><strong>{item.seller}</strong><span>{item.sellerRating} · {item.location}</span></div></div></section>
    </div>
    <div className="item-details-grid"><section><p className="eyebrow">About this item</p><h2>The details</h2><p>{item.description}</p></section><section className="spec-list"><p className="eyebrow">Specifications</p>{item.specs.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section></div>
    <section className="bid-history"><div><p className="eyebrow">Public activity</p><h2>Bid history</h2><span>{item.bids?.length ?? 0} {(item.bids?.length ?? 0) === 1 ? 'bid' : 'bids'}</span></div>{item.bids?.length ? <ol>{item.bids.map((bid) => <li key={bid.id}><span className="history-avatar">{bid.bidder.charAt(0).toUpperCase()}</span><div><strong>{bid.bidder}</strong><small>{formatBidTime(bid.placedAt)}</small></div><b>{formatCurrency(bid.amountCents)}</b></li>)}</ol> : <div className="no-bids"><strong>No bids yet</strong><p>Be the first demo bidder to make an offer.</p></div>}</section>
  </main>;
}

export function App() {
  const path = window.location.pathname; const params = new URLSearchParams(window.location.search); const query = params.get('q') ?? '';
  const [identity, setIdentity] = useState<DemoIdentity | null>(() => {
    const stored = window.localStorage.getItem('auction-house-demo-identity');
    return demoIdentities.find((candidate) => candidate === stored) ?? null;
  });
  const [notifications, setNotifications] = useState<AuctionNotification[]>([]);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const readNotificationIds = useRef(new Set<number>());
  const activeNotification = notifications[0] ?? null;
  const mergeNotifications = (incoming: AuctionNotification[]) => {
    setNotifications((current) => {
      const byId = new Map(current.map((notification) => [notification.id, notification]));
      for (const notification of incoming) {
        if (!readNotificationIds.current.has(notification.id)) byId.set(notification.id, notification);
      }
      return [...byId.values()].sort((left, right) => (
        new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id - right.id
      ));
    });
  };
  useEffect(() => {
    if (identity) window.localStorage.setItem('auction-house-demo-identity', identity);
  }, [identity]);
  useEffect(() => {
    setNotifications([]);
    setNotificationError(null);
    readNotificationIds.current.clear();
    if (!identity) return;
    return subscribeToNotifications(
      identity,
      (notification) => mergeNotifications([notification]),
      mergeNotifications,
      (notificationId) => {
        readNotificationIds.current.add(notificationId);
        setNotifications((current) => current.filter((notification) => notification.id !== notificationId));
      },
    );
  }, [identity]);
  async function dismissNotification(notification: AuctionNotification) {
    if (!identity) return;
    setNotificationError(null);
    readNotificationIds.current.add(notification.id);
    setNotifications((current) => current.filter((candidate) => candidate.id !== notification.id));
    try {
      await markNotificationRead(notification.id, identity);
    } catch (error) {
      readNotificationIds.current.delete(notification.id);
      mergeNotifications([notification]);
      setNotificationError(error instanceof Error ? error.message : 'Auction House could not dismiss this notification.');
    }
  }
  useEffect(() => {
    if (path === '/auctions/new') document.title = 'Sell equipment · Auction House';
    else if (!path.startsWith('/auctions/')) document.title = 'Auction House';
  }, [path]);
  let page = <HomePage />;
  if (path === '/search') page = <SearchPage query={query} />;
  if (path === '/auctions/new') page = <NewAuctionPage identity={identity} />;
  else if (path.startsWith('/auctions/')) {
    const rawId = path.slice('/auctions/'.length);
    const id = /^\d+$/.test(rawId) ? Number(rawId) : null;
    page = <ItemPage id={id} identity={identity} />;
  }
  return <div className="app-shell"><SiteHeader initialQuery={query} identity={identity} onIdentityChange={setIdentity} />{page}{activeNotification && <aside className="auction-notification" role="dialog" aria-live="assertive" aria-labelledby="auction-notification-title"><button className="notification-close" aria-label="Dismiss notification" onClick={() => void dismissNotification(activeNotification)}>×</button><p className="eyebrow">Auction ended</p><h2 id="auction-notification-title">{activeNotification.kind === 'winner' ? 'You won the Auction!' : 'Your Auction sold!'}</h2><p><strong>{activeNotification.auctionTitle}</strong></p><p>{activeNotification.kind === 'winner' ? `Your winning Bid was ${formatCurrency(activeNotification.finalPriceCents)}.` : `${activeNotification.winner} won with ${formatCurrency(activeNotification.finalPriceCents)}.`}</p>{notificationError && <p className="notification-error" role="alert">{notificationError}</p>}<a href={`/auctions/${activeNotification.auctionId}`}>View Auction <span>→</span></a></aside>}<footer><div className="container"><span>Auction House</span></div></footer></div>;
}
