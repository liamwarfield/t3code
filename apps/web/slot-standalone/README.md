# One-Armed Benchmark (standalone)

The composer's slot machine model picker on its own page, with every provider treated as installed so every pull pays out. Deployed as static assets on a Cloudflare Worker.

From `apps/web`:

```sh
./node_modules/.bin/vp build --config slot-standalone/vite.config.ts
cd slot-standalone && npx wrangler deploy
```
