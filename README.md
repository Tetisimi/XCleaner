# X-Cleaner 🧹

A local Node.js CLI tool built with **Playwright** that automates the bulk deletion and cleaning of your X (Twitter) activity. It runs entirely on your local machine—no servers, no API keys, no stored tokens.

## Features
- **Unlike all liked tweets:** Cleans your likes tab by removing your likes.
- **Delete all tweets:** Removes all your personal tweets.
- **Delete all retweets (reposts):** Automatically identifies retweets and undoes them.
- **Clear search history:** Navigates to your search settings and clears history.
- **Built-in safety rate limiting:** Adds human-like randomized delays and cools down for 10 seconds after every 50 actions to avoid trigger rate limits.

---

## Installation & Setup

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed (version 18+ recommended).

1. Clone or download this project to your directory.
2. Open a terminal in the root of the project directory.
3. Install the dependencies:
   ```bash
   npm install
   ```
4. Install the Chromium browser binary required by Playwright:
   ```bash
   npx playwright install chromium
   ```

---

## How to Run

Start the cleaner by running:
```bash
npm start
```

---

## What to Expect on Run

1. **Browser Launch:** A non-headless Chromium window will open automatically, navigating to the X login page.
2. **Login Pause:** The terminal will display:
   ```text
   ℹ Opening browser window...
   ℹ Navigating to login page...
   ℹ Waiting for you to log in in the browser...

   Please log in to X in the browser window, then press ENTER to continue...
   ```
3. **Manual Login:** Log into your X account inside the Chromium window. You can use two-factor authentication or any standard login method.
4. **Login Verification:** Once you've logged in, return to the terminal and press **ENTER**. The script will verify the login status, scrape your username automatically, and display:
   ```text
   ✓ Successfully logged in as: @your_username
   ```
5. **Selection Menu:** Select which activities you want to clean using the interactive multi-select menu (press `Space` to select/deselect and `Enter` to confirm):
   ```text
   ? Pick what to clean (Space to select, Enter to confirm):
   - [ ] Unlike all liked tweets
   - [ ] Delete all my tweets
   - [ ] Delete all retweets
   - [ ] Clear search history
   - [ ] Run all of the above
   ```
6. **Final Confirmation:** The script will show a final safety check:
   ```text
   ? This cannot be undone. Type YES to continue:
   ```
   Type `YES` in all capitals to start. Any other input will cancel the process.
7. **Execution:** The automated tasks will execute in order. The script will log each success, rate-limit check, and running status:
   ```text
   ✓ Unliked tweet 1: "This is some tweet text..."
   Stats -> Unliked: 1 | Remaining: ?
   ```
8. **Completion:** Once all tasks complete, the browser will close automatically.

---

## Selectors & Safety Notice
- This script uses stable Playwright selectors (`data-testid` and `aria-label`) that are less prone to breaking when CSS layouts change.
- However, since X (Twitter) modifies its web client frequently, some button selectors might occasionally change. If an action fails, check the warnings in the logs.
- Keep in mind that doing hundreds of deletions in a very short window can trigger X's automatic safety blocks. The script includes a random delay (600ms to 1200ms) between actions and a 10-second pause every 50 actions to mimic human behavior.
