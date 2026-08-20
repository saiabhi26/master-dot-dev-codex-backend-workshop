import { expect, test } from '@playwright/test';

test('Ending soon shows only Open Auctions', async ({ page, request }) => {
  const title = `Home open filter ${Date.now()}`;
  const created = await request.post('/api/auctions', {
    data: {
      title,
      description: 'An Auction proving the home page excludes Ended Auctions.',
      category: 'Cooling',
      condition: 'Filter tested',
      location: 'Catalog Lab',
      startingPriceCents: 10_000,
      closesAt: new Date(Date.now() + 6_000).toISOString(),
      seller: 'rack_runner',
    },
  });
  expect(created.status()).toBe(201);

  await page.goto('/');
  await expect(page.locator('.product-card', { hasText: title })).toBeVisible();

  await page.waitForTimeout(6_500);
  await page.reload();
  await expect(page.locator('.product-card', { hasText: title })).toHaveCount(0);
});
