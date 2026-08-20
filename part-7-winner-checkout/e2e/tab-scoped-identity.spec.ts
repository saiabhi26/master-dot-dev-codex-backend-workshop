import { expect, test } from '@playwright/test';

test('demo identities remain independent across tabs and full-page navigation', async ({ browser }) => {
  const context = await browser.newContext();
  const originalTab = await context.newPage();
  const secondTab = await context.newPage();

  try {
    await Promise.all([originalTab.goto('/'), secondTab.goto('/')]);
    await originalTab.getByLabel('Demo user').selectOption('byte_bidder');
    await secondTab.getByLabel('Demo user').selectOption('server_sage');

    await expect(originalTab.getByLabel('Demo user')).toHaveValue('byte_bidder');
    await expect(secondTab.getByLabel('Demo user')).toHaveValue('server_sage');

    await originalTab.getByRole('link', { name: /Browse all auctions/ }).click();
    await expect(originalTab).toHaveURL(/\/search$/);
    await expect(originalTab.getByLabel('Demo user')).toHaveValue('byte_bidder');
    await expect(secondTab.getByLabel('Demo user')).toHaveValue('server_sage');
  } finally {
    await context.close();
  }
});
