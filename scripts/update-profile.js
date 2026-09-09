const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = "https://api.github.com";
const OWNER = process.env.PROFILE_OWNER || "a2rp";
const TOKEN = process.env.GITHUB_TOKEN || "";
const README_PATH = path.resolve(process.env.README_PATH || "README.md");
const DRY_RUN = process.argv.includes("--dry-run");
const START_MARKER = "<!-- BEGIN LATEST-GITHUB-UPDATE -->";
const END_MARKER = "<!-- END LATEST-GITHUB-UPDATE -->";
const MAX_TOPICS = 5;

const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".html", ".java",
  ".js", ".jsx", ".mjs", ".cjs", ".php", ".py", ".rb", ".rs", ".scss",
  ".sql", ".svelte", ".ts", ".tsx", ".vue",
]);

function githubHeaders(accept = "application/vnd.github+json") {
  const headers = {
    Accept: accept,
    "User-Agent": "a2rp-profile-updater",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (TOKEN) {
    headers.Authorization = `Bearer ${TOKEN}`;
  }

  return headers;
}

async function fetchWithTimeout(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}: ${url}`);
  }

  return response;
}

async function githubJson(endpoint) {
  const response = await fetchWithTimeout(`${API_ROOT}${endpoint}`, {
    headers: githubHeaders(),
  });
  return response.json();
}

async function githubText(endpoint) {
  const url = `${API_ROOT}${endpoint}`;
  const response = await fetch(url, {
    headers: githubHeaders("application/vnd.github.raw+json"),
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 404) return "";
  if (!response.ok) throw new Error(`Request failed with ${response.status}: ${url}`);
  return response.text();
}

async function listOwnedRepositories() {
  const repositories = [];

  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubJson(
      `/users/${encodeURIComponent(OWNER)}/repos?type=owner&sort=pushed&direction=desc&per_page=100&page=${page}`,
    );

    if (!Array.isArray(batch)) {
      throw new Error("GitHub returned an invalid repository list.");
    }

    repositories.push(...batch);
    if (batch.length < 100) break;
  }

  if (repositories.length === 0) {
    throw new Error("GitHub returned no public repositories.");
  }

  return repositories;
}

function isObviousTemporaryRepository(name) {
  return /^(test|temp|tmp|scratch)([-_.]|$)|(^|[-_.])(test|temp|tmp|scratch)$/i.test(name);
}

function isMeaningfulSourcePath(filePath) {
  const normalized = filePath.toLowerCase();
  const segments = normalized.split("/");
  const excludedDirectories = new Set([
    ".git", ".github", "build", "coverage", "dist", "docs", "node_modules", "vendor",
  ]);

  if (segments.some((segment) => excludedDirectories.has(segment))) return false;
  return SOURCE_EXTENSIONS.has(path.posix.extname(normalized));
}

async function getRepositoryTree(repository) {
  const branch = encodeURIComponent(repository.default_branch);
  const tree = await githubJson(
    `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/git/trees/${branch}?recursive=1`,
  );

  if (!Array.isArray(tree.tree)) {
    throw new Error(`GitHub returned an invalid tree for ${repository.full_name}.`);
  }

  return tree.tree.filter((item) => item.type === "blob" && typeof item.path === "string");
}

async function selectLatestRepository(repositories) {
  const candidates = repositories
    .filter((repository) => repository.owner?.login?.toLowerCase() === OWNER.toLowerCase())
    .filter((repository) => !repository.private && !repository.fork)
    .filter((repository) => !repository.archived && !repository.disabled)
    .filter((repository) => repository.name.toLowerCase() !== OWNER.toLowerCase())
    .filter((repository) => !isObviousTemporaryRepository(repository.name))
    .filter((repository) => typeof repository.description === "string" && repository.description.trim())
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  for (const repository of candidates) {
    const tree = await getRepositoryTree(repository);
    if (tree.filter((item) => isMeaningfulSourcePath(item.path)).length >= 2) {
      return { repository, tree };
    }
  }

  throw new Error("No recent repository passed the meaningful source checks.");
}

function isSupportedImage(filePath) {
  return /\.(gif|jpe?g|png|webp)$/i.test(filePath);
}

function isExcludedImage(filePath) {
  const normalized = filePath.toLowerCase();
  const segments = normalized.split("/");
  const excludedDirectories = new Set([
    ".git", "build", "coverage", "dist", "node_modules", "vendor",
  ]);
  const basename = path.posix.basename(normalized);

  return segments.some((segment) => excludedDirectories.has(segment))
    || /(favicon|icon|logo|sprite|avatar)/i.test(basename);
}

function rawGitHubUrl(repository, filePath) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/${encodeURIComponent(repository.default_branch)}/${encodedPath}`;
}

function findNamedPreview(repository, images) {
  const priorities = ["preview", "screenshot", "cover", "banner", "demo"];

  for (const priority of priorities) {
    const matches = images
      .filter((item) => new RegExp(`^${priority}(?:[-_.].*)?\\.(?:gif|jpe?g|png|webp)$`, "i")
        .test(path.posix.basename(item.path)))
      .sort((a, b) => (b.size || 0) - (a.size || 0));

    if (matches.length > 0) return rawGitHubUrl(repository, matches[0].path);
  }

  return null;
}

function extractReadmeImageUrls(markdown) {
  const urls = [];
  const markdownImages = /!\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g;
  const htmlImages = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

  for (const match of markdown.matchAll(markdownImages)) urls.push(match[1]);
  for (const match of markdown.matchAll(htmlImages)) urls.push(match[1]);
  return urls;
}

function resolveReadmeImage(repository, tree, imageUrl) {
  if (/^https:\/\//i.test(imageUrl)) {
    if (/^(https:\/\/raw\.githubusercontent\.com\/|https:\/\/github\.com\/[^/]+\/[^/]+\/assets\/)/i.test(imageUrl)) {
      return imageUrl;
    }
    return null;
  }

  if (/^[a-z]+:/i.test(imageUrl) || imageUrl.startsWith("#")) return null;
  const cleanPath = decodeURIComponent(imageUrl.split(/[?#]/, 1)[0]).replace(/^\.\//, "");
  const match = tree.find((item) => item.path.toLowerCase() === cleanPath.toLowerCase());

  if (!match || !isSupportedImage(match.path) || isExcludedImage(match.path)) return null;
  return rawGitHubUrl(repository, match.path);
}

async function validateExternalImage(url) {
  if (url.includes("raw.githubusercontent.com")) return true;

  try {
    const response = await fetchWithTimeout(url, { method: "HEAD" });
    return (response.headers.get("content-type") || "").toLowerCase().startsWith("image/");
  } catch {
    return false;
  }
}

async function selectProjectImage(repository, tree, readme) {
  const images = tree.filter((item) => isSupportedImage(item.path) && !isExcludedImage(item.path));
  const namedPreview = findNamedPreview(repository, images);
  if (namedPreview) return namedPreview;

  for (const imageUrl of extractReadmeImageUrls(readme)) {
    const resolved = resolveReadmeImage(repository, tree, imageUrl);
    if (resolved && await validateExternalImage(resolved)) return resolved;
  }

  const commonAssetImage = images
    .filter((item) => /(^|\/)(assets?|images?|screenshots?|docs?|public)(\/|$)/i.test(item.path))
    .filter((item) => (item.size || 0) >= 20_000)
    .sort((a, b) => (b.size || 0) - (a.size || 0))[0];

  return commonAssetImage ? rawGitHubUrl(repository, commonAssetImage.path) : null;
}

async function getMeaningfulCommit(repository) {
  const commits = await githubJson(
    `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/commits?per_page=10`,
  );

  if (!Array.isArray(commits)) return null;

  for (const commit of commits) {
    const message = commit.commit?.message?.split("\n", 1)[0]?.trim();
    if (!message || /^(docs?|chore):?\s+update/i.test(message)) continue;

    const details = await githubJson(
      `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/commits/${commit.sha}`,
    );
    const files = Array.isArray(details.files) ? details.files : [];
    if (files.some((file) => isMeaningfulSourcePath(file.filename))) return message;
  }

  return null;
}

async function validHomepage(homepage) {
  if (!homepage || !/^https:\/\//i.test(homepage)) return null;

  try {
    await fetchWithTimeout(homepage, { method: "HEAD", redirect: "follow" });
    return homepage;
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\|/g, "\\|")
    .trim();
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("The selected repository has an invalid pushed_at date.");
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date);
}

function buildProjectBlock(repository, imageUrl, commitMessage, homepage) {
  const lines = [
    `### [${cleanText(repository.name)}](${repository.html_url})`,
    "",
  ];

  if (imageUrl) {
    lines.push(
      `<a href="${repository.html_url}"><img src="${imageUrl}" alt="Preview of ${escapeHtml(repository.name)}" width="720"></a>`,
      "",
    );
  }

  lines.push(cleanText(repository.description), "");

  const details = [];
  if (repository.language) details.push(`**Primary language:** ${cleanText(repository.language)}`);
  details.push(`**Last pushed:** ${formatDate(repository.pushed_at)}`);
  lines.push(details.join(" | "));

  const topics = Array.isArray(repository.topics)
    ? repository.topics.filter(Boolean).slice(0, MAX_TOPICS)
    : [];
  if (topics.length > 0) {
    lines.push(`**Topics:** ${topics.map((topic) => `\`${cleanText(topic)}\``).join(" ")}`);
  }
  if (commitMessage) lines.push(`**Latest code update:** ${cleanText(commitMessage)}`);

  lines.push("", `[Source](${repository.html_url})${homepage ? ` | [Live](${homepage})` : ""}`);
  return lines.join("\n");
}

function replaceSection(readme, generatedBlock) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Latest GitHub update markers are missing or out of order.");
  }
  if (readme.indexOf(START_MARKER, start + START_MARKER.length) !== -1
      || readme.indexOf(END_MARKER, end + END_MARKER.length) !== -1) {
    throw new Error("Latest GitHub update markers must appear exactly once.");
  }

  const eol = readme.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBlock = generatedBlock.replace(/\n/g, eol);
  return `${readme.slice(0, start + START_MARKER.length)}${eol}${normalizedBlock}${eol}${readme.slice(end)}`;
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
  const repositories = await listOwnedRepositories();
  const { repository, tree } = await selectLatestRepository(repositories);
  const readme = await githubText(
    `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/readme`,
  );
  const [imageUrl, commitMessage, homepage] = await Promise.all([
    selectProjectImage(repository, tree, readme),
    getMeaningfulCommit(repository),
    validHomepage(repository.homepage),
  ]);

  const generatedBlock = buildProjectBlock(repository, imageUrl, commitMessage, homepage);
  const currentReadme = fs.readFileSync(README_PATH, "utf8");
  const updatedReadme = replaceSection(currentReadme, generatedBlock);
  const changed = updatedReadme !== currentReadme;

  if (DRY_RUN) {
    console.log(generatedBlock);
    console.log(`\nDry run complete. README would ${changed ? "change" : "not change"}.`);
    return;
  }

  if (!changed) {
    console.log("Latest GitHub update is already current.");
    return;
  }

  writeFileAtomically(README_PATH, updatedReadme);
  console.log(`Updated README with ${repository.full_name}.`);
}

main().catch((error) => {
  console.error(`Profile update failed: ${error.message}`);
  process.exitCode = 1;
});
