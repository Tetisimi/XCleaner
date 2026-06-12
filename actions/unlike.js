import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';

/**
 * Bulk-unlikes all tweets with real-time rate limit detection and periodic page reloads.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 */
export async function unlikeTweets(page, username, safetyTracker) {
  logger.header('Starting Unlike Automation (Safe Mode)');
  const targetUrl = `https://x.com/${username}/likes`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let unlikedCount = 0;
  let noNewLikesScrolls = 0;
  const maxScrollAttempts = 3;
  
  // Track processed tweet IDs to avoid repeating them
  const processedTweets = new Set();

  // Flag to check if X is blocking our network requests
  let isApiBlocked = false;
  let blockCount = 0;

  // Listen to background API responses to detect silent failures (403 Forbidden / 429 Rate Limit)
  const responseHandler = async (response) => {
    try {
      const url = response.url();
      if (url.includes('/UnfavoriteTweet') || url.includes('/graphql/')) {
        const status = response.status();
        if (status === 403 || status === 429) {
          logger.error(`X API block detected: HTTP status ${status}`);
          isApiBlocked = true;
        }
      }
    } catch (err) {
      // Ignore response read errors
    }
  };
  
  page.on('response', responseHandler);

  try {
    while (true) {
      if (isApiBlocked) {
        blockCount++;
        if (blockCount >= 3) {
          logger.error('X is persistently blocking our unliking requests. Stopping run to prevent account restriction.');
          break;
        }
        logger.warn('Cooling down: X API returned a block. Pausing for 90 seconds to stay safe...');
        isApiBlocked = false; // Reset flag for retry
        await delay(90000);
        logger.info('Reloading likes page to refresh state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        continue;
      }

      // Check if we need to do a periodic reload (every 15 unlikes)
      // This clears optimistic UI states and forces browser to sync with the server
      if (unlikedCount > 0 && unlikedCount % 15 === 0) {
        logger.info('Performing periodic reload to clear optimistic cache and verify state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        // Double check if API got blocked during reload
        if (isApiBlocked) continue;
      }

      // Look for liked tweets
      const unlikeButtons = await page.locator('[data-testid="unlike"], button[aria-label*="Unlike"], button[aria-label*="unlike"]').all();

      if (unlikeButtons.length === 0) {
        logger.info('No visible liked tweets found. Scrolling to load more...');
        
        const lastHeight = await page.evaluate('document.body.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await delay(3000); // Wait for likes to load
        
        const newHeight = await page.evaluate('document.body.scrollHeight');
        
        if (newHeight === lastHeight) {
          noNewLikesScrolls++;
          logger.warn(`No height change. Scroll attempt ${noNewLikesScrolls}/${maxScrollAttempts}`);
        } else {
          noNewLikesScrolls = 0;
        }

        if (noNewLikesScrolls >= maxScrollAttempts) {
          logger.success('No more liked tweets loaded after multiple scrolls. Stopping.');
          break;
        }
        continue;
      }

      noNewLikesScrolls = 0;
      let clickedAnyThisPass = false;

      for (const btn of unlikeButtons) {
        try {
          if (isApiBlocked) break; // Stop looping if we just got blocked

          // Associate button with parent tweet
          const tweetElement = page.locator('article[data-testid="tweet"]').filter({ has: btn }).first();
          let tweetId = 'unknown';
          let logSnippet = 'unknown';

          if (await tweetElement.isVisible()) {
            // Find status link (e.g. /username/status/123456789) to extract a truly unique ID
            const statusLink = tweetElement.locator('a[href*="/status/"]').first();
            if (await statusLink.isVisible()) {
              const href = await statusLink.getAttribute('href').catch(() => '');
              if (href) {
                tweetId = href.split('/status/')[1]?.split('?')[0] || href;
              }
            }
            
            // Text snippet for logging purposes
            const textElement = tweetElement.locator('[data-testid="tweetText"]').first();
            if (await textElement.isVisible()) {
              const text = await textElement.innerText().catch(() => '');
              logSnippet = text.substring(0, 30).replace(/\s+/g, ' ').trim();
            } else {
              logSnippet = 'image/video/media';
            }
          }

          if (processedTweets.has(tweetId) && tweetId !== 'unknown') {
            continue;
          }

          if (!(await btn.isVisible()) || !(await btn.isEnabled())) {
            continue;
          }

          // Scroll to the button to trigger actual viewability triggers in X client
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await randomDelay(300, 600);

          // Click the unlike button
          await btn.click();
          unlikedCount++;
          clickedAnyThisPass = true;
          
          if (tweetId !== 'unknown') {
            processedTweets.add(tweetId);
          }

          logger.success(`Clicked Unlike on tweet ${unlikedCount}: "${logSnippet}..."`);
          logger.stats('Unlike', unlikedCount);

          // Slower delays (1.5s - 3s) between actions to remain undetected by spam filters
          await randomDelay(1500, 3000);

          await safetyTracker.registerAction(logger);

        } catch (err) {
          logger.warn(`Failed to unlike a specific tweet: ${err.message || err}`);
          await randomDelay(1000, 2000);
        }
      }

      if (!clickedAnyThisPass && !isApiBlocked) {
        logger.info('Scrolling down to find new tweets...');
        await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
        await delay(2500);
      }
    }
  } finally {
    // Make sure we remove the event listener when finished
    page.off('response', responseHandler);
  }

  logger.success(`Unlike run completed. Total unliked click attempts: ${unlikedCount}`);
}
