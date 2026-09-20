import { expect, test } from "bun:test";
import { readJsonRequest, readJsonRequestBody, readRequestBodyBytes } from "../src/http-body";

test("decodes Codex zstd-compressed JSON request bodies", async () => {
  const body = { model: "chatgpt-web/pro", reasoning: { effort: "ultra" }, input: [{ role: "user", content: "hello" }] };
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(compressed.byteLength);
  new Uint8Array(encoded).set(compressed);
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: encoded,
  });

  expect(await readJsonRequestBody(request)).toEqual(body);
});

test("rejects unsupported request content encodings", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "br" },
    body: "{}",
  });

  await expect(readJsonRequestBody(request)).rejects.toThrow("Unsupported Content-Encoding: br");
});

test("stops reading when streamed bytes exceed the encoded limit", async () => {
  let cancelled = false;
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12"));
        controller.enqueue(new TextEncoder().encode("3456"));
      },
      cancel() { cancelled = true; },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await expect(readRequestBodyBytes(request, 5)).rejects.toThrow("Encoded request body exceeds 5 bytes");
  expect(cancelled).toBeTrue();
});

test("does not trust an understated Content-Length", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-length": "2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12"));
        controller.enqueue(new TextEncoder().encode("3456"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await expect(readRequestBodyBytes(request, 5)).rejects.toThrow("Encoded request body exceeds 5 bytes");
});

test("bounds zstd expansion before allocating the decoded body", async () => {
  const compressed = Bun.zstdCompressSync(Buffer.from(JSON.stringify({ value: "x".repeat(256) })));
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "zstd", "content-type": "application/json" },
    body: new Uint8Array(compressed).buffer,
  });

  await expect(readJsonRequest(request, { maxDecodedBytes: 32 }))
    .rejects.toThrow("Decoded request body exceeds 32 bytes");
});

test("rejects malformed zstd without attempting JSON parsing", async () => {
  const request = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-encoding": "zstd", "content-type": "application/json" },
    body: new Uint8Array([1, 2, 3, 4]).buffer,
  });

  await expect(readJsonRequestBody(request)).rejects.toThrow("Could not decode zstd request body");
});
