import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`velo api listening on :${port}`);
});
