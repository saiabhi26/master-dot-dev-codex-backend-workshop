import { type FormEvent, useState } from 'react';

import { type DemoIdentity, demoIdentities } from '../catalog';

type SiteHeaderProps = {
  initialQuery: string;
  identity: DemoIdentity | null;
  onIdentityChange: (identity: DemoIdentity) => void;
};

export function SiteHeader({ initialQuery, identity, onIdentityChange }: SiteHeaderProps) {
  const [query, setQuery] = useState(initialQuery);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    window.location.assign(`/search${params.size ? `?${params.toString()}` : ''}`);
  }

  return <header className="site-header"><div className="container header-main"><a className="brand" href="/" aria-label="Auction House home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Auction House</span></a><form className="search-form" role="search" onSubmit={search}><span className="search-icon" aria-hidden="true">⌕</span><input aria-label="Search auctions" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search GPUs, memory, chassis, CPUs…" /><select aria-label="Search category" defaultValue="all"><option value="all">All equipment</option><option>GPUs</option><option>CPUs</option><option>Memory</option><option>Networking</option></select><button type="submit">Search</button></form><div className="header-actions"><a className="sell-action" href="/auctions/new">Sell equipment</a><label className="demo-user"><span className="avatar">{identity?.charAt(0).toUpperCase() ?? '?'}</span><span className="sr-only">Demo user</span><select aria-label="Demo user" value={identity ?? ''} onChange={(event) => onIdentityChange(event.target.value as DemoIdentity)}><option value="" disabled>Sign in as…</option>{demoIdentities.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label></div></div><nav className="container category-nav" aria-label="Equipment categories">{['Featured', 'GPUs', 'CPUs', 'Memory', 'Chassis', 'Networking', 'Cooling'].map((category) => <a key={category} href={`/search${category === 'Featured' ? '' : `?q=${category}`}`}>{category}</a>)}</nav></header>;
}
