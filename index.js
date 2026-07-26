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

const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || "3", 10);
const MAX_ITEMS = parseInt(process.env.MAX_ITEMS || "500", 10);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pruneCache = (cache) => {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const entries = Object.entries(cache);
  const kept = entries.filter(([, v]) => {
    if (!v || !v.date) return false;
    const d = new Date(v.date);
    return !isNaN(d.getTime()) && d.getTime() >= cutoff;
  });
  if (kept.length > MAX_ITEMS) {
    kept.sort((a, b) => new Date(b[1].date) - new Date(a[1].date));
    kept.length = MAX_ITEMS;
  }
  const removed = entries.length - kept.length;
  if (removed > 0) {
    console.log(`Pruned ${removed} stale cache entries (kept ${kept.length}/${entries.length})`);
  }
  return Object.fromEntries(kept);
};

const timeToMinutes = (timeStr) => {
  const [h, m] = timeStr.trim().split(":").map(Number);
  return h * 60 + m;
};

const parseDateStr = (dateStr) => {
  // e.g. "Jul 26, 2026"
  const [month, day, year] = dateStr.trim().replace(",", "").split(" ");
  return new Date(`${month} ${day} ${year}`);
};

const formatDate = (timeString, dateString, index) => {
  try {
    const now = new Date();
    if (!timeString || timeString === "Unknown time") {
      return new Date(now.getTime() - index * 60 * 1000);
    }
    const dateStr = dateString || (() => {
      const m = now.toLocaleString("en-US", { month: "short" });
      return `${m} ${now.getDate()}, ${now.getFullYear()}`;
    })();
    const [month, day, year] = dateStr.trim().replace(",", "").split(" ");
    const formattedDate = new Date(
      `${month} ${day} ${year} ${timeString.trim()} +0300`
    );
    if (isNaN(formattedDate.getTime())) {
      throw new Error("Invalid date format");
    }
    return formattedDate;
  } catch (e) {
    console.error("Date parsing error:", e.message, { timeString, dateString, index });
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

    // Load cached descriptions
    let descCache = {};
    try {
      const data = fs.readFileSync(ITEMS_FILE, "utf8");
      descCache = JSON.parse(data);
    } catch (e) {
      console.log("No description cache found", e.message);
    }

    // Click only the top 10 items that aren't cached to fetch extra info
    const TOP_N = 10;
    const elements = await page.$$("li.accordeon-item");
    for (let i = 0; i < Math.min(TOP_N, elements.length); i++) {
      const item = items[i];
      if (!item || !item.id) continue;
      const cacheKey = item.id;
      if (descCache[cacheKey]) {
        item.description = descCache[cacheKey].description;
        item.link = descCache[cacheKey].link || "/flashes";
        item.date = descCache[cacheKey].date || "";
        console.log(`Cache hit for ${cacheKey}`);
        continue;
      }
      console.log(`Fetching extra info for ${cacheKey} (index ${i})`);
      try {
        await elements[i].click();
        await delay(300);
        let extraInfo = "";
        try {
          extraInfo = await elements[i].$eval(
            "#articleContent",
            (el) => el.innerText
          );
        } catch (e) {
          // no article content
        }
        let link = "/flashes";
        try {
          link = await elements[i].$eval(
            "a.flash-full-article-link",
            (el) => el.getAttribute("href")
          );
        } catch (e) {
          // no link
        }
        let dateStr = "";
        try {
          dateStr = await elements[i].$eval(
            "div.accordeon-item__details time.flash-date",
            (el) => el.innerText.trim()
          );
        } catch (e) {
          // no date in details
        }
        item.description = extraInfo || item.title;
        item.link = link;
        item.date = dateStr;
        descCache[cacheKey] = {
          description: item.description,
          link,
          date: dateStr,
        };
        console.log(
          `Got extra info for ${cacheKey}: ${extraInfo.slice(0, 80)} | link: ${link} | date: ${dateStr}`
        );
      } catch (clickErr) {
        console.error(`Click failed for ${cacheKey}:`, clickErr.message);
        item.description = item.title;
        item.link = "/flashes";
      }
    }

    // Save updated cache
    try {
      await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
      const prunedCache = pruneCache(descCache);
      fs.writeFileSync(ITEMS_FILE, JSON.stringify(prunedCache, null, 2));
      console.log(`Description cache saved to ${ITEMS_FILE}`);
    } catch (cacheErr) {
      console.error("Failed to save cache:", cacheErr.message);
    }

    const feed = new RSS({
      title: "Israel National News Flashes",
      description: "Latest news flashes from Israel National News",
      feed_url: "http://do34.50webs.com/rss/inn.xml",
      site_url: "https://www.israelnationalnews.com",
      language: "en-us",
      pubDate: new Date(),
      ttl: 60,
    });

    // Infer dates for items without one (items are in descending time order)
    let currentDate = new Date();
    let prevTime = null;
    for (const item of items) {
      if (item.date) {
        currentDate = parseDateStr(item.date);
        prevTime = item.time;
      } else {
        // If time increased vs previous, we crossed midnight going back
        if (prevTime && timeToMinutes(item.time) > timeToMinutes(prevTime)) {
          currentDate = new Date(currentDate.getTime() - 24 * 60 * 60 * 1000);
        }
        item.date = currentDate.toLocaleString("en-US", {
          month: "short",
          day: "2-digit",
          year: "numeric",
        });
        prevTime = item.time;
      }
    }

    items.forEach((item, index) => {
      if (!item.title) return;
      const fullLink = item.link
        ? item.link.startsWith("http")
          ? item.link
          : `https://www.israelnationalnews.com${item.link}`
        : "https://www.israelnationalnews.com/flashes";
      const guid = item.id
        ? `https://www.israelnationalnews.com/flashes#${item.id}`
        : `https://www.israelnationalnews.com/flashes/item-${index}-${item.title.replace(
            /\s+/g,
            "-"
          )}`;
      feed.item({
        title: item.title,
        description: item.description || item.title,
        url: fullLink,
        guid,
        date: formatDate(item.time, item.date, index),
      });
    });

    const rssFeed = feed.xml({ indent: true });
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
    browser = await puppeteer.launch({
      headless: headlessType,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
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
