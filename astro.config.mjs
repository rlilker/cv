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
  build: {
    format: 'directory',
    inlineStylesheets: 'auto',
  },
  devToolbar: {
    enabled: false,
  },
});
