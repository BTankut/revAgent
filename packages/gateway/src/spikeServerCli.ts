import { startTransportSpike } from "./transportSpike.js";

const portText = process.argv[2] ?? "0";
const port = Number.parseInt(portText, 10);
if (!Number.isInteger(port) || String(port) !== portText || port < 0 || port > 65_535) {
  throw new RangeError("usage: spike:server [port: 0..65535]");
}

const spike = await startTransportSpike({ port });
console.log(
  JSON.stringify({
    endpoint: spike.endpoint.toString(),
    pid: process.pid,
  }),
);

await new Promise<void>((resolve, reject) => {
  let closing = false;
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    void spike.close().then(resolve, reject);
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
});
