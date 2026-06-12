import { logger } from '../utils/logger.js';
import { randomDelay, SafetyTracker, delay } from '../utils/delay.js';

/**
 * Bulk-deletes all owned tweets with rate limit checks and periodic page reloads.
 * @param {import('playwright').Page} page
 * @param {string} username
 * @param {SafetyTracker} safetyTracker
 */
export async function deleteTweets(page, username, safetyTracker) {
  logger.header('Starting Delete Tweets Automation (Safe Mode)');
  const targetUrl = `https://x.com/${username}`;
  logger.info(`Navigating to: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await delay(4000);

  let deletedCount = 0;
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
      if (url.includes('/graphql/') || url.includes('/DestroyTweet')) {
        const status = response.status();
        
        // HTTP level block
        if (status === 403 || status === 429) {
          logger.error(`X API block detected on deletion: HTTP status ${status}`);
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
            logger.warn(`X Server rejected deletion: "${errorMsg}" (Code ${errorCode})`);
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
          logger.error('X is persistently blocking our deletion requests. Stopping run to prevent account restriction.');
          break;
        }
        logger.warn('Cooling down: X Deletion API returned a block. Pausing for 90 seconds...');
        isApiBlocked = false;
        await delay(90000);
        logger.info('Reloading profile page to refresh state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        continue;
      }

      // Reload every 15 deletions to verify that they are actually deleted and refresh the DOM
      if (deletedCount > 0 && deletedCount % 15 === 0) {
        logger.info('Performing periodic reload to clear optimistic cache and verify state...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await delay(5000);
        if (isApiBlocked) continue;
      }

      // Get all tweet articles on the page
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
      let deletedAnyThisPass = false;

      for (const tweet of tweets) {
        try {
          if (isApiBlocked) break;

          // Skip retweets
          const socialContext = tweet.locator('[data-testid="socialContext"]');
          if (await socialContext.isVisible()) {
            const contextText = await socialContext.innerText().catch(() => '');
            if (contextText.toLowerCase().includes('reposted') || contextText.toLowerCase().includes('you reposted')) {
              continue;
            }
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

          // Get tweet snippet
          const tweetTextElement = tweet.locator('[data-testid="tweetText"]').first();
          let snippet = 'empty/image/media';
          if (await tweetTextElement.isVisible()) {
            const rawText = await tweetTextElement.innerText().catch(() => '');
            snippet = rawText.replace(/\n/g, ' ').substring(0, 30).trim();
          }

          // Caret menu button
          const caretMenu = tweet.locator('[data-testid="caret"], button[aria-label="More"], button[aria-label*="more"]').first();
          if (!(await caretMenu.isVisible())) {
            continue;
          }

          await caretMenu.scrollIntoViewIfNeeded().catch(() => {});
          await randomDelay(200, 400);

          // Human mouse movement trigger: Hover then wait before click
          await caretMenu.hover().catch(() => {});
          await randomDelay(300, 600);
          await caretMenu.click();
          
          // Wait for the delete option to be visible (auto-waits up to 2s)
          const deleteItem = page.getByRole('menuitem', { name: /delete/i });
          await deleteItem.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});

          if (!(await deleteItem.isVisible())) {
            await page.keyboard.press('Escape');
            await delay(300);
            if (tweetId !== 'unknown') processedTweets.add(tweetId); // Mark as checked so we don't lock
            continue;
          }

          // Hover dropdown item then click
          await deleteItem.hover().catch(() => {});
          await randomDelay(200, 400);
          await deleteItem.click();

          // Wait for confirmation buttons
          const confirmBtn = page.locator('[data-testid="confirmationSheetConfirm"]').first();
          const confirmBtnFallback = page.getByRole('button', { name: /delete/i }).first();
          
          await Promise.race([
            confirmBtn.waitFor({ state: 'visible', timeout: 2000 }),
            confirmBtnFallback.waitFor({ state: 'visible', timeout: 2000 })
          ]).catch(() => {});

          let clicked = false;
          if (await confirmBtn.isVisible()) {
            await confirmBtn.hover().catch(() => {});
            await randomDelay(200, 400);
            await confirmBtn.click();
            clicked = true;
          } else if (await confirmBtnFallback.isVisible()) {
            await confirmBtnFallback.hover().catch(() => {});
            await randomDelay(200, 400);
            await confirmBtnFallback.click();
            clicked = true;
          }

          if (!clicked) {
            logger.warn('Could not find Delete confirmation button. Cancelling menu...');
            await page.keyboard.press('Escape');
            await delay(500);
            if (tweetId !== 'unknown') processedTweets.add(tweetId);
            continue;
          }

          deletedCount++;
          deletedAnyThisPass = true;
          if (tweetId !== 'unknown') processedTweets.add(tweetId);

          logger.success(`Sent Delete command for tweet ${deletedCount}: "${snippet}..."`);
          logger.stats('Delete', deletedCount);

          // Safe delay between deletions
          await randomDelay(1500, 3000);

          await safetyTracker.registerAction(logger);

          // Break to re-evaluate DOM immediately because deletion shifts layouts
          break;

        } catch (err) {
          logger.warn(`Failed to delete a specific tweet: ${err.message || err}`);
          await page.keyboard.press('Escape').catch(() => {});
          await randomDelay(1000, 2000);
        }
      }

      if (!deletedAnyThisPass && !isApiBlocked) {
        logger.info('Scrolling down to load more tweets...');
        await page.evaluate('window.scrollTo(0, window.scrollY + 800)');
        await delay(2500);
      }
    }
  } finally {
    page.off('response', responseHandler);
  }

  logger.success(`Delete run completed. Total deletion attempts: ${deletedCount}`);
}
