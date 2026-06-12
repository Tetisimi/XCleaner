import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';

/**
 * Checks if the page is currently rate-limited or blocked.
 * @param {import('playwright').Page} page
 */
async function handleRateLimit(page) {
  const bodyText = await page.innerText('body').catch(() => '');
  if (bodyText.includes('Something went wrong') || bodyText.includes('Rate limit exceeded') || bodyText.includes('Try again later')) {
    logger.warn('Rate limit or connection warning detected. Pausing for 60 seconds...');
    await delay(60000);
    await page.reload().catch(() => {});
    await delay(5000);
    return true;
  }
  return false;
}

/**
 * Bulk-deletes all owned tweets.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 */
export async function deleteTweets(page, username, safetyTracker) {
  logger.header('Starting Delete Tweets Automation');
  const targetUrl = `https://x.com/${username}`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let deletedCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 3;

  while (true) {
    await handleRateLimit(page);

    // Get all tweet articles on the page
    const tweets = await page.locator('article[data-testid="tweet"]').all();

    if (tweets.length === 0) {
      logger.info('No visible tweets found. Scrolling to search for more...');
      
      const lastHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await delay(2000);
      
      const newHeight = await page.evaluate('document.body.scrollHeight');
      
      if (newHeight === lastHeight) {
        scrollAttempts++;
        logger.warn(`No height change. Scroll attempt ${scrollAttempts}/${maxScrollAttempts}`);
      } else {
        scrollAttempts = 0;
      }

      if (scrollAttempts >= maxScrollAttempts) {
        logger.success('No more tweets found on profile page. Stopping.');
        break;
      }
      continue;
    }

    scrollAttempts = 0;
    let deletedAnyThisPass = false;

    for (const tweet of tweets) {
      try {
        // Skip if this tweet is a retweet (it has "You reposted" or "reposted" text in the social context)
        const socialContext = tweet.locator('[data-testid="socialContext"]');
        if (await socialContext.isVisible()) {
          const contextText = await socialContext.innerText().catch(() => '');
          if (contextText.toLowerCase().includes('reposted') || contextText.toLowerCase().includes('you reposted')) {
            // This is a retweet, skip it (will be deleted in the deleteRetweets script)
            continue;
          }
        }

        // Get some text snippet of the tweet for logging
        const tweetTextElement = tweet.locator('[data-testid="tweetText"]').first();
        let snippet = 'empty/image/media';
        if (await tweetTextElement.isVisible()) {
          const rawText = await tweetTextElement.innerText().catch(() => '');
          snippet = rawText.replace(/\n/g, ' ').substring(0, 30).trim();
        }

        // Find caret menu button for this specific tweet
        const caretMenu = tweet.locator('[data-testid="caret"], button[aria-label="More"], button[aria-label*="more"]').first();
        if (!(await caretMenu.isVisible())) {
          continue;
        }

        // Scroll into view
        await caretMenu.scrollIntoViewIfNeeded().catch(() => {});
        await randomDelay(200, 500);

        // Click the caret menu
        await caretMenu.click();
        await delay(500); // Wait for menu popup to appear

        // Click the "Delete" menu item in the dropdown
        // The menu item often has text "Delete" and a red-like or standard display
        const deleteItem = page.getByRole('menuitem', { name: /delete/i });
        if (!(await deleteItem.isVisible())) {
          // If menu opened but delete is not visible (could be someone else's tweet or already deleted), click anywhere to close menu
          await page.keyboard.press('Escape');
          await delay(300);
          continue;
        }
        await deleteItem.click();
        await delay(500); // Wait for confirmation sheet to appear

        // Click the final "Delete" button in the confirmation sheet
        // Confirm button usually has testid="confirmationSheetConfirm" or name /delete/i
        const confirmBtn = page.locator('[data-testid="confirmationSheetConfirm"]').first();
        const confirmBtnFallback = page.getByRole('button', { name: /delete/i }).first();
        
        if (await confirmBtn.isVisible()) {
          await confirmBtn.click();
        } else if (await confirmBtnFallback.isVisible()) {
          await confirmBtnFallback.click();
        } else {
          logger.warn('Could not find Delete confirmation button. Pressing escape...');
          await page.keyboard.press('Escape');
          await delay(500);
          continue;
        }

        deletedCount++;
        deletedAnyThisPass = true;
        logger.success(`Deleted tweet ${deletedCount}: "${snippet}..."`);
        logger.stats('Delete', deletedCount);

        // Wait 600ms minimum as per requirements, let's do random delay for safety
        await randomDelay(600, 900);

        await safetyTracker.registerAction(logger);

        // Break early after a delete to re-evaluate the DOM, because deleting elements shifts the profile timeline
        break;

      } catch (err) {
        logger.warn('Failed to delete a specific tweet. Continuing...', err.message || err);
        // Clean up menu state if open
        await page.keyboard.press('Escape').catch(() => {});
        await randomDelay(500, 1000);
      }
    }

    if (!deletedAnyThisPass) {
      // If we walked through the whole visible tweets list and deleted none (all retweets or skipped), scroll down
      logger.info('Scrolling to load more tweets...');
      await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
      await delay(2000);
    }
  }

  logger.success(`Delete run completed. Total deleted: ${deletedCount}`);
}
