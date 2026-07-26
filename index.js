const puppeteer = require("puppeteer-extra");
const BlockedRes = require("puppeteer-extra-plugin-block-resources");
const RSS = require("rss");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

puppeteer.use(
  BlockedRes({
    blockedTypes: new Set(["image", "stylesheet"]),
  })
);

const SOURCE_URL = "https://www.israelnationalnews.com";
const FLASHES_URL = "https://www.israelnationalnews.com/flashes/";

const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "rss");
const RSS_FILE = path.join(OUTPUT_DIR, "inn.xml");
const ITEMS_FILE = path.join(OUTPUT_DIR, "newsItems.json");
const SCREENSHOT_ON_ERROR = process.env.SCREENSHOT_ON_ERROR !== "false";
const SCREENSHOT_FILE = path.join(OUTPUT_DIR, "error-screenshot.png");
const HTML_FILE = path.join(OUTPUT_DIR, "error-page.html");
const DOM_DUMP_FILE = path.join(OUTPUT_DIR, "flashes-dom.html");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatDate = (timeString, dateString, index) => {
  try {
    const now = new Date();
    if (!timeString || timeString === "Unknown time") {
      const offsetDate = new Date(now.getTime() - index * 60 * 1000);
      return offsetDate;
    }
    let dateStr = dateString;
    if (!dateString || dateString === "Unknown date") {
      const month = now.toLocaleString("en-US", { month: "short" });
      const day = now.getDate();
      const year = now.getFullYear();
      dateStr = `${month} ${day}, ${year}`;
    }
    const [month, day, year] = dateStr.trim().split(" ");
    const formattedDate = new Date(
      `${month} ${day} ${year} ${timeString.trim()} +0300`
    );
    if (isNaN(formattedDate.getTime())) {
      throw new Error("Invalid date format");
    }
    return formattedDate;
  } catch (e) {
    console.error("Date parsing error:", e.message, {
      timeString,
      dateString,
      index,
    });
    const now = new Date();
    return new Date(now.getTime() - index * 60 * 1000);
  }
};

async function generateRSSFeed(browser) {
  let page;
  try {
    console.log("Generating RSS feed...");

    if (!browser) {
      throw new Error("Browser not initialized");
    }

    page = await browser.newPage();
    console.log("New page created");

    page.on("console", (msg) => {
      console.log("PAGE LOG:", msg.text());
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    console.log(`Navigating to ${SOURCE_URL}`);
    try {
      await page.goto(SOURCE_URL, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
    } catch (navError) {
      console.error("Navigation failed:", navError.message);
      throw navError;
    }

    console.log("Waiting for dynamic content (1 seconds)...");
    await delay(1000);

    console.log("Looking for .home-flashes link on main page...");
    try {
      await page.waitForSelector(".home-flashes", { timeout: 15000 });
      console.log(".home-flashes found, clicking...");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
        page.click(".home-flashes"),
      ]);
      console.log(`Navigated to ${page.url()}`);
    } catch (homeErr) {
      console.error(
        ".home-flashes not found or click failed:",
        homeErr.message
      );
      console.log(`Falling back to direct navigation to ${FLASHES_URL}`);
      try {
        await page.goto(FLASHES_URL, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
      } catch (navError) {
        console.error("Fallback navigation failed:", navError.message);
        throw navError;
      }
    }

    console.log("Waiting for dynamic content (1 seconds)...");
    await delay(1000);

    console.log("Waiting for li.accordeon-item selector...");
    try {
      await page.waitForSelector("li.accordeon-item", { timeout: 15000 });
      console.log("Accordeon item selector found");
    } catch (selectorError) {
      console.error(
        "Accordeon item selector wait failed:",
        selectorError.message
      );
    }

    const items = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("li.accordeon-item"));
      return nodes.map((el) => {
        const time =
          el.querySelector("span.flash-date")?.innerText?.trim() ||
          "Unknown time";
        const title =
          el.querySelector("h2.title")?.innerText?.trim() || "";
        const id = el.id || "";
        return { id, time, title };
      });
    });
    console.log(`Extracted ${items.length} items`);
    if (items.length === 0) {
      throw new Error("No .accordeon-item elements found.");
    }
    items.forEach((it, i) => console.log(i, it.time, it.title));

    const feed = new RSS({
      title: "Israel National News Flashes",
      description: "Latest news flashes from Israel National News",
      feed_url: "", // TODO: add link
      site_url: "https://www.israelnationalnews.com",
      language: "en-us",
      pubDate: new Date(),
      ttl: 60,
    });

    items.forEach((item, index) => {
      if (!item.title) return;
      const guid = item.id
        ? `https://www.israelnationalnews.com/flashes#${item.id}`
        : `https://www.israelnationalnews.com/flashes/item-${index}-${item.title.replace(
            /\s+/g,
            "-"
          )}`;
      feed.item({
        title: item.title,
        description: item.title,
        url: "https://www.israelnationalnews.com/flashes",
        guid,
        date: formatDate(item.time, null, index),
      });
    });

    const rssFeed = feed.xml({ indent: true });
    await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(RSS_FILE, rssFeed);
    console.log(`RSS feed saved to ${RSS_FILE}`);

    return true;
  } catch (error) {
    console.error("Error generating RSS feed:", error.message);
    if (SCREENSHOT_ON_ERROR && page) {
      try {
        await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
        await page.screenshot({ path: SCREENSHOT_FILE, fullPage: true });
        console.log(`Error screenshot saved to ${SCREENSHOT_FILE}`);
        const html = await page.content();
        fs.writeFileSync(HTML_FILE, html);
        console.log(`Error HTML saved to ${HTML_FILE}`);
      } catch (ssErr) {
        console.error("Failed to capture error artifacts:", ssErr.message);
      }
    }
    return false;
  } finally {
    if (page) {
      await page.close();
      console.log("Page closed");
    }
  }
}

async function main() {
  let browser;
  try {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    console.log("RSS update started at:", new Date().toISOString());

    console.log("Adding a 500ms delay before launching the browser...");
    await delay(500);

    console.log("Launching Puppeteer browser...");
    const headlessType = process.env.IS_LOCAL ? false : "shell";
    browser = await puppeteer.launch({ product: "firefox", headless: headlessType });
    console.log("Browser launched successfully");

    const hasItems = await generateRSSFeed(browser);

    if (hasItems) {
      console.log("RSS update completed successfully with new items");
    } else {
      console.log("RSS update completed - no new items found");
    }
  } catch (error) {
    console.error("Error in RSS update:", error);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed");
    }
  }
}

main();
