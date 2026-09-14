#!/bin/sh
set -e
cd "$(dirname "$0")/.."
npx esbuild node_modules/gpt-tokenizer/esm/encoding/o200k_base.js --bundle --format=esm --minify --outfile=site/vendor/o200k.js
npx esbuild node_modules/gpt-tokenizer/esm/encoding/cl100k_base.js --bundle --format=esm --minify --outfile=site/vendor/cl100k.js
ls -la site/vendor
