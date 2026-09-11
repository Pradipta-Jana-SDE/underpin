/** @type {import('next').NextConfig} */
const nextConfig = {
  // The pipeline runs in the Node runtime and reaches for a real browser, the filesystem
  // and child processes. Bundling any of it breaks Playwright's binary resolution, so the
  // whole importer stack stays external and is required at runtime instead.
  serverExternalPackages: [
    'playwright',
    'cheerio',
    'fast-xml-parser',
    'pixelmatch',
    'pngjs',
    '@underpin/importer',
    '@underpin/templates',
    '@underpin/schema'
  ]
};

export default nextConfig;
