// @ts-check
import { defineConfig } from 'astro/config';

// Fully static output. The build produces plain HTML/CSS/JS in `dist/`, which is
// synced straight to an S3 bucket and served through CloudFront.
//
// If dynamic content is ever needed, this is the switch to flip:
//   output: 'hybrid'  (or 'server') + an adapter, with S3 still serving statics
//   via CloudFront and the serverless function behind the same distribution.
export default defineConfig({
  site: 'https://ryanlilker.com',
  output: 'static',
  compressHTML: true,
  // 'file', not 'directory'. With 'directory' a page at
  // src/pages/family-assistant/index.astro is emitted as
  // family-assistant/index.html, and S3 stores it under that key.
  //
  // A request for /family-assistant/ then asks S3 for the key "family-assistant/",
  // which is a prefix, not an object. S3 answers 403, CloudFront's 403 rule
  // rewrites it to /index.html, and the visitor silently gets the CV homepage
  // on every project and legal page. The files are uploaded correctly; only
  // the URL resolution is wrong.
  //
  // 'file' emits family-assistant.html instead, so /family-assistant maps straight
  // at a real object and no CloudFront Function is needed to fix it up.
  build: {
    format: 'file',
    inlineStylesheets: 'auto',
  },
  // Keep URLs canonical with no trailing slash, matching the .html filenames.
  trailingSlash: 'never',
  devToolbar: {
    enabled: false,
  },
});
