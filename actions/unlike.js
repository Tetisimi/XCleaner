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
 * Bulk-unlikes all tweets.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 */
export async function unlikeTweets(page, username, safetyTracker) {
  logger.header('Starting Unlike Automation');
  const targetUrl = `https://x.com/${username}/likes`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let unlikedCount = 0;
  let noNewLikesScrolls = 0;
  const maxScrollAttempts = 3;
  
  // Track processed tweet IDs to avoid repeating failed selections
  const processedTweets = new Set();

  while (true) {
    await handleRateLimit(page);

    // Look for elements with data-testid="unlike" or button[aria-label*="Unlike"] / button[aria-label*="unliked"]
    // Twitter likes buttons usually have data-testid="unlike" (when liked) or aria-label containing "Unlike"
    const unlikeButtons = await page.locator('[data-testid="unlike"], button[aria-label*="Unlike"], button[aria-label*="unlike"]').all();

    if (unlikeButtons.length === 0) {
      logger.info('No visible liked tweets found. Scrolling to load more...');
      
      // Get height before scroll
      const lastHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await delay(2000);
      
      // Get height after scroll
      const newHeight = await page.evaluate('document.body.scrollHeight');
      
      if (newHeight === lastHeight) {
        noNewLikesScrolls++;
        logger.warn(`No height change. Scroll attempt ${noNewLikesScrolls}/${maxScrollAttempts}`);
      } else {
        noNewLikesScrolls = 0; // Reset scroll counter on content growth
      }

      if (noNewLikesScrolls >= maxScrollAttempts) {
        logger.success('No more liked tweets loaded after multiple scrolls. Stopping.');
        break;
      }
      continue;
    }

    // Reset scroll counter since we found elements
    noNewLikesScrolls = 0;
    let clickedAnyThisPass = false;

    for (const btn of unlikeButtons) {
      try {
        // Find a unique ancestor like article[data-testid="tweet"] to associate with the button
        const tweetElement = page.locator('article[data-testid="tweet"]').filter({ has: btn }).first();
        let tweetId = 'unknown';
        if (await tweetElement.isVisible()) {
          // Attempt to locate a unique identifier (like the time link or text)
          const text = await tweetElement.innerText().catch(() => '');
          tweetId = text.substring(0, 50).replace(/\s+/g, ' ');
        }

        if (processedTweets.has(tweetId) && tweetId !== 'unknown') {
          continue; // Already processed this tweet in this run
        }

        // Ensure button is still visible and enabled
        if (!(await btn.isVisible()) || !(await btn.isEnabled())) {
          continue;
        }

        // Scroll to the button to make sure it's in view
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await randomDelay(200, 500);

        // Click the unlike button
        await btn.click();
        unlikedCount++;
        clickedAnyThisPass = true;
        
        if (tweetId !== 'unknown') {
          processedTweets.add(tweetId);
        }

        logger.success(`Unliked tweet ${unlikedCount}: "${tweetId.substring(0, 30)}..."`);
        logger.stats('Unlike', unlikedCount);

        // Handle possible confirmation popup or delay
        // Sometimes Twitter pops up a notification at the bottom ("Your like has been removed")
        // No dialog confirmation is usually required for Unlike, but wait for security
        await randomDelay(800, 1200);

        await safetyTracker.registerAction(logger);

      } catch (err) {
        logger.warn('Failed to unlike a specific tweet. Skipping to next...', err.message || err);
        await randomDelay(500, 1000);
      }
    }

    if (!clickedAnyThisPass) {
      // If none of the found buttons were clickable or processed, scroll to get new ones
      logger.info('Scrolling to load fresh liked tweets...');
      await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
      await delay(2000);
    }
  }

  logger.success(`Unlike run completed. Total unliked: ${unlikedCount}`);
}
