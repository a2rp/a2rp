const fs = require("node:fs");
const path = require("node:path");

const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || "UCLHIBQeFQIxmRveVAjLvlbQ";
const README_PATH = path.resolve(process.env.README_PATH || "README.md");
const DRY_RUN = process.argv.includes("--dry-run");
const START_MARKER = "<!-- BEGIN YOUTUBE-CARDS -->";
const END_MARKER = "<!-- END YOUTUBE-CARDS -->";
const VIDEO_COUNT = 4;

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

  if (videos.length < VIDEO_COUNT) {
    throw new Error(`YouTube returned ${videos.length} valid videos; expected at least ${VIDEO_COUNT}.`);
  }

  return videos.slice(0, VIDEO_COUNT);
}

function buildCard(video) {
  const cardUrl = new URL("https://ytcards.demolab.com/");
  cardUrl.search = new URLSearchParams({
    id: video.id,
    title: video.title,
    lang: "en",
    timestamp: String(video.timestamp),
    background_color: "#0d1117",
    title_color: "#ffffff",
    stats_color: "#b3b3b3",
    max_title_lines: "2",
    width: "360",
    border_radius: "10",
  }).toString();

  const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`;
  const alt = video.title.replace(/[[\]"\\]/g, "");
  return `[![${alt}](${cardUrl.toString()} "${alt}")](${videoUrl})`;
}

function replaceSection(readme, cards) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("YouTube markers are missing or out of order.");
  }
  if (readme.indexOf(START_MARKER, start + START_MARKER.length) !== -1
      || readme.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
    throw new Error("YouTube markers must appear exactly once.");
  }

  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const block = cards.join(eol);
  return `${readme.slice(0, start + START_MARKER.length)}${eol}${block}${eol}${readme.slice(end)}`;
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
  const feed = await fetchFeed();
  const cards = parseVideos(feed).map(buildCard);
  const currentReadme = fs.readFileSync(README_PATH, "utf8");
  const updatedReadme = replaceSection(currentReadme, cards);
  const changed = updatedReadme !== currentReadme;

  if (DRY_RUN) {
    console.log(cards.join("\n"));
    console.log(`\nDry run complete. README would ${changed ? "change" : "not change"}.`);
    return;
  }

  if (!changed) {
    console.log("YouTube cards are already current.");
    return;
  }

  writeFileAtomically(README_PATH, updatedReadme);
  console.log(`Updated README with ${cards.length} YouTube cards.`);
}

main().catch((error) => {
  console.error(`YouTube update failed: ${error.message}`);
  process.exitCode = 1;
});
