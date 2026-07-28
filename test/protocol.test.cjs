const assert = require("node:assert/strict");
const test = require("node:test");
const { encodeMessage, MessageReader } = require("../out/protocol.js");

test("frames messages by UTF-8 byte length", () => {
  const framed = encodeMessage({ text: "中文😀" });
  const boundary = framed.indexOf("\r\n\r\n");
  const header = framed.subarray(0, boundary).toString("ascii");
  const body = framed.subarray(boundary + 4);

  assert.equal(header, `Content-Length: ${body.byteLength}`);
  assert.deepEqual(JSON.parse(body.toString("utf8")), { text: "中文😀" });
});

test("reads fragmented and adjacent messages", async () => {
  const reader = new MessageReader();
  const messages = [];
  reader.on("message", (message) => messages.push(message));

  const bytes = Buffer.concat([
    encodeMessage({ id: 1, result: "你好" }),
    encodeMessage({ id: 2, result: null }),
  ]);
  reader.push(bytes.subarray(0, 7));
  reader.push(bytes.subarray(7, 31));
  reader.push(bytes.subarray(31));

  assert.deepEqual(messages, [
    { id: 1, result: "你好" },
    { id: 2, result: null },
  ]);
});
