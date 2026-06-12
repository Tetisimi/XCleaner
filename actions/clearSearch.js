import { logger } from '../utils/logger.js';
import { randomDelay, delay, SafetyTracker } from '../utils/delay.js';

/**
 * Clears X search history.
 * @param {import('playwright').Page} page
 * @param {SafetyTracker} safetyTracker
 */
export async function clearSearchHistory(page, safetyTracker) {
  logger.header('Starting Clear Search History Automation');
  const targetUrl = 'https://x.com/search';
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  try {
    // 1. Click search bar to reveal history dropdown
    const searchInput = page.locator('input[data-testid="SearchBox_Search_Input"], input[aria-label="Search query"]').first();
    if (!(await searchInput.isVisible())) {
      throw new Error('Search input box not visible.');
    }
    
    logger.info('Focusing search box...');
    await searchInput.click();
    await delay(1500); // Wait for history dropdown to open

    // 2. Find and click "Clear all" button
    const clearAllBtn = page.locator('[data-testid="clear_all"]').first();
    const clearAllBtnFallback = page.getByRole('button', { name: /clear all/i }).first();
    const clearAllTextFallback = page.locator('span:has-text("Clear all"), div:has-text("Clear all")').first();

    let clicked = false;
    if (await clearAllBtn.isVisible()) {
      await clearAllBtn.click();
      clicked = true;
    } else if (await clearAllBtnFallback.isVisible()) {
      await clearAllBtnFallback.click();
      clicked = true;
    } else if (await clearAllTextFallback.isVisible()) {
      await clearAllTextFallback.click();
      clicked = true;
    }

    if (!clicked) {
      // Check if search history is already empty
      const emptyIndicator = page.locator('text="Try searching for", text="No recent searches"').first();
      if (await emptyIndicator.isVisible()) {
        logger.success('✓ Search history is already empty!');
        return;
      }
      throw new Error('Could not locate "Clear all" button. The search history might be empty or the UI changed.');
    }

    await delay(1000); // Wait for confirmation sheet

    // 3. Confirm deletion if a confirmation modal appears
    // The confirm button in the sheet has testid="confirmationSheetConfirm" or name /clear/i
    const confirmBtn = page.locator('[data-testid="confirmationSheetConfirm"]').first();
    const confirmBtnFallback = page.getByRole('button', { name: /clear/i }).first();
    const clearBtnText = page.locator('span:has-text("Clear")').first();

    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
      logger.success('✓ Search history cleared (via sheet confirm).');
    } else if (await confirmBtnFallback.isVisible()) {
      await confirmBtnFallback.click();
      logger.success('✓ Search history cleared (via button confirm).');
    } else if (await clearBtnText.isVisible()) {
      await clearBtnText.click();
      logger.success('✓ Search history cleared (via text confirm).');
    } else {
      logger.success('✓ Search history cleared (no confirmation sheet appeared or it auto-cleared).');
    }

    await randomDelay(800, 1200);
    await safetyTracker.registerAction(logger);

  } catch (err) {
    logger.error('Failed to clear search history', err.message || err);
  }
}
