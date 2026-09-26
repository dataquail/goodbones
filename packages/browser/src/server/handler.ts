import type { IncomingMessage, ServerResponse } from "node:http";

import type { Source } from "./source.js";

// The routes the page reads, mounted under `/__goodbones/` by the bin's
// server and by the Vite plugin alike, so the page is the same in both:
//
//   atlas.json       the Architecture Browser's model
//   campaigns.json   the Campaign Browser's model
//   status.json      the repository's name and whether the feed is live
//   events           server-sent events: `changed` when the repository does
//
// A static export writes the first three as files and has no feed.

export const PREFIX = "/__goodbones/";

export type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

const HEARTBEAT_MS = 25_000;

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
};

const messageOf = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause
    ? String(cause.message)
    : String(cause);

export const makeHandler = (source: Source): Handler => {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(PREFIX)) return false;
    const route = url.pathname.slice(PREFIX.length);

    if (route === "events") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      response.setHeader("cache-control", "no-store");
      response.setHeader("connection", "keep-alive");
      response.write(`event: hello\ndata: ${JSON.stringify({ live: source.live })}\n\n`);
      const unsubscribe = source.subscribe((change) => {
        response.write(`event: changed\ndata: ${JSON.stringify(change)}\n\n`);
      });
      const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), HEARTBEAT_MS);
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return true;
    }

    if (route === "atlas.json" || route === "campaigns.json" || route === "status.json") {
      try {
        const collected = await source.current();
        if (route === "atlas.json") json(response, 200, collected.atlas);
        else if (route === "campaigns.json") json(response, 200, collected.campaigns);
        else {
          json(response, 200, {
            name: collected.atlas.name,
            generatedAt: collected.atlas.generatedAt,
            live: source.live,
          });
        }
      } catch (cause) {
        json(response, 500, { error: messageOf(cause) });
      }
      return true;
    }

    json(response, 404, { error: `no such route: ${url.pathname}` });
    return true;
  };
};
