import { once } from "node:events";
import { createServer } from "node:http";
import { type AddressInfo, createServer as createSocket } from "node:net";
import { describe, expect, it } from "vitest";

import { startServer } from "./listen.js";

/** Collects what the process would print and the code it would exit with. */
function recorder() {
  const lines: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  return {
    log: (line: string) => lines.push(line),
    error: (line: string) => errors.push(line),
    exit: (code: number) => exits.push(code),
    lines,
    errors,
    exits,
  };
}

describe("startServer", () => {
  it("names the port it bound and not the one it was given", async () => {
    // Port 0 is the case where the two differ.
    const io = recorder();
    const server = startServer(createServer(), 0, io);
    try {
      await once(server, "listening");
      const port = (server.address() as AddressInfo).port;
      expect(port).toBeGreaterThan(0);
      expect(io.lines).toEqual([`ogremcp platform listening on :${port}`]);
      expect(io.exits).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("ends the process when the port is taken, names it, and prints no start line", async () => {
    const taken = createSocket();
    await new Promise<void>((done) => {
      taken.listen(0, done);
    });
    const port = (taken.address() as AddressInfo).port;
    const io = recorder();
    const server = startServer(createServer(), port, io);
    try {
      await once(server, "error");
      expect(io.errors).toEqual([`cannot listen on port ${port}: it is already in use. Set PORT to a free port.`]);
      expect(io.exits).toEqual([1]);
      expect(io.lines).toEqual([]);
    } finally {
      server.close();
      taken.close();
    }
  });
});
