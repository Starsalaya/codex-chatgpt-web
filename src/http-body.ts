import { zstdDecompressSync } from "node:zlib";

export const MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
export const MAX_DECODED_REQUEST_BYTES = 128 * 1024 * 1024;

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

export async function readRequestBodyBytes(
  request: Request,
  limit = MAX_ENCODED_REQUEST_BYTES,
): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new Error("Content-Length must be a non-negative integer");
    }
    assertWithinLimit(declaredLength, limit, "Encoded request body");
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel("request body limit exceeded").catch(() => {});
        throw new Error(`Encoded request body exceeds ${limit} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const encoded = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoded;
}

export async function readJsonRequest(
  request: Request,
  limits: { maxEncodedBytes?: number; maxDecodedBytes?: number } = {},
): Promise<{ encoded: Uint8Array; value: unknown }> {
  const maxEncodedBytes = limits.maxEncodedBytes ?? MAX_ENCODED_REQUEST_BYTES;
  const maxDecodedBytes = limits.maxDecodedBytes ?? MAX_DECODED_REQUEST_BYTES;
  const encoded = await readRequestBodyBytes(request, maxEncodedBytes);

  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let decoded: Uint8Array;
  if (contentEncoding === "" || contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    try {
      decoded = new Uint8Array(zstdDecompressSync(encoded, { maxOutputLength: maxDecodedBytes }));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      const message = error instanceof Error ? error.message : String(error);
      if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength|too large|larger than/i.test(message)) {
        throw new Error(`Decoded request body exceeds ${maxDecodedBytes} bytes`);
      }
      throw new Error(`Could not decode zstd request body: ${message}`);
    }
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  assertWithinLimit(decoded.byteLength, maxDecodedBytes, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  return { encoded, value: JSON.parse(text) as unknown };
}

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  return (await readJsonRequest(request)).value;
}
