# server/

Node + Fastify API. Replaces `Talha Farm/electron/main.js` and `database.js`.

Porting rules, the endpoint map and the guard specification are in `CLAUDE.md`
in this directory.

```bash
npm install
npm run dev     # http://localhost:3000
npm test
```

`src/guard/` is security-critical. Changes need a second reviewer.
