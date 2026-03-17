import { env } from "./lib/env.js";
import { createApp } from "./app.js";

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`[loondry-backend] listening on http://localhost:${env.PORT}`);
});
