import { expect, test } from '@playwright/test';

test('Seller and Closing Time replace bidding controls with authoritative states', async ({ page }) => {
  await page.goto('/auctions/new');
  await page.getByLabel('Demo user').selectOption('rack_runner');

  const closesAt = Date.now() + 7_000;
  const localClosingTime = await page.evaluate((epochMs) => {
    const date = new Date(epochMs);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 19);
  }, closesAt);

  await page.getByLabel('Title').fill(`Eligibility Rules ${Date.now()}`);
  await page.getByLabel('Description').fill('A short Auction that demonstrates Seller and Closing Time bidding rules.');
  await page.getByLabel('Condition').fill('Rule tested');
  await page.getByLabel('Location').fill('Eligibility Lab');
  await page.getByLabel('Starting price (USD)').fill('100.00');
  await page.getByLabel('Closing time').fill(localClosingTime);
  await Promise.all([
    page.waitForURL(/\/auctions\/\d+$/),
    page.getByRole('button', { name: 'Create auction' }).click(),
  ]);

  await expect(page.getByText('You’re selling this Auction')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place bid' })).toHaveCount(0);

  await page.getByLabel('Demo user').selectOption('byte_bidder');
  await expect(page.getByText('Minimum bid:')).toContainText('$101');
  await expect(page.getByRole('button', { name: 'Place bid' })).toBeVisible();

  await expect(page.getByText('Auction ended', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('This Auction is no longer accepting Bids.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Place bid' })).toHaveCount(0);
  await expect(page.locator('.ending')).toContainText('Ended');
});
