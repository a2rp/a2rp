const fs = require("node:fs");
const path = require("node:path");

const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "UCLHIBQeFQIxmRveVAjLvlbQ";
const SHORTS_URL = process.env.YOUTUBE_SHORTS_URL
  || "https://www.youtube.com/@ashishranjan-ashz/shorts?hl=en";
const README_PATH = path.resolve(process.env.README_PATH || "README.md");
const DRY_RUN = process.argv.includes("--dry-run");
const START_MARKER = "<!-- BEGIN YOUTUBE-CARDS -->";
const END_MARKER = "<!-- END YOUTUBE-CARDS -->";
const SHORTS_START_MARKER = "<!-- BEGIN YOUTUBE-SHORTS -->";
const SHORTS_END_MARKER = "<!-- END YOUTUBE-SHORTS -->";
const VIDEO_COUNT = 2;
const SHORT_COUNT = 2;

function decodeXml(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\"",
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, code) => {
    if (code[0] !== "#") return namedEntities[code.toLowerCase()];
    const numeric = code[1].toLowerCase() === "x"
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
  });
}

function cleanText(value) {
  return decodeXml(value)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .trim();
}

async function fetchFeed() {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(CHANNEL_ID)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "a2rp-profile-updater" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`YouTube feed request failed with ${response.status}.`);
  }

  const xml = await response.text();
  if (!xml.includes("<feed") || !xml.includes("<entry>")) {
    throw new Error("YouTube returned an incomplete feed.");
  }
  return xml;
}

async function fetchShortsPage() {
  const response = await fetch(SHORTS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; a2rp-profile-updater/1.0)" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`YouTube Shorts page request failed with ${response.status}.`);
  }

  const html = await response.text();
  if (!html.includes("shortsLockupViewModel")) {
    throw new Error("YouTube returned a Shorts page with an unsupported format.");
  }
  return html;
}

function parseVideos(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  const videos = entries.map(([, entry]) => {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]?.trim();
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1]?.trim();

    if (!id || !/^[A-Za-z0-9_-]{6,}$/.test(id) || !title || !published) return null;
    const timestamp = Math.floor(Date.parse(published) / 1000);
    if (!Number.isFinite(timestamp)) return null;

    return { id, title: cleanText(title), timestamp };
  }).filter(Boolean);

  return videos;
}

function parseJsonObject(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }

    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      return JSON.parse(source.slice(start, index + 1));
    }
  }

  return null;
}

function parseShorts(html, publishedVideos) {
  const marker = '"shortsLockupViewModel":';
  const publishedById = new Map(publishedVideos.map((video) => [video.id, video.timestamp]));
  const shorts = [];
  const seen = new Set();
  let cursor = 0;

  while ((cursor = html.indexOf(marker, cursor)) !== -1) {
    const objectStart = html.indexOf("{", cursor + marker.length);
    if (objectStart === -1) break;

    const model = parseJsonObject(html, objectStart);
    cursor = objectStart + 1;

    const id = model?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    const title = model?.overlayMetadata?.primaryText?.content;
    if (!id || !title || seen.has(id)) continue;

    seen.add(id);
    shorts.push({ id, title: cleanText(title), timestamp: publishedById.get(id) });
  }

  if (shorts.length < SHORT_COUNT) {
    throw new Error(`YouTube returned ${shorts.length} Shorts; expected at least ${SHORT_COUNT}.`);
  }

  return shorts;
}

function buildCard(video, isShort = false) {
  const cardUrl = new URL("https://ytcards.demolab.com/");
  const parameters = {
    id: video.id,
    title: video.title,
    lang: "en",
    background_color: "#0d1117",
    title_color: "#ffffff",
    stats_color: "#b3b3b3",
    max_title_lines: "2",
    width: "360",
    border_radius: "10",
  };
  if (video.timestamp) parameters.timestamp = String(video.timestamp);
  cardUrl.search = new URLSearchParams(parameters).toString();

  const videoUrl = isShort
    ? `https://www.youtube.com/shorts/${encodeURIComponent(video.id)}`
    : `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  const alt = video.title.replace(/[[\]"\\]/g, "");
  return `[![${alt}](${cardUrl.toString()} "${alt}")](${videoUrl})`;
}

function replaceSection(readme, startMarker, endMarker, cards) {
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`YouTube markers ${startMarker} and ${endMarker} are missing or out of order.`);
  }
  if (readme.indexOf(startMarker, start + startMarker.length) !== -1
      || readme.indexOf(endMarker, end + endMarker.length) !== -1) {
    throw new Error(`YouTube markers ${startMarker} and ${endMarker} must appear exactly once.`);
  }

  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const block = cards.join(eol);
  return `${readme.slice(0, start + startMarker.length)}${eol}${block}${eol}${readme.slice(end)}`;
}

function writeFileAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

async function main() {
  const [feed, shortsPage] = await Promise.all([fetchFeed(), fetchShortsPage()]);
  const uploadedVideos = parseVideos(feed);
  const allShorts = parseShorts(shortsPage, uploadedVideos);
  const shorts = allShorts.slice(0, SHORT_COUNT);
  const shortIds = new Set(allShorts.map((short) => short.id));
  const videos = uploadedVideos.filter((video) => !shortIds.has(video.id)).slice(0, VIDEO_COUNT);

  if (videos.length < VIDEO_COUNT) {
    throw new Error(`YouTube returned ${videos.length} regular videos; expected at least ${VIDEO_COUNT}.`);
  }

  const videoCards = videos.map((video) => buildCard(video));
  const shortCards = shorts.map((short) => buildCard(short, true));
  const currentReadme = fs.readFileSync(README_PATH, "utf8");
  const withVideos = replaceSection(currentReadme, START_MARKER, END_MARKER, videoCards);
  const updatedReadme = replaceSection(withVideos, SHORTS_START_MARKER, SHORTS_END_MARKER, shortCards);
  const changed = updatedReadme !== currentReadme;

  if (DRY_RUN) {
    console.log("Latest videos:");
    console.log(videoCards.join("\n"));
    console.log("\nLatest Shorts:");
    console.log(shortCards.join("\n"));
    console.log(`\nDry run complete. README would ${changed ? "change" : "not change"}.`);
    return;
  }

  if (!changed) {
    console.log("YouTube cards are already current.");
    return;
  }

  writeFileAtomically(README_PATH, updatedReadme);
  console.log(`Updated README with ${videoCards.length} video cards and ${shortCards.length} Shorts cards.`);
}

main().catch((error) => {
  console.error(`YouTube update failed: ${error.message}`);
  process.exitCode = 1;
});
