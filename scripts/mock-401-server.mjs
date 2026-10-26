// Local mock that returns 401 like an OpenAI-compatible endpoint, so the
// provider's auth-error hint can be tested without touching real endpoints.
import { createServer } from "node:http";

const server = createServer((req, res) => {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      error: {
        message: "Incorrect API key provided: sk-fake...",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    })
  );
});

const port = Number(process.argv[2] ?? 4123);
server.listen(port, "127.0.0.1", () => {
  console.log(`mock-401 listening on ${port}`);
  setTimeout(() => process.exit(0), 30000);
});
