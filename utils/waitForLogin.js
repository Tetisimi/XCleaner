import readline from 'readline';
import { logger } from './logger.js';
import prompts from 'prompts';

const waitKeyPress = (promptMessage) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(promptMessage, () => {
      rl.close();
      resolve();
    });
  });
};

/**
 * Checks if the user is logged in to X.
 * Returns the username if detected, or null.
 * @param {import('playwright').Page} page
 */
async function checkLoginState(page) {
  try {
    // Wait for the URL or selector that indicates home page
    const currentUrl = page.url();
    if (currentUrl.includes('/home') || currentUrl.includes('/i/flow/login') === false) {
      // Look for the profile navigation button to verify login and scrape username
      // The profile button test ID is usually 'AppTabBar_Profile_Link'
      const profileLink = page.locator('[data-testid="AppTabBar_Profile_Link"]');
      
      // Give it a short timeout to see if it is visible
      await profileLink.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      
      const isVisible = await profileLink.isVisible();
      if (isVisible) {
        const href = await profileLink.getAttribute('href');
        if (href) {
          const username = href.replace('/', '').trim();
          if (username) {
            return username;
          }
        }
      }
      
      // Fallback: Check if we are on some other page and home link is visible
      const homeLink = page.locator('[data-testid="AppTabBar_Home_Link"]');
      if (await homeLink.isVisible()) {
        return 'DETECTED_BUT_NO_USERNAME';
      }
    }
  } catch (error) {
    // Suppress error and return null if not logged in
  }
  return null;
}

/**
 * Main waiting function for login.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>} Username of the logged in account
 */
export async function waitForLogin(page) {
  logger.info('Waiting for you to log in in the browser...');
  
  let username = null;
  let attempts = 0;

  while (true) {
    if (attempts === 0) {
      await waitKeyPress('\nPlease log in to X in the browser window, then press ENTER to continue...');
    } else {
      await waitKeyPress('\n[!] Login not detected yet. Please make sure you are logged in, then press ENTER to retry...');
    }

    username = await checkLoginState(page);
    
    if (username) {
      if (username === 'DETECTED_BUT_NO_USERNAME') {
        logger.success('Login detected, but could not auto-detect username.');
        // Ask the user to input their username
        const response = await prompts({
          type: 'text',
          name: 'username',
          message: 'Please enter your X (Twitter) username:',
          validate: value => value.trim().length > 0 ? true : 'Username is required'
        });
        return response.username.trim();
      }
      
      logger.success(`Successfully logged in as: @${username}`);
      return username;
    }
    
    attempts++;
  }
}
