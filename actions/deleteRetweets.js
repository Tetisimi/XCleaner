import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';

/**
 * Bulk-deletes/undo-reposts all retweets with rate limit checks and periodic page reloads.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 */
export async function deleteRetweets(page, username, safetyTracker) {
  logger.header('Starting Undo Reposts Automation (Safe Mode)');
  const targetUrl = `https://x.com/${username}`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let undoneCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 3;

  let isApiBlocked = false;
  let blockCount = 0;

  // Track processed tweet IDs to avoid repeating failed selections and getting stuck in loops
  const processedTweets = new Set();

  // Listen to background API responses to detect failures (HTTP-level and GraphQL payload errors)
  const responseHandler = async (response) => {
    try {
      const url = response.url();
      if (url.includes('/graphql/') || url.includes('/Unrepost') || url.includes('/unrepost') || url.includes('/UnfavoriteTweet')) {
        const status = response.status();
        
        // HTTP level block
        if (status === 403 || status === 429) {
          logger.error(`X API block detected on undoing repost: HTTP status ${status}`);
          isApiBlocked = true;
          return;
        }

        // GraphQL level silent block
        const contentType = response.headers()['content-type'] || '';
        if (status === 200 && contentType.includes('application/json')) {
          const json = await response.json().catch(() => null);
          if (json && json.errors && json.errors.length > 0) {
            const errorMsg = json.errors[0]?.message || 'Unknown error';
            const errorCode = json.errors[0]?.code || 'No code';
            logger.warn(`X Server rejected undo-repost: "${errorMsg}" (Code ${errorCode})`);
            isApiBlocked = true;
          }
        }
      }
    } catch (err) {
      // Ignore
    }
  };

  page.on('response', responseHandler);

  try {
    while (true) {
      if (isApiBlocked) {
        blockCount++;
        if (blockCount >= 3) {
          logger.error('X is persistently blocking our undo-repost requests. Stopping run to prevent account restriction.');
          break;
        }
        logger.warn('Cooling down: X API returned a block. Pausing for 90 seconds...');
        isApiBlocked = false;
        await delay(90000);
        logger.info('Reloading profile page to refresh state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        continue;
      }

      // Reload page every 15 undo reposts to refresh UI state
      if (undoneCount > 0 && undoneCount % 15 === 0) {
        logger.info('Performing periodic reload to clear optimistic cache and verify state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        if (isApiBlocked) continue;
      }

      const tweets = await page.locator('article[data-testid="tweet"]').all();

      if (tweets.length === 0) {
        logger.info('No visible tweets found. Scrolling to search for more...');
        
        const lastHeight = await page.evaluate('document.body.scrollHeight');
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await delay(3000);
        
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
      let undoneAnyThisPass = false;

      for (const tweet of tweets) {
        try {
          if (isApiBlocked) break;

          // Must identify as retweet
          const socialContext = tweet.locator('[data-testid="socialContext"]');
          let isRetweet = false;
          
          if (await socialContext.isVisible()) {
            const contextText = await socialContext.innerText().catch(() => '');
            if (contextText.toLowerCase().includes('reposted') || contextText.toLowerCase().includes('you reposted')) {
              isRetweet = true;
            }
          }

          if (!isRetweet) {
            continue;
          }

          // Extract unique tweetId from status link
          let tweetId = 'unknown';
          const statusLink = tweet.locator('a[href*="/status/"]').first();
          if (await statusLink.isVisible()) {
            const href = await statusLink.getAttribute('href').catch(() => '');
            if (href) {
              tweetId = href.split('/status/')[1]?.split('?')[0] || href;
            }
          }

          if (processedTweets.has(tweetId) && tweetId !== 'unknown') {
            continue;
          }

          const tweetTextElement = tweet.locator('[data-testid="tweetText"]').first();
          let snippet = 'empty/image/media';
          if (await tweetTextElement.isVisible()) {
            const rawText = await tweetTextElement.innerText().catch(() => '');
            snippet = rawText.replace(/\n/g, ' ').substring(0, 30).trim();
          }

          let methodSuccess = false;

          // Try Method 1: Caret menu ("...") -> "Undo repost"
          const caretMenu = tweet.locator('[data-testid="caret"], button[aria-label="More"], button[aria-label*="more"]').first();
          if (await caretMenu.isVisible()) {
            await caretMenu.scrollIntoViewIfNeeded().catch(() => {});
            await randomDelay(200, 400);

            // Hover caret first
            await caretMenu.hover().catch(() => {});
            await randomDelay(300, 600);
            await caretMenu.click();

            const undoRepostItem = page.getByRole('menuitem', { name: /undo repost/i });
            await undoRepostItem.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});

            if (await undoRepostItem.isVisible()) {
              await undoRepostItem.hover().catch(() => {});
              await randomDelay(200, 400);
              await undoRepostItem.click();
              methodSuccess = true;
              undoneCount++;
              undoneAnyThisPass = true;
              if (tweetId !== 'unknown') processedTweets.add(tweetId);
              logger.success(`Sent Undo Repost (via menu) ${undoneCount}: "${snippet}..."`);
              logger.stats('Undo Repost', undoneCount);
              await randomDelay(1500, 3000);
              await safetyTracker.registerAction(logger);
            } else {
              await page.keyboard.press('Escape');
              await delay(300);
              if (tweetId !== 'unknown') processedTweets.add(tweetId); // Mark as checked to prevent infinite loop
            }
          }

          // Try Method 2 (Fallback): Click green retweet button directly
          if (!methodSuccess && !processedTweets.has(tweetId)) {
            const unretweetButton = tweet.locator('[data-testid="unretweet"], button[aria-label*="Reposted"], button[aria-label*="repost"][aria-label*="active"]').first();
            if (await unretweetButton.isVisible()) {
              await unretweetButton.scrollIntoViewIfNeeded().catch(() => {});
              await randomDelay(200, 400);

              // Hover green unretweet button
              await unretweetButton.hover().catch(() => {});
              await randomDelay(300, 600);
              await unretweetButton.click();

              const undoRepostConfirm = page.locator('[data-testid="unretweetConfirm"]').first();
              const undoRepostConfirmFallback = page.getByRole('menuitem', { name: /undo repost/i }).first();
              
              await Promise.race([
                undoRepostConfirm.waitFor({ state: 'visible', timeout: 2000 }),
                undoRepostConfirmFallback.waitFor({ state: 'visible', timeout: 2000 })
              ]).catch(() => {});

              let clickedConfirm = false;
              if (await undoRepostConfirm.isVisible()) {
                await undoRepostConfirm.hover().catch(() => {});
                await randomDelay(200, 400);
                await undoRepostConfirm.click();
                clickedConfirm = true;
              } else if (await undoRepostConfirmFallback.isVisible()) {
                await undoRepostConfirmFallback.hover().catch(() => {});
                await randomDelay(200, 400);
                await undoRepostConfirmFallback.click();
                clickedConfirm = true;
              }

              if (clickedConfirm) {
                methodSuccess = true;
                undoneCount++;
                undoneAnyThisPass = true;
                if (tweetId !== 'unknown') processedTweets.add(tweetId);
                logger.success(`Sent Undo Repost (via button) ${undoneCount}: "${snippet}..."`);
                logger.stats('Undo Repost', undoneCount);
                await randomDelay(1500, 3000);
                await safetyTracker.registerAction(logger);
              } else {
                await page.keyboard.press('Escape');
                await delay(300);
                if (tweetId !== 'unknown') processedTweets.add(tweetId);
              }
            }
          }

          if (methodSuccess) {
            break; // Break to reload and find shifts in list layout
          }

        } catch (err) {
          logger.warn(`Failed to undo a specific repost: ${err.message || err}`);
          await page.keyboard.press('Escape').catch(() => {});
          await randomDelay(1000, 2000);
        }
      }

      if (!undoneAnyThisPass && !isApiBlocked) {
        logger.info('Scrolling down to load more retweets...');
        await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
        await delay(2500);
      }
    }
  } finally {
    page.off('response', responseHandler);
  }

  logger.success(`Undo reposts run completed. Total undo attempts: ${undoneCount}`);
}
