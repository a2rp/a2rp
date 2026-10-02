const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = "https://api.github.com";
const OWNER = process.env.PROFILE_OWNER || "a2rp";
const TOKEN = process.env.GITHUB_TOKEN || "";
const README_PATH = path.resolve(process.env.README_PATH || "README.md");
const DRY_RUN = process.argv.includes("--dry-run");
const START_MARKER = "<!-- BEGIN LATEST-PROJECTS -->";
const END_MARKER = "<!-- END LATEST-PROJECTS -->";
const PROJECT_COUNT = 3;
const MIN_ROOT_IMAGE_SIZE = 30_000;
const ROOT_IMAGE_EXTENSIONS = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);

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

async function selectLatestRepositories(repositories) {
  const candidates = repositories
    .filter((repository) => repository.owner?.login?.toLowerCase() === OWNER.toLowerCase())
    .filter((repository) => !repository.private && !repository.fork)
    .filter((repository) => !repository.archived && !repository.disabled)
    .filter((repository) => repository.name.toLowerCase() !== OWNER.toLowerCase())
    .filter((repository) => !isObviousTemporaryRepository(repository.name))
    .filter((repository) => typeof repository.description === "string" && repository.description.trim())
    .sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));

  const selected = [];

  for (const repository of candidates) {
    const tree = await getRepositoryTree(repository);
    if (tree.filter((item) => isMeaningfulSourcePath(item.path)).length >= 2) {
      selected.push({ repository, tree });
      if (selected.length === PROJECT_COUNT) return selected;
    }
  }
  return selected;
}

function isRootProjectImage(filePath) {
  const basename = path.posix.basename(filePath).toLowerCase();
  return !filePath.includes("/")
    && ROOT_IMAGE_EXTENSIONS.has(path.posix.extname(basename))
    && !/(favicon|icon|logo|sprite|avatar)/i.test(basename);
}

function rootImagePriority(filePath) {
  const basename = path.posix.basename(filePath);
  if (/^screenshot(?:[-_.]|$)/i.test(basename)) return 0;
  if (/^preview(?:[-_.]|$)/i.test(basename)) return 1;
  if (/^(cover|banner|demo)(?:[-_.]|$)/i.test(basename)) return 2;
  return 3;
}

function rawGitHubUrl(repository, filePath) {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/${encodeURIComponent(repository.default_branch)}/${encodedPath}`;
}

async function getLastImageUpdate(repository, filePath) {
  const commits = await githubJson(
    `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repository.name)}/commits?path=${encodeURIComponent(filePath)}&per_page=1`,
  );
  const date = commits[0]?.commit?.committer?.date || commits[0]?.commit?.author?.date;
  const timestamp = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(timestamp) ? { filePath, timestamp } : null;
}

async function selectLatestRootImage(repository, tree) {
  const candidates = tree.filter((item) => (
    isRootProjectImage(item.path) && (item.size || 0) >= MIN_ROOT_IMAGE_SIZE
  ));
  const updatedImages = (await Promise.all(
    candidates.map((item) => getLastImageUpdate(repository, item.path)),
  )).filter(Boolean);

  updatedImages.sort((a, b) => (b.timestamp - a.timestamp)
    || (rootImagePriority(a.filePath) - rootImagePriority(b.filePath)));

  return updatedImages.length > 0 ? rawGitHubUrl(repository, updatedImages[0].filePath) : null;
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

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("The selected repository has an invalid pushed_at date.");
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date);
}

function escapeHtml(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildProjectEntry(repository, homepage, imageUrl) {
  const details = [];
  if (repository.language) details.push(`\`${cleanText(repository.language)}\``);
  details.push(`Updated ${formatDate(repository.pushed_at)}`);
  if (homepage) details.push(`[Live demo](${homepage})`);

  const lines = [
    `- **[${cleanText(repository.name)}](${repository.html_url})** - ${cleanText(repository.description)}`,
  ];
  if (imageUrl) {
    lines.push(
      "  <br>",
      `  <a href="${repository.html_url}"><img src="${imageUrl}" alt="Preview of ${escapeHtml(repository.name)}" width="480"></a>`,
      "  <br>",
    );
  }
  lines.push(`  (${details.join(" · ")})`);
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
  const selectedRepositories = await selectLatestRepositories(repositories);
  if (selectedRepositories.length === 0) throw new Error("No recent repository passed the meaningful source checks.");

  const projects = await Promise.all(selectedRepositories.map(async ({ repository, tree }) => ({
    repository,
    homepage: await validHomepage(repository.homepage),
    image: await selectLatestRootImage(repository, tree),
  })));
  const generatedBlock = projects.map(({ repository, homepage, image }) => (
    buildProjectEntry(repository, homepage, image)
  )).join("\n");
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
  console.log(`Updated README with ${projects.length} latest projects.`);
}

main().catch((error) => {
  console.error(`Profile update failed: ${error.message}`);
  process.exitCode = 1;
});
